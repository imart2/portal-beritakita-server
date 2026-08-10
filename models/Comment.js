const mongoose = require('mongoose');

const commentSchema = new mongoose.Schema(
    {
        // Referensi ke artikel (pakai detikId, bukan ObjectId Mongo,
        // supaya konsisten dengan cara frontend mengacu ke artikel)
        articleId: {
            type: String,
            required: true,
            index: true
        },
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 60
        },
        content: {
            type: String,
            required: true,
            trim: true,
            maxlength: 1000
        },
        status: {
            type: String,
            enum: ['pending', 'approved', 'rejected'],
            default: 'pending',
            index: true
        },
        // Disimpan untuk keperluan rate-limit sederhana (bukan ditampilkan ke publik)
        ip: {
            type: String,
            select: false
        }
    },
    {
        timestamps: true
    }
);

module.exports = mongoose.model('Comment', commentSchema);
