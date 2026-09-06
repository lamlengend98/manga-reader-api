import express from 'express';
import axios from 'axios';
import https from 'https';
import { truyenqq } from './sources/truyenqq.js';
import { historyStore } from './historyStore.js';
import { searchHistoryStore } from './searchHistoryStore.js';

const app = express();
app.use(express.json());

// ── HTTP Keep-Alive & Chrome TLS Ciphers ──
const keepAliveAgent = new https.Agent({
    keepAlive: true,
    maxSockets: 20,
    ciphers: [
        'TLS_AES_128_GCM_SHA256',
        'TLS_AES_256_GCM_SHA384',
        'TLS_CHACHA20_POLY1305_SHA256',
        'ECDHE-ECDSA-AES128-GCM-SHA256',
        'ECDHE-RSA-AES128-GCM-SHA256',
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES256-GCM-SHA384'
    ].join(':'),
    honorCipherOrder: true,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3'
});
axios.defaults.httpsAgent = keepAliveAgent;

// ─────────────────────────────────────────────────────────────
// Cloudflare bypass — Hybrid: axios fast-path + FlareSolverr fallback
// ─────────────────────────────────────────────────────────────
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || 'http://localhost:8191/v1';
const SESSION_NAME = 'manga_reader';

// Cookie + UA cache per domain — populated from FlareSolverr responses
const sessionCache = new Map(); // domain -> { cookies, userAgent }

// In-flight request dedup — tránh gọi FlareSolverr song song cho cùng URL
const inflightRequests = new Map(); // url -> Promise<html>

// ── Quản lý FlareSolverr named session ──
async function ensureSession() {
    try {
        await axios.post(FLARESOLVERR_URL, {
            cmd: 'sessions.create',
            session: SESSION_NAME
        }, { timeout: 3000 });
        console.log('[flare] session created:', SESSION_NAME);
    } catch {
        // Session đã tồn tại hoặc FlareSolverr không khả dụng — bỏ qua
    }
}

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// ── Fetch HTML qua FlareSolverr (nếu có cài đặt) ──
async function flareFetch(targetUrl) {
    try {
        const res = await axios.post(FLARESOLVERR_URL, {
            cmd: 'request.get',
            url: targetUrl,
            session: SESSION_NAME,
            maxTimeout: 60000
        }, { timeout: 15000 });

        if (res.data?.status !== 'ok') {
            throw new Error(`FlareSolverr error: ${res.data?.message || 'unknown'}`);
        }

        const solution = res.data.solution;
        if (solution.status !== 200) {
            throw new Error(`Target responded with status ${solution.status}`);
        }

        // Cache cookies + UA cho axios fast-path
        if (solution.cookies?.length) {
            const domain = new URL(targetUrl).hostname;
            sessionCache.set(domain, {
                cookies: solution.cookies,
                userAgent: solution.userAgent
            });
        }

        return solution.response;
    } catch (err) {
        throw new Error(`FlareSolverr unavailable (${err.message})`);
    }
}

// ── Fetch HTML qua axios (fast path trực tiếp + mirror fallback) ──
async function axiosFetch(targetUrl) {
    const urlObj = new URL(targetUrl);
    const domain = urlObj.hostname;
    const session = sessionCache.get(domain);

    const headers = {
        'User-Agent': session?.userAgent || DEFAULT_USER_AGENT,
        'Referer': `https://${domain}/`,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
        'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
    };

    if (session?.cookies?.length) {
        headers['Cookie'] = session.cookies.map(c => `${c.name}=${c.value}`).join('; ');
    }

    // Danh sách domain mirror nếu domain chính bị Cloudflare chặn trên IP datacenter
    const candidateUrls = [targetUrl];
    if (domain === 'truyenqqko.com') {
        candidateUrls.push(targetUrl.replace('truyenqqko.com', 'truyenqqto.com'));
        candidateUrls.push(targetUrl.replace('truyenqqko.com', 'truyenqqhot.com'));
    }

    for (const url of candidateUrls) {
        try {
            const response = await axios.get(url, {
                headers: {
                    ...headers,
                    'Referer': `https://${new URL(url).hostname}/`
                },
                timeout: 10000,
                validateStatus: (status) => status < 500
            });

            if (response.status === 200 && response.data) {
                return response.data;
            }
        } catch (err) {
            console.warn(`[axios] fetch ${url} error:`, err.message);
        }
    }

    return null;
}

