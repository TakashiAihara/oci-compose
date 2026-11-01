import type { Context } from 'hono';

import type { Data, DataItem, Route } from '@/types';

/** taba web on taba1, reached over the site-to-site link; it serves only oi1's address carrying x-taba-web-key. */
const WEB = 'http://192.168.0.182:8790';
/** Under FreshRSS's 30s feed timeout; taba web logs a cold /api/rows over R2 at 12s. */
const TIMEOUT_MS = 20000;
const HOUR_MS = 60 * 60 * 1000;
/**
 * The collectors this route serves, each with how old its newest run may be before the feed fails (the collector
 * stopped). RSSHub has no login in front, so a collector not listed here stays behind taba web's own login.
 */
const SOURCES: Record<string, number> = {
    // Runs daily; 50 hours lets one run fail, with slack for the next run's own duration, before the feed does.
    'google-images': 50 * HOUR_MS,
};

type Row = Record<string, unknown>;
export type Columns = { title: string; link: string; image?: string; guid?: string; author?: string; desc?: string; pubDate: string };

const text = (row: Row, column: string | undefined): string | undefined => {
    const v = column === undefined ? undefined : row[column];
    return v === null || v === undefined || v === '' ? undefined : String(v);
};

const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

/** taba writes timestamps in UTC without a zone (`2026-11-01 00:05:43.877`). */
export const parseTime = (s: string | undefined): Date | undefined => {
    if (s === undefined) {
        return undefined;
    }
    const zoned = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
    const d = new Date(zoned);
    return Number.isNaN(d.getTime()) ? undefined : d;
};

export const toItem = (row: Row, c: Columns): DataItem | undefined => {
    const title = text(row, c.title);
    const link = text(row, c.link);
    if (title === undefined || link === undefined || !/^https?:\/\//.test(link)) {
        return undefined;
    }
    const raw = text(row, c.image);
    // https only: another scheme in <img> could carry markup, and an http image is blocked as mixed content on FreshRSS's https page.
    const image = raw !== undefined && /^https:\/\//.test(raw) ? raw : undefined;
    const desc = text(row, c.desc);
    const body = (image ? `<img src="${escape(image)}" referrerpolicy="no-referrer">` : '') + (desc ? `<p>${escape(desc)}</p>` : '');
    return {
        title,
        link,
        // Several rows can share a page (an image search lists many images of one page), so each keeps its own guid when itemGuid names one.
        guid: text(row, c.guid) ?? link,
        author: text(row, c.author),
        pubDate: parseTime(text(row, c.pubDate)),
        image,
        description: body || undefined,
        enclosure_url: image,
        enclosure_type: image ? 'image/jpeg' : undefined,
        enclosure_length: image ? 0 : undefined,
    };
};

export const handler = async (ctx: Context): Promise<Data> => {
    const source = ctx.req.param('source') ?? '';
    const maxAge = Object.hasOwn(SOURCES, source) ? SOURCES[source] : undefined;
    if (maxAge === undefined) {
        throw new Error(`taba: ${source} is not a collector this route serves`);
    }
    const params = new URLSearchParams(ctx.req.param('routeParams') ?? '');
    const title = params.get('itemTitle');
    const link = params.get('itemLink');
    if (!title || !link) {
        throw new Error('taba: routeParams needs itemTitle=<column>&itemLink=<column>');
    }
    const columns: Columns = {
        title,
        link,
        image: params.get('itemImage') ?? undefined,
        guid: params.get('itemGuid') ?? undefined,
        author: params.get('itemAuthor') ?? undefined,
        desc: params.get('itemDesc') ?? undefined,
        pubDate: params.get('itemPubDate') ?? '_fetched_at',
    };
    const key = process.env.TABA_WEB_KEY;
    if (!key) {
        throw new Error('taba: TABA_WEB_KEY is not set');
    }

    const res = await fetch(`${WEB}/api/rows?source=${encodeURIComponent(source)}`, {
        headers: { 'x-taba-web-key': key },
        signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`taba: taba web answered ${res.status} for ${source}`);
    }
    const body = (await res.json()) as { dt: string | null; until: string | null; columns: string[]; rows: Row[] };
    if (body.dt === null || body.columns.length === 0) {
        throw new Error(`taba: ${source} has no data yet`);
    }
    // until is the newest run id (20261101T000509Z); a stopped collector would otherwise serve its last day forever.
    const run = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(body.until ?? '');
    if (!run) {
        throw new Error(`taba: taba web gave no run id for ${source}`);
    }
    const ranAt = Date.UTC(+run[1], +run[2] - 1, +run[3], +run[4], +run[5], +run[6]);
    if (Date.now() - ranAt > maxAge) {
        throw new Error(`taba: the newest run of ${source} is ${Math.round((Date.now() - ranAt) / HOUR_MS)} hours old; the collector stopped`);
    }
    // A column name the collector does not have would empty every item silently; name it instead.
    for (const column of Object.values(columns)) {
        if (column !== undefined && !body.columns.includes(column)) {
            throw new Error(`taba: ${source} has no column ${column}`);
        }
    }
    // Only the newest run: a second run on the same day replaces the first, whose rows would otherwise stay in the feed (thumbnails taken before a settings change, for one).
    const newest = body.rows.filter((row) => (parseTime(text(row, '_fetched_at'))?.getTime() ?? 0) >= ranAt);
    if (newest.length === 0) {
        throw new Error(`taba: none of the ${body.rows.length} rows of ${source} on ${body.dt} carries a _fetched_at at or after the newest run ${body.until}`);
    }
    // One run can repeat a guid (the same image under two queries), and FreshRSS permanently degrades how it tells a feed's items apart when one fetch does.
    const items = new Map<string, DataItem>();
    for (const row of newest) {
        const item = toItem(row, columns);
        if (item && !items.has(item.guid as string)) {
            items.set(item.guid as string, item);
        }
    }
    if (items.size === 0) {
        throw new Error(`taba: none of the ${newest.length} rows of ${source}'s run ${body.until} has a title and an http(s) link`);
    }
    return {
        title: params.get('title') ?? `taba ${source}`,
        link: 'https://taba.takashiaihara.site/',
        description: `taba ${source}, run ${body.until}`,
        item: [...items.values()],
    };
};

export const route: Route = {
    path: '/rows/:source/:routeParams',
    name: 'Rows of a collector',
    maintainers: ['TakashiAihara'],
    handler,
    example: '/taba/rows/google-images/itemTitle=title&itemLink=page_url&itemImage=thumbnail_url&itemGuid=doc_id&itemAuthor=source&itemDesc=query',
    parameters: {
        source: 'The collector name, as in taba web; only those listed in SOURCES',
        routeParams:
            'A query string naming columns: itemTitle and itemLink (required), itemImage, itemGuid, itemAuthor, itemDesc, itemPubDate (default _fetched_at, read as UTC), and title (the feed title itself)',
    },
    description:
        "The rows of the collector's newest run (by `_fetched_at`), one item per guid, read from the first 1000 of its newest day (UTC). Only collectors listed in the route are served. A column the collector does not have, or a newest run older than the collector's limit, fails the feed",
    categories: ['other'],
    features: {
        requireConfig: [{ name: 'TABA_WEB_KEY', description: 'The key taba web on taba1 checks in x-taba-web-key (Infisical home/prod TABA_WEB_KEY)' }],
    },
};
