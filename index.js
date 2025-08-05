// index.js (di dalam folder functions)

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

/**
 * Membuat tiket/permintaan deposit manual.
 * Dipanggil oleh pengguna dari halaman toko.
 */
exports.requestManualDeposit = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Anda harus login untuk membuat deposit.');
    }

    const userId = context.auth.uid;
    const amount = parseInt(data.amount);

    if (!amount || amount < 10000) {
        throw new functions.https.HttpsError('invalid-argument', 'Jumlah deposit minimal adalah Rp 10.000.');
    }

    const depositId = `DEP-${Date.now()}`;

    // Simpan permintaan deposit ke Firestore
    await db.collection('deposits').doc(depositId).set({
        id: depositId,
        userId: userId,
        userEmail: context.auth.token.email,
        amount: amount,
        status: 'Menunggu Pembayaran',
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        bukti_pembayaran: null
    });

    return { success: true, message: 'Tiket deposit berhasil dibuat.', depositId: depositId };
});


/**
 * Mengkonfirmasi deposit dan menambah saldo pengguna.
 * PENTING: Fungsi ini HANYA BOLEH dipanggil dari Halaman Admin Anda yang aman.
 * Anda perlu menambahkan verifikasi apakah yang memanggil adalah admin.
 */
exports.confirmManualDeposit = functions.https.onCall(async (data, context) => {
    // Verifikasi sederhana, di production Anda harus punya sistem role admin yang lebih baik
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Hanya admin yang bisa mengakses fungsi ini.');
    }
    // Anda bisa menambahkan pengecekan email admin di sini
    const adminEmails = ['emailadmin1@gmail.com', 'emailanda@gmail.com'];
    if (!adminEmails.includes(context.auth.token.email)) {
         throw new functions.https.HttpsError('permission-denied', 'Anda bukan admin.');
    }

    const { depositId } = data;
    if (!depositId) {
        throw new functions.https.HttpsError('invalid-argument', 'ID Deposit wajib diisi.');
    }

    const depositRef = db.collection('deposits').doc(depositId);

    try {
        return await db.runTransaction(async (t) => {
            const depositDoc = await t.get(depositRef);

            if (!depositDoc.exists) {
                throw new functions.https.HttpsError('not-found', 'Deposit tidak ditemukan.');
            }
            const depositData = depositDoc.data();

            if (depositData.status !== 'Menunggu Konfirmasi') { // Atau status setelah upload bukti
                throw new functions.https.HttpsError('failed-precondition', `Deposit ini sudah diproses atau belum upload bukti. Status saat ini: ${depositData.status}`);
            }

            const userId = depositData.userId;
            const amount = depositData.amount;
            const userWalletRef = db.collection('wallets').doc(userId);

            const walletDoc = await t.get(userWalletRef);
            let newBalance = amount;
            if (walletDoc.exists) {
                newBalance += (walletDoc.data().balance || 0);
            }

            // 1. Update saldo pengguna
            t.set(userWalletRef, { balance: newBalance, lastUpdated: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            
            // 2. Update status deposit menjadi 'Selesai'
            t.update(depositRef, { status: 'Selesai', confirmedBy: context.auth.token.email });

            return { success: true, message: `Saldo untuk ${depositData.userEmail} berhasil ditambah sebesar Rp ${amount}.` };
        });
    } catch (error) {
        console.error("Gagal konfirmasi deposit:", error);
        // Melempar kembali error agar bisa ditangkap di sisi client (admin panel)
        throw error;
    }
});


/**
 * Memproses pembelian produk menggunakan saldo wallet.
 * (Fungsi ini sama seperti sebelumnya, tidak ada perubahan)
 */
exports.purchaseWithBalance = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Anda harus login.');
    }
    const userId = context.auth.uid;
    const { productId, nomorTujuan } = data;
    if (!productId || !nomorTujuan) {
        throw new functions.https.HttpsError('invalid-argument', 'Informasi produk dan nomor tujuan wajib diisi.');
    }

    const productRef = db.collection('produk').doc(productId);
    const walletRef = db.collection('wallets').doc(userId);
    const orderId = `ORD-${Date.now()}`;

    try {
        await db.runTransaction(async (t) => {
            const productDoc = await t.get(productRef);
            const walletDoc = await t.get(walletRef);

            if (!productDoc.exists) throw new functions.https.HttpsError('not-found', 'Produk tidak ditemukan.');
            
            const productData = productDoc.data();
            const productPrice = productData.harga_reseller || productData.harga_umum;

            if (!walletDoc.exists || (walletDoc.data().balance || 0) < productPrice) {
                throw new functions.https.HttpsError('failed-precondition', 'Saldo Anda tidak mencukupi.');
            }
            
            const currentBalance = walletDoc.data().balance;
            const newBalance = currentBalance - productPrice;
            t.update(walletRef, { balance: newBalance });

            const orderData = {
                id: orderId, userId, productId,
                nama_produk: productData.nama_produk,
                nomor_tujuan: nomorTujuan, harga: productPrice,
                status: 'Diproses', // Langsung diproses karena sudah bayar pakai saldo
                jenis_produk: productData.jenis_produk || 'manual',
                waktu: admin.firestore.FieldValue.serverTimestamp()
            };
            const orderRef = db.collection('pesananUmum').doc(orderId);
            t.set(orderRef, orderData);
        });
        return { success: true, message: 'Pembelian berhasil! Pesanan sedang diproses.', orderId };
    } catch (error) {
        console.error("Purchase Error:", error);
        throw error;
    }
});
