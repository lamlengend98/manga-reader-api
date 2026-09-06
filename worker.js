export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*'
        }
      });
    }

    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return new Response(JSON.stringify({
        name: 'manga-reader-cf-proxy',
        status: 'online',
        usage: '/?url=https://truyenqqto.com/truyen-hoan-thanh'
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    const candidateUrls = [targetUrl];
    if (targetUrl.includes('truyenqqko.com')) {
      candidateUrls.unshift(targetUrl.replace('truyenqqko.com', 'truyenqqto.com'));
    }

    for (const fetchUrl of candidateUrls) {
      try {
        const domain = new URL(fetchUrl).hostname;
        const response = await fetch(fetchUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
            'Referer': `https://${domain}/`,
            'Sec-Ch-Ua': '"Chromium";v="128", "Not;A=Brand";v="24", "Google Chrome";v="128"',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1'
          }
        });

        const body = await response.text();
        if (response.status === 200 && !body.includes('Just a moment...') && !body.includes('Access denied') && body.length > 5000) {
          return new Response(body, {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }
      } catch (err) {
        // continue to next candidate
      }
    }

    return new Response(JSON.stringify({ error: 'All upstream mirrors blocked' }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};
