import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const SEARCH_HISTORY_FILE = path.join(DATA_DIR, 'search-history.json');

let writeLock = Promise.resolve();

async function ensureDataFile() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
        await fs.access(SEARCH_HISTORY_FILE);
    } catch {
        await fs.writeFile(SEARCH_HISTORY_FILE, JSON.stringify({}), 'utf-8');
    }
}

async function readSearchHistory() {
    await ensureDataFile();
    const raw = await fs.readFile(SEARCH_HISTORY_FILE, 'utf-8');
    return JSON.parse(raw);
}

async function writeSearchHistory(data) {
    await fs.writeFile(SEARCH_HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function withLock(fn) {
    const result = writeLock.then(fn);
    writeLock = result.catch(() => { });
    return result;
}

export const searchHistoryStore = {
    async add(deviceId, query) {
        const trimmed = (query || '').trim();
        if (!trimmed) return [];

        return withLock(async () => {
            const data = await readSearchHistory();
            if (!data[deviceId]) data[deviceId] = [];

            // Remove case-insensitive duplicate
            const filtered = data[deviceId].filter(
                q => q.toLowerCase() !== trimmed.toLowerCase()
            );

            // Prepend new search query
            filtered.unshift(trimmed);

            // Keep max 20 recent searches
            data[deviceId] = filtered.slice(0, 20);

            await writeSearchHistory(data);
            return data[deviceId];
        });
    },

    async getAll(deviceId) {
        const data = await readSearchHistory();
        return data[deviceId] || [];
    },

    async remove(deviceId, query) {
        const trimmed = (query || '').trim();
        return withLock(async () => {
            const data = await readSearchHistory();
            if (data[deviceId]) {
                data[deviceId] = data[deviceId].filter(
                    q => q.toLowerCase() !== trimmed.toLowerCase()
                );
                await writeSearchHistory(data);
            }
            return data[deviceId] || [];
        });
    },

    async clear(deviceId) {
        return withLock(async () => {
            const data = await readSearchHistory();
            data[deviceId] = [];
            await writeSearchHistory(data);
            return [];
        });
    }
};
