import * as cheerio from 'cheerio';
import { absoluteUrl, uniqueByUrl } from '../utils.js';

const BASE_URL = 'https://truyenqqko.com';

const GENRE_MAP = {
    'action': 'action-26',
    'adventure': 'adventure-27',
    'anime': 'anime-62',
    'chuyen sinh': 'chuyen-sinh-91',
    'chuyển sinh': 'chuyen-sinh-91',
    'co dai': 'co-dai-90',
    'cổ đại': 'co-dai-90',
    'comedy': 'comedy-28',
    'comic': 'comic-60',
    'demons': 'demons-99',
    'detective': 'detective-100',
    'doujinshi': 'doujinshi-96',
    'drama': 'drama-29',
    'fantasy': 'fantasy-30',
    'gender bender': 'gender-bender-45',
    'harem': 'harem-47',
    'historical': 'historical-51',
    'horror': 'horror-44',
    'huyen huyen': 'huyen-huyen-468',
    'huyền huyễn': 'huyen-huyen-468',
    'isekai': 'isekai-85',
    'josei': 'josei-54',
    'mafia': 'mafia-69',
    'magic': 'magic-58',
    'manga': 'manga-469',
    'manhua': 'manhua-35',
    'manhwa': 'manhwa-49',
    'martial arts': 'martial-arts-41',
    'military': 'military-101',
    'mystery': 'mystery-39',
    'ngon tinh': 'ngon-tinh-87',
    'ngôn tình': 'ngon-tinh-87',
    'one shot': 'one-shot-95',
    'psychological': 'psychological-40',
    'romance': 'romance-36',
    'school life': 'school-life-37',
    'sci-fi': 'sci-fi-43',
    'scifi': 'sci-fi-43',
    'seinen': 'seinen-42',
    'shoujo': 'shoujo-38',
    'shoujo ai': 'shoujo-ai-98',
    'shounen': 'shounen-31',
    'shounen ai': 'shounen-ai-86',
    'slice of life': 'slice-of-life-46',
    'sports': 'sports-57',
    'supernatural': 'supernatural-32',
    'tragedy': 'tragedy-52',
    'trong sinh': 'trong-sinh-82',
    'trọng sinh': 'trong-sinh-82',
    'truyen mau': 'truyen-mau-92',
    'truyện màu': 'truyen-mau-92',
    'webtoon': 'webtoon-55',
    'xuyen khong': 'xuyen-khong-88',
    'xuyên không': 'xuyen-khong-88'
};

