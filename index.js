// index.js (di dalam folder functions)

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

/**
 * Membuat tiket/permintaan deposit manual.
 * Dipanggil oleh pengguna dari halaman toko (index.html).
 */
exports.requestManualDeposit = functions.https.onCall(async (data, context) => {
    // 1. Pastikan pengguna sudah login
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Anda harus login untuk membuat deposit.');
    }

    const userId = context.auth.uid;
    const amount = parseInt(data.amount);

    // 2. Validasi jumlah minimal deposit
    if (!amount || amount < 10000) {
        throw new functions.https.HttpsError('invalid-argument', 'Jumlah deposit minimal adalah Rp 10.000.');
    }

    const depositId = `DEP-${Date.now()}`;

    // 3. Simpan permintaan deposit ke Firestore dengan status 'Menunggu Pembayaran'
    await db.collection('deposits').doc(depositId).set({
        id: depositId,
        userId: userId,
        userEmail: context.auth.token.email,
        amount: amount,
        status: 'Menunggu Pembayaran', // Pengguna harus transfer & upload bukti
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        bukti_pembayaran: null
    });

    return { success: true, message: 'Tiket deposit berhasil dibuat.', depositId: depositId };
});


/**
 * Mengkonfirmasi deposit dan menambah saldo pengguna.
 * PENTING: Fungsi ini HANYA BOLEH dipanggil dari Halaman Admin Anda.
 */
exports.confirmManualDeposit = functions.https.onCall(async (data, context) => {
    // 4. Verifikasi apakah yang memanggil adalah admin (tambahkan email Anda)
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Hanya admin yang bisa mengakses fungsi ini.');
    }
    const adminEmails = ['emailadmin@contoh.com', 'emailanda@gmail.com']; // <-- GANTI DENGAN EMAIL ADMIN ANDA
    if (!adminEmails.includes(context.auth.token.email)) {
         throw new functions.https.HttpsError('permission-denied', 'Anda bukan admin.');
    }

    const { depositId } = data;
    if (!depositId) {
        throw new functions.https.HttpsError('invalid-argument', 'ID Deposit wajib diisi.');
    }

    const depositRef = db.collection('deposits').doc(depositId);

    try {
        // 5. Jalankan transaksi yang aman
        return await db.runTransaction(async (t) => {
            const depositDoc = await t.get(depositRef);
            if (!depositDoc.exists) throw new functions.https.HttpsError('not-found', 'Deposit tidak ditemukan.');
            
            const depositData = depositDoc.data();
            if (depositData.status !== 'Menunggu Konfirmasi') {
                throw new functions.https.HttpsError('failed-precondition', `Deposit ini sudah diproses atau belum ada bukti. Status: ${depositData.status}`);
            }

            const userId = depositData.userId;
            const amount = depositData.amount;
            const userWalletRef = db.collection('wallets').doc(userId);

            const walletDoc = await t.get(userWalletRef);
            let newBalance = amount;
            if (walletDoc.exists) {
                newBalance += (walletDoc.data().balance || 0);
            }

            // 6. Update saldo pengguna dan status deposit
            t.set(userWalletRef, { balance: newBalance, lastUpdated: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            t.update(depositRef, { status: 'Selesai', confirmedBy: context.auth.token.email });

            return { success: true, message: `Saldo untuk ${depositData.userEmail} berhasil ditambah sebesar Rp ${amount}.` };
        });
    } catch (error) {
        console.error("Gagal konfirmasi deposit:", error);
        throw error;
    }
});


/**
 * Memproses pembelian produk menggunakan saldo wallet.
 */
exports.purchaseWithBalance = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Anda harus login.');
    
    const userId = context.auth.uid;
    const { productId, nomorTujuan } = data;
    if (!productId || !nomorTujuan) throw new functions.https.HttpsError('invalid-argument', 'Data tidak lengkap.');

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
                nomor_pelanggan: nomorTujuan, // Menggunakan nama field yang konsisten
                harga: productPrice,
                status: 'Diproses', // Langsung diproses karena sudah bayar
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
