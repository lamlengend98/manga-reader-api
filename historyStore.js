import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'reading-history.json');

let writeLock = Promise.resolve();

async function ensureDataFile() {
    await fs.mkdir(DATA_DIR, { recursive: true });
    try {
        await fs.access(HISTORY_FILE);
    } catch {
        await fs.writeFile(HISTORY_FILE, JSON.stringify({}), 'utf-8');
    }
}

async function readHistory() {
    await ensureDataFile();
    const raw = await fs.readFile(HISTORY_FILE, 'utf-8');
    return JSON.parse(raw);
}

async function writeHistory(data) {
    await fs.writeFile(HISTORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

function withLock(fn) {
    const result = writeLock.then(fn);
    writeLock = result.catch(() => { });
    return result;
}

export const historyStore = {
    async upsert(deviceId, storyUrl, entry) {
        return withLock(async () => {
            const data = await readHistory();
            if (!data[deviceId]) data[deviceId] = {};
            data[deviceId][storyUrl] = {
                ...data[deviceId][storyUrl],
                ...entry,
                lastReadAt: new Date().toISOString()
            };
            await writeHistory(data);
            return data[deviceId][storyUrl];
        });
    },

    async getAll(deviceId) {
        const data = await readHistory();
        const deviceData = data[deviceId] || {};
        return Object.values(deviceData).sort(
            (a, b) => new Date(b.lastReadAt) - new Date(a.lastReadAt)
        );
    },

    async remove(deviceId, storyUrl) {
        return withLock(async () => {
            const data = await readHistory();
            if (data[deviceId]) delete data[deviceId][storyUrl];
            await writeHistory(data);
        });
    },

    async clear(deviceId) {
        return withLock(async () => {
            const data = await readHistory();
            data[deviceId] = {};
            await writeHistory(data);
        });
    }
};