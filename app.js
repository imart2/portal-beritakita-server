const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

require('dotenv').config();

const connectDB = require('./lib/db');
const Article = require('./models/Article');

const Groq = require("groq-sdk");

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

const app = express();

// Izinkan frontend di domain manapun untuk GET data (endpoint publik, read-only).
// Kalau nanti mau dibatasi ke domain frontend tertentu saja, ganti origin: '*'
// jadi origin: 'https://domain-frontend-anda.com'
app.use(cors({
    origin: '*',
    methods: ['GET']
}));

// Pastikan koneksi MongoDB siap sebelum route diproses.
// connectDB() sendiri sudah di-cache, jadi request berikutnya
// (di instance function yang sama) tidak connect ulang.
app.use(async (req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (err) {
        console.error('DB connection error:', err);
        res.status(500).json({
            success: false,
            message: 'Gagal terhubung ke database'
        });
    }
});


// =====================================
// AI REWRITE (GROQ)
// =====================================

// REWRITE TITLE WITH AI FROM GROQ
async function rewriteTitle(title) {
    try {
        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            temperature: 0.7,
            messages: [
                {
                    role: "system",
                    content: `
                Anda adalah editor berita profesional Indonesia.

                Tugas:
                - Rewrite judul berita.
                - Jangan mengubah fakta.
                - Jangan clickbait.
                - Maksimal 12 kata.
                - Gunakan bahasa Indonesia yang natural.
                - Kembalikan HANYA judul baru.
`
                },
                {
                    role: "user",
                    content: title
                }
            ]
        });

        return completion.choices[0].message.content.trim();

    } catch (err) {
        console.error(err);
        return title;
    }
}

// REWRITE ARTICLE WITH AI FROM GROQ
async function rewriteArticle(title, content) {
    try {
        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            temperature: 0.4,
            messages: [
                {
                    role: "system",
                    content: `
                    Anda adalah editor senior media berita Indonesia.

                    Tugas Anda adalah menulis ulang artikel berita.

                    PERATURAN:

                    - Jangan mengubah fakta.
                    - Jangan menambah informasi baru.
                    - Jangan menghapus informasi penting.
                    - Gunakan gaya bahasa profesional seperti Detik, CNN Indonesia, Kompas, Tempo.
                    - Artikel harus terasa ditulis manusia.
                    - Hindari bahasa AI.
                    - Hindari clickbait.
                    - Hindari opini.
                    - Susun ulang seluruh kalimat.
                    - Susun ulang struktur paragraf.
                    - Gunakan transisi yang natural.
                    - Ringkas menjadi sekitar 70-80% dari artikel asli.
                    - Tetap mempertahankan kronologi berita.
                    - Output HANYA isi artikel.
`
                },
                {
                    role: "user",
                    content: `
                    Judul:
                    ${title}

                    Isi:
                    ${content}
                    `
                }
            ]
        });

        return completion.choices[0].message.content.trim();

    } catch (err) {
        console.error(err);
        return content;
    }
}


// =====================================
// SCRAPER HELPERS (internal, tidak langsung jadi route)
// =====================================

// Ambil daftar artikel dari halaman indeks (tanpa rewrite, tanpa simpan)
async function scrapeDetikList(page = 1) {
    const url = `https://news.detik.com/indeks?page=${page}`;

    const { data } = await axios.get(url, {
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
            Referer: 'https://news.detik.com/'
        },
        timeout: 30000
    });

    const $ = cheerio.load(data);
    const articles = [];

    $('#indeks-container article.list-content__item').each((_, element) => {
        const item = $(element);
        const titleElement = item.find('.media__title a');
        const title = titleElement.text().trim();
        const articleUrl = titleElement.attr('href') || '';

        if (!title || !articleUrl) return;

        const blockedDomains = ['20.detik.com'];
        if (blockedDomains.some(domain => articleUrl.includes(domain))) return;

        let detikId = '';
        let slug = '';

        try {
            const pathname = new URL(articleUrl).pathname;
            const segments = pathname.split('/').filter(Boolean);

            // /berita/d-8513806/judul-artikel
            detikId = segments[1] || '';
            slug = segments[2] || '';
        } catch {
            return;
        }

        const image =
            item.find('.media__image img').attr('src') || '';

        const dateElement = item.find('.media__date span');

        articles.push({
            title,
            detikId,
            slug,
            url: articleUrl,
            image,
            publishedText: dateElement.text().trim(),
            publishedAt: dateElement.attr('title') || '',
            unixTime: dateElement.attr('d-time') || ''
        });
    });

    const uniqueArticles = [
        ...new Map(articles.map(item => [item.url, item])).values()
    ];

    return uniqueArticles;
}

