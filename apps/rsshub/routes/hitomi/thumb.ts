import type { Context } from 'hono';

import type { Route } from '@/types';

export const HASH = /^[\da-f]{64}$/;
const TIMEOUT_MS = 20000;

/** The big thumbnail of a gallery's first page; the host only exists for the first and middle pages. */
export const thumbUrl = (hash: string): string => `https://tn.gold-usergeneratedcontent.net/avifbigtn/${hash.slice(-1)}/${hash.slice(-3, -1)}/${hash}.avif`;

export const handler = async (ctx: Context): Promise<Response> => {
    const hash = ctx.req.param('hash');
    // Only a hash reaches the URL, so the route cannot be turned into a proxy for anything else.
    if (!HASH.test(hash)) {
        return new Response('not a hash', { status: 400 });
    }
    // The thumbnail host answers 404 unless the Referer is hitomi.la, which a reader's browser does not send.
    const res = await fetch(thumbUrl(hash), { headers: { referer: 'https://hitomi.la/' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok || !res.body) {
        return new Response(`thumbnail answered ${res.status}`, { status: res.status === 404 ? 404 : 502 });
    }
    // A hash names one image forever, so the browser may keep it.
    return new Response(res.body, { headers: { 'content-type': res.headers.get('content-type') ?? 'image/avif', 'cache-control': 'public, max-age=2592000, immutable' } });
};

export const route: Route = {
    path: '/thumb/:hash',
    name: 'Thumbnail',
    maintainers: ['TakashiAihara'],
    handler,
    example: '/hitomi/thumb/0000000000000000000000000000000000000000000000000000000000000000',
    parameters: { hash: 'The hash of a page, from a gallery JSON' },
    categories: ['anime'],
};
