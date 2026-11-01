import type { Context } from 'hono';

import type { Data, DataItem, Route } from '@/types';

/** taba web on taba1, reached over the site-to-site link; it serves only oi1's address carrying x-taba-web-key. */
const WEB = 'http://192.168.0.182:8790';
const TIMEOUT_MS = 30000;
const SOURCE = /^[\w-]+$/;

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
    // Only http(s) goes into <img>, so a row cannot put another scheme in the description.
    const image = raw !== undefined && /^https?:\/\//.test(raw) ? raw : undefined;
    const desc = text(row, c.desc);
    const body = (image ? `<img src="${escape(image)}" referrerpolicy="no-referrer">` : '') + (desc ? `<p>${escape(desc)}</p>` : '');
    return {
        title,
        link,
        // Several rows can share a page (an image search lists many images of one page), so each keeps its own guid.
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
    if (!SOURCE.test(source)) {
        throw new Error('taba: source must be a collector name');
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
    const body = (await res.json()) as { dt: string | null; columns: string[]; rows: Row[] };
    if (body.dt === null) {
        throw new Error(`taba: ${source} has no data yet`);
    }
    // A column name the collector does not have would empty every item silently; name it instead.
    for (const column of Object.values(columns)) {
        if (column !== undefined && !body.columns.includes(column)) {
            throw new Error(`taba: ${source} has no column ${column}`);
        }
    }
    const items = body.rows.map((row) => toItem(row, columns)).filter((i): i is DataItem => i !== undefined);
    if (items.length === 0) {
        throw new Error(`taba: none of the ${body.rows.length} rows of ${source} on ${body.dt} has a title and an http(s) link`);
    }
    return {
        title: params.get('title') ?? `taba ${source}`,
        link: 'https://taba.takashiaihara.site/',
        description: `taba ${source}, rows of ${body.dt} (UTC)`,
        item: items,
    };
};

export const route: Route = {
    path: '/rows/:source/:routeParams',
    name: 'Rows of a collector',
    maintainers: ['TakashiAihara'],
    handler,
    example: '/taba/rows/google-images/itemTitle=title&itemLink=page_url&itemImage=thumbnail_url&itemGuid=doc_id&itemAuthor=source&itemDesc=query',
    parameters: {
        source: 'The collector name, as in taba web',
        routeParams:
            'A query string naming columns: itemTitle and itemLink (required), itemImage, itemGuid, itemAuthor, itemDesc, itemPubDate (default _fetched_at, read as UTC), and title (the feed title itself)',
    },
    description: "The newest day (UTC) of the collector's rows, newest run first, up to 1000 (taba web's page). A column the collector does not have fails the feed",
    categories: ['other'],
    features: {
        requireConfig: [{ name: 'TABA_WEB_KEY', description: 'The key taba web on taba1 checks in x-taba-web-key (Infisical home/prod TABA_WEB_KEY)' }],
    },
};
