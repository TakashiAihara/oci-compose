import { readFile, stat } from 'node:fs/promises';

import type { Data, DataItem, Route } from '@/types';

/** Written by google-discover-rss on the home emulator host over ssh; mounted read-only (see docker-compose.yml). */
const FILE = '/data/google-discover/seen.json';
/** The collector runs hourly. Older than this means it stopped, and a feed that silently stops changing looks like a quiet Discover. */
const MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** The file keeps up to 2000; FreshRSS has the older ones already. */
const LIMIT = 500;

type Seen = { url: string; title: string; image: string | null; first_seen: string };

export const toItem = (s: Seen): DataItem => ({
    title: s.title,
    link: s.url,
    // Discover gives no publish time; the first time the collector saw the card is the closest stand-in.
    pubDate: new Date(s.first_seen),
    image: s.image ?? undefined,
    description: s.image ? `<img src="${s.image}" referrerpolicy="no-referrer">` : undefined,
    enclosure_url: s.image ?? undefined,
    enclosure_type: s.image ? 'image/jpeg' : undefined,
    enclosure_length: s.image ? 0 : undefined,
});

export const handler = async (): Promise<Data> => {
    let mtime: Date;
    try {
        mtime = (await stat(FILE)).mtime;
    } catch {
        throw new Error(`google-discover: ${FILE} is missing; the collector has never pushed or the mount is gone`);
    }
    const age = Date.now() - mtime.getTime();
    if (age > MAX_AGE_MS) {
        throw new Error(`google-discover: ${FILE} was last pushed ${Math.round(age / 60000)} minutes ago; the collector stopped`);
    }

    const seen: unknown = JSON.parse(await readFile(FILE, 'utf8'));
    if (!Array.isArray(seen) || seen.length === 0) {
        throw new Error('google-discover: the pushed file has no article; the collector or its format broke');
    }
    return {
        title: 'Google Discover',
        link: 'https://discover.google.com/',
        item: (seen as Seen[]).slice(0, LIMIT).map(toItem),
    };
};

export const route: Route = {
    path: '/',
    name: 'Discover',
    maintainers: ['TakashiAihara'],
    handler,
    example: '/google-discover',
    categories: ['new-media'],
};
