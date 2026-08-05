const mongoose = require('mongoose');

// Di lingkungan serverless (Vercel), function bisa dipanggil berkali-kali
// dan tiap invocation baru berpotensi bikin koneksi MongoDB baru kalau tidak
// di-cache. Simpan koneksi di variable global supaya dipakai ulang selama
// instance function masih "warm".
let cached = global._mongooseConn;

if (!cached) {
    cached = global._mongooseConn = { conn: null, promise: null };
}

async function connectDB() {
    if (cached.conn) {
        return cached.conn;
    }

    const uri = process.env.MONGODB_URI;

    if (!uri) {
        throw new Error('MONGODB_URI belum di-set di environment variables');
    }

    if (!cached.promise) {
        cached.promise = mongoose
            .connect(uri, {
                bufferCommands: false
            })
            .then((mongooseInstance) => {
                console.log('MongoDB connected');
                return mongooseInstance;
            });
    }

    try {
        cached.conn = await cached.promise;
    } catch (err) {
        cached.promise = null;
        throw err;
    }

    return cached.conn;
}

module.exports = connectDB;
