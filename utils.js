export function absoluteUrl(base, href) {
    if (!href) return null;
    try {
        return new URL(href, base).toString();
    } catch {
        return null;
    }
}

export function uniqueByUrl(items) {
    const seen = new Set();
    return items.filter(item => {
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
    });
}