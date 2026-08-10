const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

require('dotenv').config();

const connectDB = require('./lib/db');
const Article = require('./models/Article');
const Comment = require('./models/Comment');

const Groq = require("groq-sdk");

const groq = new Groq({
    apiKey: process.env.GROQ_API_KEY
});

const app = express();

// URL frontend (bukan URL backend/API ini) — dipakai untuk membangun link
// artikel di RSS feed & sitemap.xml. WAJIB di-set di Environment Variables
// Vercel setelah frontend anda live, misal: https://sinyal-anda.vercel.app
const FRONTEND_URL = (process.env.FRONTEND_URL || '').replace(/\/$/, '');

function escapeXml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function articleDetailUrl(article) {
    // Kalau FRONTEND_URL belum di-set, fallback ke placeholder supaya tetap
    // menghasilkan XML yang valid (bukan crash), tapi linknya tidak akan berfungsi.
    const base = FRONTEND_URL || 'https://ganti-dengan-domain-frontend-anda.com';
    return `${base}/detail.html?id=${encodeURIComponent(article.detikId)}`;
}

// Izinkan frontend di domain manapun untuk GET data (endpoint publik, read-only).
// Kalau nanti mau dibatasi ke domain frontend tertentu saja, ganti origin: '*'
// jadi origin: 'https://domain-frontend-anda.com'
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST']
}));
app.use(express.json());

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

// Daftar kategori yang boleh dipilih AI — disesuaikan dengan cakupan asli
// news.detik.com/indeks (bukan daftar generik)
const ARTICLE_CATEGORIES = [
    'Politik',
    'Hukum & Kriminal',
    'Peristiwa',
    'Internasional',
    'Ekonomi',
    'Sosial & Budaya',
    'Lainnya'
];

