import { truyenqq } from './sources/truyenqq.js';

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

// In-memory cache for Worker edge instance
const responseCache = new Map();
const readingHistoryMap = new Map(); // deviceId -> Map<storyUrl, entry>
const searchHistoryMap = new Map();  // deviceId -> Array<string>

const TTL = {
    LISTING: 30 * 60 * 1000,
    STORY: 15 * 60 * 1000,
    CHAPTER: 7 * 24 * 60 * 60 * 1000
};

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

async function fetchHTML(targetUrl) {
    const candidateUrls = [targetUrl];
    if (targetUrl.includes('truyenqqko.com')) {
        candidateUrls.unshift(targetUrl.replace('truyenqqko.com', 'truyenqqto.com'));
    }

    for (const url of candidateUrls) {
        try {
            const domain = new URL(url).hostname;
            const res = await fetch(url, {
                headers: {
                    'User-Agent': DEFAULT_USER_AGENT,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
                    'Referer': `https://${domain}/`,
                    'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
                    'Sec-Ch-Ua-Mobile': '?0',
                    'Sec-Ch-Ua-Platform': '"Windows"',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Sec-Fetch-User': '?1',
                    'Upgrade-Insecure-Requests': '1'
                }
            });

            if (res.status === 200) {
                const text = await res.text();
                if (text && !text.includes('Just a moment...') && !text.includes('Access denied') && text.length > 3000) {
                    return text;
                }
            }
        } catch {
            // try next candidate
        }
    }
    throw new Error(`Failed to fetch HTML from ${targetUrl}`);
}

function normalizeText(str) {
    return (str || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/đ/g, 'd')
        .replace(/Đ/g, 'D')
        .toLowerCase()
        .trim();
}

// ── Sitemap-based search index ──
// TruyenQQ blocks /tim-kiem endpoint server-side (returns 0 bytes).
// Instead, we build a search index from sitemaps (23k+ manga URLs).
let sitemapIndex = null; // { entries: [{url, slug, titleFromSlug}], expiresAt }

async function getSitemapIndex() {
    if (sitemapIndex && sitemapIndex.expiresAt > Date.now()) {
        return sitemapIndex.entries;
    }

    const sitemapUrls = [
        'https://truyenqqko.com/sitemap-comic-1.xml',
        'https://truyenqqko.com/sitemap-comic-2.xml',
        'https://truyenqqko.com/sitemap-comic-3.xml',
        'https://truyenqqko.com/sitemap-comic-new.xml'
    ];

    const entries = [];
    const results = await Promise.allSettled(
        sitemapUrls.map(u => fetch(u, {
            headers: { 'User-Agent': DEFAULT_USER_AGENT }
        }).then(r => r.text()))
    );

    for (const r of results) {
        if (r.status !== 'fulfilled' || !r.value) continue;
        const matches = r.value.matchAll(/<loc>(https:\/\/truyenqqko\.com\/truyen-tranh\/([^<]+))<\/loc>/g);
        for (const m of matches) {
            const url = m[1];
            const slug = m[2]; // e.g. "one-piece-1-128"
            // Remove trailing numeric ID: "one-piece-1-128" -> "one-piece"
            // but keep meaningful numbers like "3077" in "thien-ma-3077-16100"
            const titleFromSlug = slug
                .replace(/-\d+$/, '')  // remove last numeric ID
                .replace(/-/g, ' ');   // dashes to spaces
            entries.push({ url, slug, titleFromSlug });
        }
    }

    // Cache for 6 hours
    sitemapIndex = { entries, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
    return entries;
}

async function searchBySitemap(query, page = 1) {
    const entries = await getSitemapIndex();
    const normQ = normalizeText(query);
    const queryWords = normQ.split(/\s+/).filter(w => w.length > 0);

    // Score each entry by how well its slug matches the query
    const scored = [];
    for (const entry of entries) {
        const normSlug = normalizeText(entry.titleFromSlug);
        // All query words must appear in slug
        const allMatch = queryWords.every(w => normSlug.includes(w));
        if (!allMatch) continue;

        // Score: exact match > starts with > contains
        let score = 0;
        if (normSlug === normQ) score = 100;
        else if (normSlug.startsWith(normQ)) score = 80;
        else score = 50;
        // Bonus: shorter slugs rank higher (more specific match)
        score -= Math.min(normSlug.length, 30) * 0.5;

        scored.push({ ...entry, score });
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Paginate: 20 per page
    const perPage = 20;
    const totalPages = Math.max(1, Math.ceil(scored.length / perPage));
    const pageItems = scored.slice((page - 1) * perPage, page * perPage);

    if (pageItems.length === 0) {
        return { stories: [], page, totalPages };
    }

    // Fetch story detail pages in parallel (max 10 at a time) to get covers/titles
    const detailResults = await Promise.allSettled(
        pageItems.map(item =>
            fetchHTML(item.url).then(html => {
                const details = truyenqq.parseStoryDetails(html);
                return {
                    sourceId: 'truyenqq',
                    title: details.title || item.titleFromSlug,
                    url: item.url,
                    coverUrl: details.coverUrl || null,
                    lastChapter: null,
                    excerpt: details.description || null,
                    kind: 'comic'
                };
            }).catch(() => ({
                sourceId: 'truyenqq',
                title: item.titleFromSlug.replace(/(^|\s)\S/g, c => c.toUpperCase()),
                url: item.url,
                coverUrl: null,
                lastChapter: null,
                excerpt: null,
                kind: 'comic'
            }))
        )
    );

    const stories = detailResults
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);

    return { stories, page, totalPages };
}

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': '*'
        }
    });
}

