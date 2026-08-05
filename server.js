// File ini HANYA dipakai untuk menjalankan server secara lokal
// (misal: npm start / node server.js di komputer anda).
// Saat deploy ke Vercel, yang dipakai adalah api/index.js — Vercel tidak
// menjalankan file ini sama sekali, karena Vercel bekerja sebagai
// serverless function, bukan long-running server dengan app.listen().

const app = require('./app');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server (local) running on port ${PORT}`);
});
