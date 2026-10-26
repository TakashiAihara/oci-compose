import type { Data, DataItem, Route } from '@/types';

/** google-discover-rss on the home emulator host PUTs this hourly as the dav user google-discover; this route reads it as google-discover-reader. */
const FILE = 'http://dav:6065/seen.json';
const USER = 'google-discover-reader';
/** The collector runs hourly. Older than this means it stopped, and a feed that silently stops changing looks like a quiet Discover. */
const MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** The file keeps up to 2000; FreshRSS has the older ones already. */
const LIMIT = 500;
const TIMEOUT_MS = 10000;

type Seen = { url: string; title: string; image: string | null; first_seen: string };

/** Only Google's resized thumbnails go into <img>, so a pushed file cannot put arbitrary markup in the description. */
const THUMBNAIL = /^https:\/\/encrypted-tbn\d\.gstatic\.com\/images\?q=tbn:[\w-]+(?:&s=\d+)?$/;

export const isSeen = (x: unknown): x is Seen => {
    const s = x as Seen;
    return (
        typeof s === 'object' &&
        s !== null &&
        typeof s.title === 'string' &&
        s.title !== '' &&
        typeof s.url === 'string' &&
        /^https?:\/\//.test(s.url) &&
        !Number.isNaN(Date.parse(s.first_seen)) &&
        (s.image === null || (typeof s.image === 'string' && THUMBNAIL.test(s.image)))
    );
};

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
    const password = process.env.GOOGLE_DISCOVER_DAV_READER_PASSWORD?.trim();
    if (!password) {
        throw new Error('google-discover: GOOGLE_DISCOVER_DAV_READER_PASSWORD is not set');
    }
    const res = await fetch(FILE, {
        headers: { authorization: `Basic ${Buffer.from(`${USER}:${password}`).toString('base64')}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) {
        throw new Error('google-discover: seen.json is not on dav; the collector has never pushed');
    }
    if (!res.ok) {
        throw new Error(`google-discover: dav answered ${res.status}`);
    }
    const modified = Date.parse(res.headers.get('last-modified') ?? '');
    if (Number.isNaN(modified)) {
        throw new Error('google-discover: dav sent no Last-Modified, so the age of seen.json is unknown');
    }
    const age = Date.now() - modified;
    if (age > MAX_AGE_MS) {
        throw new Error(`google-discover: seen.json was last pushed ${Math.round(age / 60000)} minutes ago; the collector stopped`);
    }

    let seen: unknown;
    try {
        seen = JSON.parse(await res.text());
    } catch {
        throw new Error('google-discover: seen.json is not JSON; a push was cut off or the collector broke');
    }
    // Drop malformed entries rather than the feed; an all-bad file is a broken collector and fails below.
    const items = Array.isArray(seen) ? seen.filter((s) => isSeen(s)) : [];
    if (items.length === 0) {
        throw new Error('google-discover: seen.json has no valid article; the collector or its format broke');
    }
    return {
        title: 'Google Discover',
        link: 'https://discover.google.com/',
        item: items.slice(0, LIMIT).map(toItem),
    };
};

export const route: Route = {
    path: '/',
    name: 'Discover',
    maintainers: ['TakashiAihara'],
    handler,
    example: '/google-discover',
    categories: ['new-media'],
    features: {
        requireConfig: [{ name: 'GOOGLE_DISCOVER_DAV_READER_PASSWORD', description: 'Password of the dav user google-discover-reader' }],
    },
};