// Ambil detail 1 artikel (tanpa rewrite, tanpa simpan)
async function scrapeDetikDetail(detikId, slug) {
    const articleUrl = `https://news.detik.com/berita/${detikId}/${slug}`;

    const { data } = await axios.get(articleUrl, {
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
            Referer: 'https://news.detik.com/'
        },
        timeout: 30000
    });

    const $ = cheerio.load(data);

    $('.noncontent, .lihatjg, script, style').remove();

    const title = $('.detail__title').first().text().trim();

    const author = $('.detail__author')
        .clone()
        .find('.detail__label')
        .remove()
        .end()
        .text()
        .replace(/\s*-\s*$/, '')
        .trim();

    const source = $('.detail__label').first().text().trim();
    const date = $('.detail__date').first().text().trim();

    const image =
        $('.detail__media img').first().attr('src') ||
        $('.detail__media img').first().attr('data-src') ||
        '';

    const caption = $('.detail__media-caption').first().text().trim();

    const paragraphs = [];

    $('.detail__body-text p').each((_, p) => {
        const text = $(p)
            .text()
            .replace(/\s+/g, ' ')
            .trim();

        if (text && text.length > 3) {
            paragraphs.push(text);
        }
    });

    const tags = [];

    $('.detail__body-tag .nav__item').each((_, el) => {
        const tag = $(el).text().trim();

        if (tag) {
            tags.push(tag);
        }
    });

    return {
        title,
        author,
        source,
        date,
        image,
        caption,
        content: paragraphs.join('\n\n'),
        tags,
        url: articleUrl
    };
}


// =====================================
// MIDDLEWARE: PROTEKSI CRON
// =====================================

function checkCronSecret(req, res, next) {
    const secret = process.env.CRON_SECRET;

    if (!secret) {
        return res.status(500).json({
            success: false,
            message: 'CRON_SECRET belum di-set di server'
        });
    }

    const provided = req.headers['x-cron-secret'] || req.query.key;

    if (provided !== secret) {
        return res.status(401).json({
            success: false,
            message: 'Unauthorized'
        });
    }

    next();
}


// =====================================
// ENDPOINT CRON: SCRAPE + REWRITE + SIMPAN
// =====================================

app.get('/api/cron/scrape-detik', checkCronSecret, async (req, res) => {
    try {
        const page = Number(req.query.page) || 1;

        const listArticles = await scrapeDetikList(page);

        if (listArticles.length === 0) {
            return res.json({
                success: true,
                message: 'Tidak ada artikel ditemukan di halaman indeks',
                data: null
            });
        }

        // Ambil 1 artikel terbaru (paling atas)
        const latest = listArticles[0];

        if (!latest.detikId || !latest.slug) {
            return res.status(500).json({
                success: false,
                message: 'Gagal parsing id/slug dari artikel terbaru'
            });
        }

        // Cek duplikat: skip kalau sudah ada di DB
        const existing = await Article.findOne({ detikId: latest.detikId });

        if (existing) {
            return res.json({
                success: true,
                message: 'Artikel terbaru sudah ada di database, tidak ada yang disimpan',
                data: null
            });
        }

        // Scrape detail
        const detail = await scrapeDetikDetail(latest.detikId, latest.slug);

        if (!detail.title || !detail.content) {
            return res.status(500).json({
                success: false,
                message: 'Gagal scrape detail artikel (title/content kosong)'
            });
        }

        // Rewrite dengan AI (title & content diproses paralel untuk mempercepat,
        // penting di Vercel karena ada batas waktu eksekusi function)
        const [rewrittenTitle, rewrittenContent] = await Promise.all([
            rewriteTitle(detail.title),
            rewriteArticle(detail.title, detail.content)
        ]);

        // Simpan ke MongoDB
        const savedArticle = await Article.create({
            detikId: latest.detikId,
            slug: latest.slug,
            url: detail.url,

            originalTitle: detail.title,
            title: rewrittenTitle,

            originalContent: detail.content,
            content: rewrittenContent,

            image: detail.image || latest.image,
            caption: detail.caption,
            author: detail.author,
            source: detail.source,
            date: detail.date,
            tags: detail.tags,

            publishedText: latest.publishedText,
            publishedAt: latest.publishedAt,
            unixTime: latest.unixTime
        });

        return res.json({
            success: true,
            message: 'Artikel baru berhasil di-scrape, di-rewrite, dan disimpan',
            data: savedArticle
        });
    } catch (error) {
        console.error(error);

        // Race condition: kalau ada 2 trigger cron nyaris bersamaan,
        // unique index di MongoDB bisa nolak insert duplikat (error code 11000)
        if (error.code === 11000) {
            return res.json({
                success: true,
                message: 'Artikel sudah tersimpan (duplikat terdeteksi saat insert)',
                data: null
            });
        }

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


// =====================================
// ENDPOINT FRONTEND: LIST ARTIKEL (DARI MONGODB)
// =====================================

app.get('/api/articles', async (req, res) => {
    try {
        const page = Math.max(Number(req.query.page) || 1, 1);
        const limit = Math.min(Number(req.query.limit) || 10, 50);
        const skip = (page - 1) * limit;

        const [articles, total] = await Promise.all([
            Article.find({})
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .select('-originalTitle -originalContent -__v'),
            Article.countDocuments({})
        ]);

        return res.json({
            success: true,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            data: articles
        });
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});


// =====================================
// ENDPOINT FRONTEND: DETAIL ARTIKEL (DARI MONGODB)
// =====================================

app.get('/api/articles/:detikId', async (req, res) => {
    try {
        const { detikId } = req.params;

        const article = await Article.findOne({ detikId }).select('-__v');

        if (!article) {
            return res.status(404).json({
                success: false,
                message: 'Artikel tidak ditemukan'
            });
        }

        return res.json({
            success: true,
            data: article
        });
    } catch (error) {
        console.error(error);

        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

module.exports = app;