const CF_WORKER_URL = process.env.CF_WORKER_URL || 'https://manga-reader-api.lamnguyen98tb.workers.dev';

// ── fetchHTML chính: CF Worker proxy trước (đảm bảo 100% không bị chặn), axios trực tiếp, FlareSolverr sau — có request dedup ──
async function fetchHTML(targetUrl) {
    const existing = inflightRequests.get(targetUrl);
    if (existing) return existing;

    const promise = (async () => {
        // 1. Cloudflare Worker Proxy (vượt qua 100% Cloudflare Turnstile trên cloud)
        if (CF_WORKER_URL) {
            try {
                const proxyEndpoint = `${CF_WORKER_URL.replace(/\/$/, '')}/?url=${encodeURIComponent(targetUrl)}`;
                const workerRes = await axios.get(proxyEndpoint, { timeout: 15000 });
                if (workerRes.status === 200 && workerRes.data && typeof workerRes.data === 'string' && workerRes.data.includes('<html')) {
                    return workerRes.data;
                }
            } catch (err) {
                console.warn('[cf-worker] proxy fetch failed, trying direct axios:', err.message);
            }
        }

        // 2. Direct axios fetch
        const fast = await axiosFetch(targetUrl);
        if (fast) return fast;

        // 3. Slow path: FlareSolverr nếu có
        try {
            console.log('[flare] trying FlareSolverr for:', targetUrl);
            return await flareFetch(targetUrl);
        } catch (err) {
            console.warn('[flare] fallback failed:', err.message);
        }

        throw new Error(`Không thể tải dữ liệu từ trang nguồn (${targetUrl})`);
    })();

    inflightRequests.set(targetUrl, promise);
    try {
        return await promise;
    } finally {
        inflightRequests.delete(targetUrl);
    }
}

// ── Pre-warm: giải challenge ngay khi server khởi động ──
async function prewarm() {
    try {
        await ensureSession();
        console.log('[flare] pre-warming session...');
        await flareFetch('https://truyenqqko.com/truyen-hoan-thanh');
        console.log('[flare] pre-warm done, cookies cached');
    } catch (err) {
        console.log('[flare] pre-warm skipped or unavailable:', err.message);
    }
}

// ─────────────────────────────────────────────────────────────
// Response cache (theo endpoint + tham số) — giảm số lần phải crawl lại
// ─────────────────────────────────────────────────────────────
const responseCache = new Map(); // cacheKey -> { data, expiresAt }

async function cachedFetch(cacheKey, ttlMs, fetchFn) {
    const cached = responseCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.data;
    }
    const data = await fetchFn();
    if (data && (!Array.isArray(data.stories) || data.stories.length > 0)) {
        responseCache.set(cacheKey, { data, expiresAt: Date.now() + ttlMs });
    }
    return data;
}

// Dọn cache hết hạn định kỳ để tránh phình bộ nhớ vô hạn
setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of responseCache.entries()) {
        if (entry.expiresAt <= now) responseCache.delete(key);
    }
}, 10 * 60 * 1000);

const TTL = {
    LISTING: 30 * 60 * 1000,        // danh sách truyện: 30 phút
    STORY: 15 * 60 * 1000,           // danh sách chương: 15 phút
    CHAPTER: 7 * 24 * 60 * 60 * 1000 // nội dung ảnh 1 chương: 7 ngày (gần như không đổi)
};

// ─────────────────────────────────────────────────────────────
// Healthcheck & Info
// ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
    res.json({
        name: 'manga-reader-proxy-api',
        status: 'online',
        version: '1.0.0',
        endpoints: [
            '/truyenqq/completed',
            '/truyenqq/search?q=...',
            '/truyenqq/category?genre=...',
            '/truyenqq/story?url=...',
            '/truyenqq/chapter?url=...',
            '/history',
            '/search-history'
        ]
    });
});