export const truyenqq = {
    id: 'truyenqq',
    name: 'TruyenQQ',
    kind: 'comic',
    baseUrl: BASE_URL,

    listingUrl(page = 1) {
        return page > 1
            ? `${BASE_URL}/truyen-hoan-thanh/trang-${page}?status=2`
            : `${BASE_URL}/truyen-hoan-thanh`;
    },

    categoryUrl(genre, page = 1) {
        const raw = (genre || '').trim().toLowerCase();
        const slug = GENRE_MAP[raw] || raw;
        return page > 1
            ? `${BASE_URL}/the-loai/${slug}/trang-${page}`
            : `${BASE_URL}/the-loai/${slug}`;
    },

    parseCategory(html, page = 1) {
        return this.parseListing(html, page);
    },

    // Tương đương parseListing() trong file Lua
    parseListing(html, page = 1) {
        const $ = cheerio.load(html);
        const stories = [];

        $('div.book_info').each((_, infoEl) => {
            const $info = $(infoEl);
            const nameDiv = $info.find('div.book_name').first();
            const a = nameDiv.find('h3 a').first();
            const href = a.attr('href');
            const title = a.attr('title')?.trim() || a.text().trim();

            const avatarDiv = $info.prev('div.book_avatar');
            const img = avatarDiv.find('img').first();
            const cover = img.attr('src');

            const lastChapter = $info.find('div.last_chapter a').first().text().trim() || null;
            const excerpt = $info.find('div.excerpt').first().text().trim() || null;

            if (href && title) {
                stories.push({
                    sourceId: this.id,
                    title,
                    url: absoluteUrl(BASE_URL, href),
                    coverUrl: absoluteUrl(BASE_URL, cover),
                    lastChapter,
                    excerpt,
                    kind: this.kind
                });
            }
        });

        return {
            stories: uniqueByUrl(stories),
            page,
            totalPages: this.parseMaxPage($, page)
        };
    },

    searchUrl(query, page = 1) {
        const q = encodeURIComponent(query);
        return page > 1
            ? `${BASE_URL}/tim-kiem/trang-${page}?q=${q}`
            : `${BASE_URL}/tim-kiem?q=${q}`;
    },

    parseMaxPage($, currentPage) {
        let max = currentPage;
        $('.pagination a, .page-item a, .page_redirect a').each((_, el) => {
            const num = parseInt($(el).text().trim(), 10);
            if (!isNaN(num) && num > max) max = num;
        });
        return max;
    },

    // Tương đương parseSearch()
    parseSearch(html, page = 1) {
        const $ = cheerio.load(html);
        const stories = [];

        $('div.book_info').each((_, infoEl) => {
            const $info = $(infoEl);
            const nameDiv = $info.find('div.book_name').first();
            const a = nameDiv.find('h3 a').first();
            const href = a.attr('href');
            const title = a.attr('title')?.trim() || a.text().trim();

            const avatarDiv = $info.prev('div.book_avatar');
            const img = avatarDiv.find('img').first();
            const cover = img.attr('src') || img.attr('data-src') || img.attr('data-original');

            const lastChapter = $info.find('div.last_chapter a').first().text().trim() || null;
            const excerpt = $info.find('div.excerpt').first().text().trim() || null;

            if (href && title) {
                stories.push({
                    sourceId: this.id,
                    title,
                    url: absoluteUrl(BASE_URL, href),
                    coverUrl: absoluteUrl(BASE_URL, cover),
                    lastChapter,
                    excerpt,
                    kind: this.kind
                });
            }
        });

        // Fallback cho định dạng list nếu có
        if (stories.length === 0) {
            $('li').each((_, el) => {
                const a = $(el).find('a').first();
                const href = a.attr('href');
                const titleEl = $(el).find('p.name').first();
                const title = titleEl.text().trim();
                const img = $(el).find('img').first();
                const cover = img.attr('src') || img.attr('data-fb') || img.attr('data-src');

                if (href && title) {
                    stories.push({
                        sourceId: this.id,
                        title,
                        url: absoluteUrl(BASE_URL, href),
                        coverUrl: absoluteUrl(BASE_URL, cover),
                        kind: this.kind
                    });
                }
            });
        }

        return {
            stories: uniqueByUrl(stories),
            page,
            totalPages: this.parseMaxPage($, page)
        };
    },

    // Tương đương parseStoryDetails()
    parseStoryDetails(html) {
        const $ = cheerio.load(html);

        const title = $('h1[itemprop="name"]').text().trim()
            || $('h1.title-detail').text().trim()
            || $('div.book_info h1').text().trim()
            || $('h1').first().text().trim()
            || null;

        const rawCover = $('div.book_avatar img').attr('src')
            || $('div.book_avatar img').attr('data-src')
            || $('div.book_avatar img').attr('data-original')
            || $('div.block_avatar img').attr('src')
            || $('div.block_avatar img').attr('data-src')
            || $('div.book_info img').attr('src')
            || $('div.book_info img').attr('data-src')
            || $('meta[property="og:image"]').attr('content')
            || null;
        const coverUrl = rawCover ? absoluteUrl(BASE_URL, rawCover) : null;

        const description = $('.story-detail-info.detail-content').text().trim()
            || $('meta[name="description"]').attr('content')
            || '';

        const author = $('li.author p').first().text().trim() || null;
        const status = $('li.status p').first().text().trim() || null;

        const genres = [];
        $('ul.list01 a').each((_, el) => {
            const name = $(el).text().trim();
            if (name) genres.push(name);
        });

        return { title, coverUrl, description, author, status, genres };
    },

    // Tương đương parseStoryPage() — danh sách chương
    parseChapterList(html, storyUrl) {
        const $ = cheerio.load(html);
        const chapters = [];
        const slug = storyUrl.split('/').filter(Boolean).pop() || '';
        const baseSlug = slug.replace(/-\d+\.html$/, '').replace(/\.html$/, '');

        const isChapterLink = (href) => {
            const lower = href.toLowerCase();
            return lower.includes('-chap-') || lower.includes('chapter') || lower.includes('chuong');
        };

        // Quét tất cả các container chứa danh sách chương trên TruyenQQ
        const selectors = [
            'div.list_chapter a',
            'div.works-chapter-list a',
            'div.works-chapter-item a',
            'div.list-chapter a',
            'div.chapter-list a',
            'div.listing-chapters a',
            'ul.list-chapters a'
        ];

        $(selectors.join(', ')).each((_, el) => {
            const href = $(el).attr('href');
            if (!href) return;
            const chapterUrl = absoluteUrl(BASE_URL, href);
            if (chapterUrl && isChapterLink(chapterUrl)) {
                // Kiểm tra xem chapter có thuộc story này không (bằng baseSlug hoặc id truyện)
                const matchesStory = baseSlug ? chapterUrl.includes(baseSlug) : true;
                if (matchesStory) {
                    chapters.push({
                        title: $(el).text().trim() || 'Chương',
                        url: chapterUrl,
                        sourceId: this.id,
                        storyUrl
                    });
                }
            }
        });

        return {
            chapters: uniqueByUrl(chapters),
            details: this.parseStoryDetails(html)
        };
    },

    // Tương đương parseChapter() — lấy ảnh manga
    parseChapterImages(html, chapterUrl, fallbackTitle) {
        const $ = cheerio.load(html);
        const images = [];

        $('div[id^="page_"].page-chapter, div.page-chapter[id^="page_"]').each((_, div) => {
            $(div).find('img').each((_, img) => {
                const primary = $(img).attr('data-original') || $(img).attr('src');
                if (!primary) return;

                const candidates = [
                    primary,
                    $(img).attr('data-cdn'),
                    $(img).attr('data-fb')
                ].filter(Boolean);

                const urls = [...new Set(candidates)]
                    .map(u => absoluteUrl(BASE_URL, u))
                    .filter(Boolean);

                if (urls.length > 0) images.push({ urls });
            });
        });

        if (images.length === 0) {
            return { error: 'Không tìm thấy ảnh của chương (kiểm tra selector, site có thể đã đổi cấu trúc)' };
        }

        const title = $('h1.detail-title').first().text().trim() || fallbackTitle;

        return {
            title,
            images,
            url: chapterUrl,
            referer: `${BASE_URL}/`,
            kind: this.kind
        };
    }
};