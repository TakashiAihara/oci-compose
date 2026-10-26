import type { Data, DataItem, Route } from '@/types';

/** google-news-rss on a home host PUTs this every 10 minutes as the dav user google-news; this route reads it as google-news-reader. */
const FILE = 'http://dav:6065/news.json';
const USER = 'google-news-reader';
/** A few missed runs are tolerated; older than this means the collector stopped, and a feed that stops changing looks like a quiet tab. */
const MAX_AGE_MS = 60 * 60 * 1000;
/** A fresh push can still carry a stale tab (cached signed-out data); For you always has something from the last day. */
const MAX_NEWEST_AGE_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 10000;
const PAGE = 'https://news.google.com/foryou?hl=ja&gl=JP&ceid=JP:ja';

type News = { url: string; title: string; publisher: string | null; published: number | null; image: string | null };

/** Only Google's resized thumbnails go into <img>, so a pushed file cannot put arbitrary markup in the description. */
const THUMBNAIL = /^https:\/\/encrypted-tbn\d\.gstatic\.com\/images\?q=tbn:[\w-]+(?:&[\w=-]+)*$/;

export const isNews = (x: unknown): x is News => {
    const n = x as News;
    return typeof n === 'object' && n !== null && typeof n.title === 'string' && n.title !== '' && typeof n.url === 'string' && /^https?:\/\//.test(n.url);
};

const published = (n: News): Date | undefined =>
    typeof n.published === 'number' && Number.isFinite(n.published) && n.published > 0 && n.published < 1e11 ? new Date(n.published * 1000) : undefined;

export const toItem = (n: News): DataItem => {
    // An image of another shape loses only the image, so a thumbnail host change does not empty the feed.
    const image = typeof n.image === 'string' && THUMBNAIL.test(n.image) ? n.image : undefined;
    return {
        title: n.title,
        link: n.url,
        author: typeof n.publisher === 'string' ? n.publisher : undefined,
        // An out-of-range number would make an Invalid Date, which throws when the Atom output calls toISOString.
        pubDate: published(n),
        image,
        description: image ? `<img src="${image}" referrerpolicy="no-referrer">` : undefined,
        enclosure_url: image,
        enclosure_type: image ? 'image/jpeg' : undefined,
        enclosure_length: image ? 0 : undefined,
    };
};

export const handler = async (): Promise<Data> => {
    const secret = process.env.GOOGLE_NEWS_DAV_READER_PASSWORD;
    if (!secret) {
        throw new Error('google-news-foryou: GOOGLE_NEWS_DAV_READER_PASSWORD is not set');
    }
    const res = await fetch(FILE, {
        headers: { authorization: `Basic ${Buffer.from(`${USER}:${secret}`).toString('base64')}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) {
        throw new Error('google-news-foryou: news.json is not on dav; the collector has never pushed');
    }
    if (!res.ok) {
        throw new Error(`google-news-foryou: dav answered ${res.status}`);
    }
    const modified = Date.parse(res.headers.get('last-modified') ?? '');
    if (Number.isNaN(modified)) {
        throw new Error('google-news-foryou: dav sent no Last-Modified, so the age of news.json is unknown');
    }
    const age = Date.now() - modified;
    if (age > MAX_AGE_MS) {
        throw new Error(`google-news-foryou: news.json was last pushed ${Math.round(age / 60000)} minutes ago; the collector stopped or is signed out`);
    }

    let news: unknown;
    try {
        news = JSON.parse(await res.text());
    } catch {
        throw new Error('google-news-foryou: news.json is not JSON; a push was cut off or the collector broke');
    }
    // Drop malformed entries rather than the feed; an all-bad file is a broken collector and fails below.
    const items = Array.isArray(news) ? news.filter((n) => isNews(n)) : [];
    if (items.length === 0) {
        throw new Error('google-news-foryou: news.json has no valid article; the collector or its format broke');
    }
    const newest = Math.max(0, ...items.map((n) => published(n)?.getTime() ?? 0));
    if (Date.now() - newest > MAX_NEWEST_AGE_MS) {
        throw new Error('google-news-foryou: no article from the last 24 hours; the collector is pushing a stale or signed-out tab');
    }
    return {
        title: 'Google ニュース おすすめ',
        link: PAGE,
        item: items.map(toItem),
    };
};

export const route: Route = {
    path: '/',
    name: 'For you',
    maintainers: ['TakashiAihara'],
    handler,
    example: '/google-news-foryou',
    categories: ['new-media'],
    features: {
        requireConfig: [{ name: 'GOOGLE_NEWS_DAV_READER_PASSWORD', description: 'Password of the dav user google-news-reader' }],
    },
};
