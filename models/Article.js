const mongoose = require('mongoose');

const articleSchema = new mongoose.Schema(
    {
        // ID artikel dari detik (misal "8513806"), dipakai untuk cek duplikat
        detikId: {
            type: String,
            required: true,
            unique: true,
            index: true
        },
        slug: {
            type: String,
            required: true
        },
        url: {
            type: String,
            required: true,
            unique: true
        },

        // Title
        originalTitle: {
            type: String,
            required: true
        },
        title: {
            type: String,
            required: true
        },

        // Content
        originalContent: {
            type: String,
            required: true
        },
        content: {
            type: String,
            required: true
        },

        // Metadata
        image: String,
        caption: String,
        author: String,
        source: String,
        date: String,
        tags: [String],

        // Jumlah "dibaca" — bertambah tiap kali halaman detail dibuka
        views: {
            type: Number,
            default: 0
        },

        publishedText: String,
        publishedAt: String,
        unixTime: String
    },
    {
        timestamps: true // otomatis nambah createdAt & updatedAt
    }
);

// Urut berdasarkan artikel terbaru masuk ke DB
articleSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Article', articleSchema);