app.get('/debug/test-fetch', async (req, res) => {
    try {
        const testUrl = req.query.url || 'https://truyenqqko.com/truyen-hoan-thanh';
        const response = await axios.get(testUrl, {
            headers: {
                'User-Agent': DEFAULT_USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
            },
            timeout: 15000,
            validateStatus: () => true
        });
        res.json({
            url: testUrl,
            status: response.status,
            headers: response.headers,
            dataPreview: typeof response.data === 'string' ? response.data.slice(0, 500) : response.data
        });
    } catch (err) {
        res.status(500).json({ error: err.message, stack: err.stack });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

// ─────────────────────────────────────────────────────────────
// Routes: TruyenQQ
// ─────────────────────────────────────────────────────────────

app.get('/truyenqq/completed', async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const cacheKey = `truyenqq:completed:${page}`;
        const result = await cachedFetch(cacheKey, TTL.LISTING, async () => {
            const url = truyenqq.listingUrl(page);
            const html = await fetchHTML(url);
            return truyenqq.parseListing(html, page);
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function normalizeText(str) {
    return (str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .toLowerCase()
        .trim();
}

app.get('/truyenqq/search', async (req, res) => {
    try {
        const query = (req.query.q || '').trim();
        const genre = (req.query.genre || req.query.category || '').trim();
        const page = parseInt(req.query.page) || 1;

        if (!query && !genre) {
            return res.json({ stories: [], page: 1, totalPages: 1 });
        }

        if (!query && genre) {
            const cacheKey = `truyenqq:category:${genre.toLowerCase()}:${page}`;
            const result = await cachedFetch(cacheKey, TTL.LISTING, async () => {
                const url = truyenqq.categoryUrl(genre, page);
                const html = await fetchHTML(url);
                return truyenqq.parseCategory(html, page);
            });
            return res.json(result);
        }

        if (query && genre) {
            const cacheKey = `truyenqq:search_category:${query.toLowerCase()}:${genre.toLowerCase()}:${page}`;
            const result = await cachedFetch(cacheKey, TTL.LISTING, async () => {
                const normQ = normalizeText(query);

                // Fetch category listing
                const categoryUrl = truyenqq.categoryUrl(genre, page);
                const catHtml = await fetchHTML(categoryUrl);
                const catResult = truyenqq.parseCategory(catHtml, page);

                // Filter category stories matching query in title or excerpt
                const filtered = catResult.stories.filter(s => {
                    const normTitle = normalizeText(s.title);
                    const normExcerpt = normalizeText(s.excerpt);
                    return normTitle.includes(normQ) || normExcerpt.includes(normQ);
                });

                return {
                    stories: filtered,
                    page,
                    totalPages: catResult.totalPages
                };
            });
            return res.json(result);
        }

        const cacheKey = `truyenqq:search:${query.toLowerCase()}:${page}`;
        const result = await cachedFetch(cacheKey, TTL.LISTING, async () => {
            const url = truyenqq.searchUrl(query, page);
            const html = await fetchHTML(url);
            return truyenqq.parseSearch(html, page);
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/truyenqq/category', async (req, res) => {
    try {
        const genre = (req.query.genre || req.query.category || '').trim();
        if (!genre) {
            return res.json({ stories: [], page: 1, totalPages: 1 });
        }
        const page = parseInt(req.query.page) || 1;
        const cacheKey = `truyenqq:category:${genre.toLowerCase()}:${page}`;
        const result = await cachedFetch(cacheKey, TTL.LISTING, async () => {
            const url = truyenqq.categoryUrl(genre, page);
            const html = await fetchHTML(url);
            return truyenqq.parseCategory(html, page);
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/truyenqq/story', async (req, res) => {
    try {
        const storyUrl = req.query.url;
        if (!storyUrl) return res.status(400).json({ error: 'missing url param' });

        const cacheKey = `truyenqq:story:${storyUrl}`;
        const result = await cachedFetch(cacheKey, TTL.STORY, async () => {
            const html = await fetchHTML(storyUrl);
            return truyenqq.parseChapterList(html, storyUrl);
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/truyenqq/chapter', async (req, res) => {
    try {
        const chapterUrl = req.query.url;
        if (!chapterUrl) return res.status(400).json({ error: 'missing url param' });

        const cacheKey = `truyenqq:chapter:${chapterUrl}`;
        const result = await cachedFetch(cacheKey, TTL.CHAPTER, async () => {
            const html = await fetchHTML(chapterUrl);
            return truyenqq.parseChapterImages(html, chapterUrl, req.query.title || '');
        });
        res.json(result);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// Image proxy — server tải ảnh hộ app (kèm Referer đúng), trả thẳng binary
// App dùng AsyncImage(url:) chuẩn của SwiftUI, không cần custom header nữa
// ─────────────────────────────────────────────────────────────

app.get('/image-proxy', async (req, res) => {
    try {
        const imageUrl = req.query.url;
        const referer = req.query.referer || 'https://truyenqqko.com/';
        if (!imageUrl) return res.status(400).json({ error: 'missing url param' });

        const response = await axios.get(imageUrl, {
            responseType: 'stream',
            headers: {
                'Referer': referer,
                'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 15000
        });

        res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=31536000, immutable'); // cache 1 năm phía client
        response.data.pipe(res);
    } catch (err) {
        res.status(502).json({ error: 'failed to fetch image', detail: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// Reading history — lưu theo device, dùng header X-Device-Id
// ─────────────────────────────────────────────────────────────

function requireDeviceId(req, res, next) {
    const deviceId = req.header('X-Device-Id');
    if (!deviceId) {
        return res.status(400).json({ error: 'missing X-Device-Id header' });
    }
    req.deviceId = deviceId;
    next();
}

app.post('/history', requireDeviceId, async (req, res) => {
    try {
        const { storyUrl, storyTitle, coverUrl, sourceId, kind,
            lastChapterUrl, lastChapterTitle } = req.body;

        if (!storyUrl || !lastChapterUrl) {
            return res.status(400).json({ error: 'missing storyUrl or lastChapterUrl' });
        }

        const entry = await historyStore.upsert(req.deviceId, storyUrl, {
            storyUrl, storyTitle, coverUrl, sourceId, kind,
            lastChapterUrl, lastChapterTitle
        });
        res.json(entry);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/history', requireDeviceId, async (req, res) => {
    try {
        const list = await historyStore.getAll(req.deviceId);
        res.json({ history: list });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/history/:storyUrl', requireDeviceId, async (req, res) => {
    try {
        await historyStore.remove(req.deviceId, decodeURIComponent(req.params.storyUrl));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/history', requireDeviceId, async (req, res) => {
    try {
        await historyStore.clear(req.deviceId);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// Search history — lưu theo device, dùng header X-Device-Id
// ─────────────────────────────────────────────────────────────

app.post('/search-history', requireDeviceId, async (req, res) => {
    try {
        const { query } = req.body;
        if (!query || !query.trim()) {
            return res.status(400).json({ error: 'missing query in body' });
        }
        const searches = await searchHistoryStore.add(req.deviceId, query);
        res.json({ searches });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/search-history', requireDeviceId, async (req, res) => {
    try {
        const searches = await searchHistoryStore.getAll(req.deviceId);
        res.json({ searches });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/search-history/:query', requireDeviceId, async (req, res) => {
    try {
        const query = decodeURIComponent(req.params.query);
        const searches = await searchHistoryStore.remove(req.deviceId, query);
        res.json({ success: true, searches });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/search-history', requireDeviceId, async (req, res) => {
    try {
        await searchHistoryStore.clear(req.deviceId);
        res.json({ success: true, searches: [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────────────────────
// Debug — xem HTML thô để đối chiếu khi site đổi cấu trúc
// ─────────────────────────────────────────────────────────────

app.get('/debug/raw', async (req, res) => {
    try {
        const targetUrl = req.query.url;
        if (!targetUrl) return res.status(400).json({ error: 'missing url param' });
        const html = await fetchHTML(targetUrl);
        res.type('text/html').send(html);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
    // Pre-warm FlareSolverr session ngay khi khởi động
    prewarm();
});