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
    console.log("Function 'requestManualDeposit' triggered.");

    // 1. Pastikan pengguna sudah login
    if (!context.auth) {
        console.error("Authentication check failed: User is not authenticated.");
        throw new functions.https.HttpsError('unauthenticated', 'Anda harus login untuk membuat deposit.');
    }
    console.log(`User authenticated with UID: ${context.auth.uid}`);

    try {
        const userId = context.auth.uid;
        const amount = parseInt(data.amount);

        console.log(`Received amount: ${data.amount}, Parsed amount: ${amount}`);

        // 2. Validasi jumlah minimal deposit
        if (isNaN(amount) || amount < 10000) {
            console.error(`Validation failed: Invalid amount received (${amount}).`);
            throw new functions.https.HttpsError('invalid-argument', 'Jumlah deposit minimal adalah Rp 10.000.');
        }

        const depositId = `DEP-${Date.now()}`;
        console.log(`Generated Deposit ID: ${depositId}`);

        // PERBAIKAN: Menangani kasus jika pengguna tidak memiliki email, gunakan UID sebagai fallback.
        const userEmail = context.auth.token.email || `uid:${userId}`;
        console.log(`User email identified as: ${userEmail}`);

        const depositData = {
            id: depositId,
            userId: userId,
            userEmail: userEmail,
            amount: amount,
            status: 'Menunggu Pembayaran',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            bukti_pembayaran: null
        };

        // 3. Simpan permintaan deposit ke Firestore
        console.log("Attempting to write to Firestore with data:", depositData);
        await db.collection('deposits').doc(depositId).set(depositData);
        console.log("Successfully wrote to Firestore.");

        return { success: true, message: 'Tiket deposit berhasil dibuat.', depositId: depositId };

    } catch (error) {
        console.error("CRITICAL ERROR in requestManualDeposit:", error);
        // Jika ini adalah error yang sudah kita definisikan, lempar kembali.
        if (error instanceof functions.https.HttpsError) {
            throw error;
        } else {
            // Jika tidak, ini adalah error tak terduga. Catat dan lempar sebagai 'internal'.
            throw new functions.https.HttpsError('internal', 'Terjadi kesalahan tak terduga di server.');
        }
    }
});


/**
 * Mengkonfirmasi deposit dan menambah saldo pengguna.
 * PENTING: Fungsi ini HANYA BOLEH dipanggil dari Halaman Admin Anda.
 */
exports.confirmManualDeposit = functions.https.onCall(async (data, context) => {
    // Verifikasi apakah yang memanggil adalah admin (dan punya email)
    if (!context.auth || !context.auth.token.email) {
        throw new functions.https.HttpsError('unauthenticated', 'Hanya admin dengan email yang bisa mengakses fungsi ini.');
    }
    
    // --> GANTI DENGAN EMAIL ADMIN ANDA <--
    const adminEmails = ['emailadmin@contoh.com', 'asdarcell@gmail.com']; 
    const adminEmail = context.auth.token.email;

    if (!adminEmails.includes(adminEmail)) {
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
            if (!depositDoc.exists) throw new functions.https.HttpsError('not-found', 'Deposit tidak ditemukan.');
            
            const depositData = depositDoc.data();
            if (depositData.status !== 'Menunggu Konfirmasi') {
                throw new functions.https.HttpsError('failed-precondition', `Status deposit ini bukan 'Menunggu Konfirmasi'.`);
            }

            const userId = depositData.userId;
            const amount = depositData.amount;
            const userWalletRef = db.collection('wallets').doc(userId);

            const walletDoc = await t.get(userWalletRef);
            let newBalance = amount + (walletDoc.exists ? (walletDoc.data().balance || 0) : 0);

            t.set(userWalletRef, { balance: newBalance, lastUpdated: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            t.update(depositRef, { status: 'Selesai', confirmedBy: adminEmail });

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
                nomor_pelanggan: nomorTujuan,
                harga: productPrice,
                status: 'Diproses',
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