// Buang markdown code fence (```json ... ```) kalau model membungkusnya,
// lalu coba parse sebagai JSON. Return null kalau gagal (bukan JSON valid).
function parseJsonSafely(raw) {
    try {
        const cleaned = raw.replace(/^```json\s*|^```\s*|```\s*$/gim, '').trim();
        return JSON.parse(cleaned);
    } catch {
        return null;
    }
}

// REWRITE ARTIKEL + KLASIFIKASI KATEGORI SEKALIGUS (1 pemanggilan Groq saja,
// bukan 2 — supaya tidak menambah pemakaian token untuk fitur kategori ini)
async function rewriteArticleWithCategory(title, content) {
    try {
        const completion = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant",
            temperature: 0.4,
            messages: [
                {
                    role: "system",
                    content: `
                    Anda adalah editor senior media berita Indonesia.

                    Tugas Anda ADA DUA:
                    1. Menulis ulang artikel berita.
                    2. Menentukan SATU kategori paling sesuai untuk artikel ini.

                    PERATURAN PENULISAN ULANG:
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
                    - Isi artikel dalam teks biasa (bukan markdown), antar paragraf dipisah baris baru ganda (\\n\\n).

                    PERATURAN KATEGORI:
                    - Pilih TEPAT SATU dari daftar berikut, tulis PERSIS seperti tertulis (termasuk huruf besar/kecil dan tanda "&"):
                      ${ARTICLE_CATEGORIES.join(', ')}
                    - Kalau tidak yakin atau tidak cocok kategori manapun, pilih "Lainnya".

                    FORMAT OUTPUT — WAJIB DIIKUTI:
                    Kembalikan HANYA satu objek JSON valid, TANPA teks lain, TANPA markdown code fence, persis format berikut:
                    {"content": "isi artikel hasil rewrite di sini", "category": "salah satu dari daftar kategori"}
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

        const raw = completion.choices[0].message.content.trim();
        const parsed = parseJsonSafely(raw);

        if (parsed && typeof parsed.content === 'string' && parsed.content.trim()) {
            const category = ARTICLE_CATEGORIES.includes(parsed.category) ? parsed.category : 'Lainnya';
            return { content: parsed.content.trim(), category };
        }

        // Fallback: model tidak mengikuti format JSON — anggap seluruh
        // respons adalah isi artikel apa adanya, kategori default "Lainnya"
        console.warn('Respons rewrite bukan JSON valid, pakai fallback.');
        return { content: raw, category: 'Lainnya' };

    } catch (err) {
        console.error(err);
        return { content, category: 'Lainnya' };
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
// Menerima URL ASLI hasil scrape list (bukan direkonstruksi manual), karena
// path artikel detik.com bisa beda-beda tergantung kanal (/berita/, /x/, dll)
async function scrapeDetikDetail(articleUrl) {
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
// MIDDLEWARE: PROTEKSI MODERASI KOMENTAR
// =====================================

function checkAdminSecret(req, res, next) {
    const secret = process.env.ADMIN_SECRET;

    if (!secret) {
        return res.status(500).json({
            success: false,
            message: 'ADMIN_SECRET belum di-set di server'
        });
    }

    const provided = req.headers['x-admin-secret'] || req.query.key;

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

        // Scrape detail — pakai URL asli hasil scrape list
        const detail = await scrapeDetikDetail(latest.url);

        if (!detail.title || !detail.content) {
            return res.status(500).json({
                success: false,
                message: 'Gagal scrape detail artikel (title/content kosong)'
            });
        }

        // Rewrite dengan AI (title & content+kategori diproses paralel untuk
        // mempercepat, penting di Vercel karena ada batas waktu eksekusi function)
        const [rewrittenTitle, rewriteResult] = await Promise.all([
            rewriteTitle(detail.title),
            rewriteArticleWithCategory(detail.title, detail.content)
        ]);

        // Simpan ke MongoDB
        const savedArticle = await Article.create({
            detikId: latest.detikId,
            slug: latest.slug,
            url: detail.url,

            originalTitle: detail.title,
            title: rewrittenTitle,

            originalContent: detail.content,
            content: rewriteResult.content,
            category: rewriteResult.category,

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

        // ----- Filter: pencarian teks bebas -----
        const query = {};
        const searchTerm = (req.query.search || req.query.q || '').trim();
        if (searchTerm) {
            const regex = new RegExp(
                searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), // escape karakter regex spesial
                'i'
            );
            query.$or = [{ title: regex }, { content: regex }, { tags: regex }];
        }

        // ----- Filter: sumber berita -----
        const source = (req.query.source || '').trim();
        if (source) {
            query.source = new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        }

        // ----- Filter: kategori -----
        const category = (req.query.category || '').trim();
        if (category) {
            query.category = category;
        }

        // ----- Sort -----
        const sortMap = {
            newest: { createdAt: -1 },
            oldest: { createdAt: 1 },
            most_viewed: { views: -1 }
        };
        const sortParam = (req.query.sort || 'newest').trim();
        const sortBy = sortMap[sortParam] || sortMap.newest;

        const [articles, total] = await Promise.all([
            Article.find(query)
                .sort(sortBy)
                .skip(skip)
                .limit(limit)
                .select('-originalTitle -originalContent -__v'),
            Article.countDocuments(query)
        ]);

        return res.json({
            success: true,
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            search: searchTerm || null,
            source: source || null,
            category: category || null,
            sort: sortParam,
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


// =====================================
// ENDPOINT: INCREMENT JUMLAH DIBACA
// =====================================
// Dipanggil frontend sekali tiap kali halaman detail artikel dibuka.
// Pakai $inc supaya atomic (aman walau ada banyak pembaca bersamaan).

app.post('/api/articles/:detikId/view', async (req, res) => {
    try {
        const { detikId } = req.params;

        const article = await Article.findOneAndUpdate(
            { detikId },
            { $inc: { views: 1 } },
            { new: true, select: 'detikId views' }
        );

        if (!article) {
            return res.status(404).json({
                success: false,
                message: 'Artikel tidak ditemukan'
            });
        }

        return res.json({
            success: true,
            data: { detikId: article.detikId, views: article.views }
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
// KOMENTAR — PUBLIK
// =====================================

// Ambil komentar yang SUDAH disetujui untuk 1 artikel
app.get('/api/articles/:detikId/comments', async (req, res) => {
    try {
        const { detikId } = req.params;

        const comments = await Comment.find({ articleId: detikId, status: 'approved' })
            .sort({ createdAt: -1 })
            .select('name content createdAt');

        return res.json({
            success: true,
            total: comments.length,
            data: comments
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// Kirim komentar baru — otomatis berstatus "pending", tidak langsung tampil
app.post('/api/articles/:detikId/comments', async (req, res) => {
    try {
        const { detikId } = req.params;
        const { name, content, website } = req.body || {};

        // Honeypot: field "website" seharusnya kosong. Kalau terisi, hampir
        // pasti itu bot (manusia tidak melihat field ini di form).
        if (website) {
            // Pura-pura sukses supaya bot tidak tahu ditolak, tapi tidak disimpan
            return res.json({ success: true, message: 'Komentar terkirim, menunggu moderasi.' });
        }

        const trimmedName = (name || '').toString().trim();
        const trimmedContent = (content || '').toString().trim();

        if (!trimmedName || !trimmedContent) {
            return res.status(400).json({ success: false, message: 'Nama dan komentar wajib diisi.' });
        }
        if (trimmedName.length > 60) {
            return res.status(400).json({ success: false, message: 'Nama terlalu panjang (maksimal 60 karakter).' });
        }
        if (trimmedContent.length < 3) {
            return res.status(400).json({ success: false, message: 'Komentar terlalu pendek.' });
        }
        if (trimmedContent.length > 1000) {
            return res.status(400).json({ success: false, message: 'Komentar terlalu panjang (maksimal 1000 karakter).' });
        }

        const article = await Article.findOne({ detikId }).select('detikId');
        if (!article) {
            return res.status(404).json({ success: false, message: 'Artikel tidak ditemukan.' });
        }

        // Rate limit sederhana: 1 komentar per 30 detik dari IP yang sama
        const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
        if (ip) {
            const recentComment = await Comment.findOne({
                ip,
                createdAt: { $gte: new Date(Date.now() - 30 * 1000) }
            });
            if (recentComment) {
                return res.status(429).json({
                    success: false,
                    message: 'Anda baru saja mengirim komentar. Coba lagi sebentar.'
                });
            }
        }

        await Comment.create({
            articleId: detikId,
            name: trimmedName,
            content: trimmedContent,
            ip: ip || undefined,
            status: 'pending'
        });

        return res.json({
            success: true,
            message: 'Komentar terkirim, menunggu moderasi sebelum tayang. Terima kasih!'
        });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, message: error.message });
    }
});


// =====================================
// KOMENTAR — MODERASI (dilindungi ADMIN_SECRET)
// =====================================

// Daftar komentar berdasarkan status (default: pending)
app.get('/api/admin/comments', checkAdminSecret, async (req, res) => {
    try {
        const status = ['pending', 'approved', 'rejected'].includes(req.query.status)
            ? req.query.status
            : 'pending';

        const comments = await Comment.find({ status })
            .sort({ createdAt: -1 })
            .limit(200);

        return res.json({ success: true, total: comments.length, data: comments });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/comments/:id/approve', checkAdminSecret, async (req, res) => {
    try {
        const comment = await Comment.findByIdAndUpdate(
            req.params.id,
            { status: 'approved' },
            { new: true }
        );
        if (!comment) return res.status(404).json({ success: false, message: 'Komentar tidak ditemukan.' });
        return res.json({ success: true, data: comment });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/admin/comments/:id/reject', checkAdminSecret, async (req, res) => {
    try {
        const comment = await Comment.findByIdAndUpdate(
            req.params.id,
            { status: 'rejected' },
            { new: true }
        );
        if (!comment) return res.status(404).json({ success: false, message: 'Komentar tidak ditemukan.' });
        return res.json({ success: true, data: comment });
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

// =====================================
// RSS FEED
// =====================================

app.get('/rss.xml', async (req, res) => {
    try {
        const articles = await Article.find({})
            .sort({ createdAt: -1 })
            .limit(30)
            .select('detikId title caption content author date createdAt');

        const items = articles.map((article) => {
            const link = articleDetailUrl(article);
            const pubDate = new Date(article.createdAt).toUTCString();
            const description = escapeXml(
                (article.caption || article.content || '').replace(/\s+/g, ' ').trim().slice(0, 300)
            );

            return `
    <item>
      <title>${escapeXml(article.title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="true">${escapeXml(link)}</guid>
      <pubDate>${pubDate}</pubDate>
      <author>${escapeXml(article.author || 'Redaksi')}</author>
      <description>${description}</description>
    </item>`;
        }).join('');

        const siteUrl = FRONTEND_URL || 'https://ganti-dengan-domain-frontend-anda.com';

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>SINYAL — Kabar Terkini Dunia &amp; Indonesia</title>
    <link>${escapeXml(siteUrl)}</link>
    <description>Berita terkini hasil rangkuman AI dari berbagai sumber terpercaya.</description>
    <language>id-ID</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>${items}
  </channel>
</rss>`;

        res.set('Content-Type', 'application/rss+xml; charset=utf-8');
        return res.send(xml);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, message: error.message });
    }
});


// =====================================
// SITEMAP.XML
// =====================================

app.get('/sitemap.xml', async (req, res) => {
    try {
        const articles = await Article.find({})
            .sort({ createdAt: -1 })
            .limit(1000)
            .select('detikId createdAt updatedAt');

        const siteUrl = FRONTEND_URL || 'https://ganti-dengan-domain-frontend-anda.com';

        const staticUrls = [
            { loc: `${siteUrl}/index.html`, lastmod: new Date().toISOString() }
        ];

        const articleUrls = articles.map((article) => ({
            loc: articleDetailUrl(article),
            lastmod: new Date(article.updatedAt || article.createdAt).toISOString()
        }));

        const allUrls = [...staticUrls, ...articleUrls];

        const urlEntries = allUrls.map((u) => `
  <url>
    <loc>${escapeXml(u.loc)}</loc>
    <lastmod>${u.lastmod}</lastmod>
  </url>`).join('');

        const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urlEntries}
</urlset>`;

        res.set('Content-Type', 'application/xml; charset=utf-8');
        return res.send(xml);
    } catch (error) {
        console.error(error);
        return res.status(500).json({ success: false, message: error.message });
    }
});

module.exports = app;