export default {
    async fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        if (method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': '*'
                }
            });
        }

        const deviceId = request.headers.get('x-device-id') || request.headers.get('X-Device-Id') || 'anonymous';

        try {
            // ── Root / Healthcheck ──
            if (path === '/' || path === '/health') {
                return jsonResponse({
                    name: 'manga-reader-cf-api',
                    status: 'online',
                    version: '2.0.0',
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
            }

            // ── TruyenQQ: Completed / Listing ──
            if (path === '/truyenqq/completed') {
                const page = parseInt(url.searchParams.get('page')) || 1;
                const cacheKey = `truyenqq:completed:${page}`;
                const result = await cachedFetch(cacheKey, TTL.LISTING, async () => {
                    const listingUrl = truyenqq.listingUrl(page);
                    const html = await fetchHTML(listingUrl);
                    return truyenqq.parseListing(html, page);
                });
                return jsonResponse(result);
            }

            // ── TruyenQQ: Search / Search + Category ──
            if (path === '/truyenqq/search') {
                const query = (url.searchParams.get('q') || '').trim();
                const genre = (url.searchParams.get('genre') || url.searchParams.get('category') || '').trim();
                const page = parseInt(url.searchParams.get('page')) || 1;

                if (!query && !genre) {
                    return jsonResponse({ stories: [], page: 1, totalPages: 1 });
                }

                if (!query && genre) {
                    const cacheKey = `truyenqq:category:${genre.toLowerCase()}:${page}`;
                    const result = await cachedFetch(cacheKey, TTL.LISTING, async () => {
                        const catUrl = truyenqq.categoryUrl(genre, page);
                        const html = await fetchHTML(catUrl);
                        return truyenqq.parseCategory(html, page);
                    });
                    return jsonResponse(result);
                }

                if (query && genre) {
                    const cacheKey = `truyenqq:search_category:${query.toLowerCase()}:${genre.toLowerCase()}:${page}`;
                    const result = await cachedFetch(cacheKey, TTL.LISTING, async () => {
                        const normQ = normalizeText(query);
                        const catUrl = truyenqq.categoryUrl(genre, page);
                        const catHtml = await fetchHTML(catUrl);
                        const catResult = truyenqq.parseCategory(catHtml, page);

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
                    return jsonResponse(result);
                }

                const cacheKey = `truyenqq:search:${query.toLowerCase()}:${page}`;
                const result = await cachedFetch(cacheKey, TTL.LISTING, async () => {
                    // Use sitemap-based search (covers all 23k+ manga on TruyenQQ)
                    return await searchBySitemap(query, page);
                });
                return jsonResponse(result);
            }

            // ── TruyenQQ: Category ──
            if (path === '/truyenqq/category') {
                const genre = (url.searchParams.get('genre') || url.searchParams.get('category') || '').trim();
                if (!genre) return jsonResponse({ stories: [], page: 1, totalPages: 1 });

                const page = parseInt(url.searchParams.get('page')) || 1;
                const cacheKey = `truyenqq:category:${genre.toLowerCase()}:${page}`;
                const result = await cachedFetch(cacheKey, TTL.LISTING, async () => {
                    const catUrl = truyenqq.categoryUrl(genre, page);
                    const html = await fetchHTML(catUrl);
                    return truyenqq.parseCategory(html, page);
                });
                return jsonResponse(result);
            }

            // ── TruyenQQ: Story Detail ──
            if (path === '/truyenqq/story') {
                const storyUrl = url.searchParams.get('url');
                if (!storyUrl) return jsonResponse({ error: 'missing url param' }, 400);

                const cacheKey = `truyenqq:story:${storyUrl}`;
                const result = await cachedFetch(cacheKey, TTL.STORY, async () => {
                    const html = await fetchHTML(storyUrl);
                    return truyenqq.parseChapterList(html, storyUrl);
                });
                return jsonResponse(result);
            }

            // ── TruyenQQ: Chapter Images ──
            if (path === '/truyenqq/chapter') {
                const chapterUrl = url.searchParams.get('url');
                if (!chapterUrl) return jsonResponse({ error: 'missing url param' }, 400);

                const cacheKey = `truyenqq:chapter:${chapterUrl}`;
                const result = await cachedFetch(cacheKey, TTL.CHAPTER, async () => {
                    const html = await fetchHTML(chapterUrl);
                    return truyenqq.parseChapterImages(html, chapterUrl, url.searchParams.get('title') || '');
                });
                return jsonResponse(result);
            }

            // ── Reading History ──
            if (path === '/history') {
                if (method === 'GET') {
                    const deviceMap = readingHistoryMap.get(deviceId) || new Map();
                    const list = Array.from(deviceMap.values()).sort(
                        (a, b) => new Date(b.lastReadAt) - new Date(a.lastReadAt)
                    );
                    return jsonResponse({ history: list });
                }

                if (method === 'POST') {
                    const body = await request.json();
                    const { storyUrl, storyTitle, coverUrl, sourceId, kind, lastChapterUrl, lastChapterTitle } = body;
                    if (!storyUrl || !lastChapterUrl) {
                        return jsonResponse({ error: 'missing storyUrl or lastChapterUrl' }, 400);
                    }

                    let deviceMap = readingHistoryMap.get(deviceId);
                    if (!deviceMap) {
                        deviceMap = new Map();
                        readingHistoryMap.set(deviceId, deviceMap);
                    }

                    const existing = deviceMap.get(storyUrl) || {};
                    const entry = {
                        ...existing,
                        storyUrl,
                        storyTitle,
                        coverUrl,
                        sourceId,
                        kind,
                        lastChapterUrl,
                        lastChapterTitle,
                        lastReadAt: new Date().toISOString()
                    };
                    deviceMap.set(storyUrl, entry);
                    return jsonResponse(entry);
                }

                if (method === 'DELETE') {
                    readingHistoryMap.delete(deviceId);
                    return jsonResponse({ success: true });
                }
            }

            if (path.startsWith('/history/')) {
                if (method === 'DELETE') {
                    const rawStoryUrl = path.slice('/history/'.length);
                    const storyUrl = decodeURIComponent(rawStoryUrl);
                    const deviceMap = readingHistoryMap.get(deviceId);
                    if (deviceMap) {
                        deviceMap.delete(storyUrl);
                    }
                    return jsonResponse({ success: true });
                }
            }

            // ── Search History ──
            if (path === '/search-history') {
                if (method === 'GET') {
                    const list = searchHistoryMap.get(deviceId) || [];
                    return jsonResponse(list);
                }

                if (method === 'POST') {
                    const body = await request.json();
                    const query = (body.query || '').trim();
                    if (!query) {
                        return jsonResponse(searchHistoryMap.get(deviceId) || []);
                    }

                    let list = searchHistoryMap.get(deviceId) || [];
                    list = list.filter(q => q.toLowerCase() !== query.toLowerCase());
                    list.unshift(query);
                    list = list.slice(0, 20);
                    searchHistoryMap.set(deviceId, list);
                    return jsonResponse(list);
                }

                if (method === 'DELETE') {
                    searchHistoryMap.delete(deviceId);
                    return jsonResponse([]);
                }
            }

            if (path.startsWith('/search-history/')) {
                if (method === 'DELETE') {
                    const rawQuery = path.slice('/search-history/'.length);
                    const query = decodeURIComponent(rawQuery).trim();
                    let list = searchHistoryMap.get(deviceId) || [];
                    list = list.filter(q => q.toLowerCase() !== query.toLowerCase());
                    searchHistoryMap.set(deviceId, list);
                    return jsonResponse(list);
                }
            }

            // ── Image Proxy ──
            if (path === '/image-proxy') {
                const imageUrl = url.searchParams.get('url');
                const referer = url.searchParams.get('referer') || 'https://truyenqqto.com/';
                if (!imageUrl) return jsonResponse({ error: 'missing url param' }, 400);

                const imgRes = await fetch(imageUrl, {
                    headers: {
                        'Referer': referer,
                        'User-Agent': DEFAULT_USER_AGENT
                    }
                });

                const headers = new Headers(imgRes.headers);
                headers.set('Cache-Control', 'public, max-age=31536000, immutable');
                headers.set('Access-Control-Allow-Origin', '*');

                return new Response(imgRes.body, {
                    status: imgRes.status,
                    headers
                });
            }

            return jsonResponse({ error: `Route not found: ${method} ${path}` }, 404);
        } catch (err) {
            return jsonResponse({ error: err.message, stack: err.stack }, 500);
        }
    }
};
