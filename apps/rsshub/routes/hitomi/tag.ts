import type { Context } from 'hono';

import type { Data, DataItem, Route } from '@/types';
import cache from '@/utils/cache';
import logger from '@/utils/logger';

import { HASH } from './thumb';

const LTN = 'https://ltn.gold-usergeneratedcontent.net';
const SITE = 'https://hitomi.la';
/** The browser opening FreshRSS loads thumbnails from here; FreshRSS itself reads the feed at http://rsshub:1200, which the browser cannot reach. */
const THUMB = 'https://rsshub.takashiaihara.site/hitomi/thumb';
/** Newest first; each id is 4 bytes, so this many ids is one small Range request. */
const LIMIT = 25;
const TIMEOUT_MS = 20000;
/** Galleries fetched at once when the cache is cold, so 25 misses take about 5 round trips instead of 25. */
const CONCURRENCY = 5;

type Gallery = {
    id: string;
    title: string;
    type: string;
    language: string | null;
    date: string;
    galleryurl: string;
    files: { hash?: string }[];
    artists: { artist: string }[] | null;
    tags: { tag: string; female?: string | number; male?: string | number }[] | null;
};

/** The list is big-endian uint32 gallery ids in the order they were added, not in id order. */
export const parseIds = (buf: ArrayBuffer): number[] => {
    const view = new DataView(buf);
    const ids: number[] = [];
    for (let i = 0; i + 4 <= buf.byteLength; i += 4) {
        ids.push(view.getUint32(i));
    }
    return ids;
};

/** `2026-10-24 23:56:00-05` has an hour-only offset, which Date does not read. */
export const parseDate = (s: string): Date | undefined => {
    const d = new Date(s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
    return Number.isNaN(d.getTime()) ? undefined : d;
};

const tagName = (t: NonNullable<Gallery['tags']>[number]): string => (Number(t.female) ? `female:${t.tag}` : Number(t.male) ? `male:${t.tag}` : t.tag);

export const toItem = (g: Gallery): DataItem => {
    const tags = (g.tags ?? []).map(tagName);
    const artists = (g.artists ?? []).map((a) => a.artist);
    // Through thumb.ts, which adds the Referer the thumbnail host demands. The hash goes into an attribute, so only a hex hash is let through.
    const hash = g.files[0]?.hash;
    const image = hash && HASH.test(hash) ? `${THUMB}/${hash}` : undefined;
    const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
    // A value not starting with / would turn SITE into userinfo and point the link at another host.
    if (!g.galleryurl.startsWith('/')) {
        throw new Error(`hitomi: gallery ${g.id} has an unexpected galleryurl`);
    }
    return {
        title: g.title,
        link: `${SITE}${g.galleryurl}`,
        guid: `hitomi-${g.id}`,
        pubDate: parseDate(g.date),
        author: artists.join(', ') || undefined,
        category: tags,
        image,
        description: `${image ? `<p><img src="${image}"></p>` : ''}<p>${esc(g.type)} / ${esc(g.language ?? '-')} / ${g.files.length}p</p><p>${tags.map(esc).join(', ')}</p>`,
    };
};

const get = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
        throw new Error(`hitomi: ${url} answered ${res.status}`);
    }
    return res;
};

export const handler = async (ctx: Context): Promise<Data> => {
    const tag = ctx.req.param('tag');
    const language = ctx.req.param('language') ?? 'all';
    if (!/^[a-z]+$/.test(language)) {
        throw new Error('hitomi: language must be lowercase letters, like all or japanese');
    }

    // identity: a Range of a gzip response comes back as a fragment that does not inflate. A missing tag answers 404 and fails the feed.
    const list = await get(`${LTN}/tag/${encodeURIComponent(tag)}-${language}.nozomi`, { headers: { range: `bytes=0-${LIMIT * 4 - 1}`, 'accept-encoding': 'identity' } });
    // A 200 means the Range was ignored and the body is the whole list, megabytes for a popular tag; stop before reading it.
    if (list.status !== 206) {
        await list.body?.cancel();
        throw new Error(`hitomi: the list of ${tag} answered ${list.status} instead of 206; the site no longer honours Range`);
    }
    const ids = parseIds(await list.arrayBuffer()).slice(0, LIMIT);
    if (ids.length === 0) {
        throw new Error(`hitomi: the list of ${tag} is empty`);
    }

    // Each gallery only once while cached, so a refresh asks the site for the new ids only.
    // refresh=false: a hit must not extend the entry, or a gallery staying in the list would never pick up a corrected title or tags.
    const load = (id: number) =>
        cache.tryGet(
            `hitomi:gallery:${id}`,
            async () => {
                const js = await (await get(`${LTN}/galleries/${id}.js`)).text();
                return toItem(JSON.parse(js.slice(js.indexOf('{'))) as Gallery);
            },
            undefined,
            false
        );
    const results: PromiseSettledResult<DataItem>[] = [];
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
        results.push(...(await Promise.allSettled(ids.slice(i, i + CONCURRENCY).map(load))));
    }
    // A gallery just removed or not yet on the CDN drops only itself; all of them failing is the site, not one gallery.
    const item = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    const failed = results.flatMap((r) => (r.status === 'rejected' ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : []));
    if (item.length === 0) {
        throw new Error(`hitomi: no gallery of ${tag} could be read; ${failed[0]}`);
    }
    if (failed.length > 0) {
        logger.warn(`hitomi: skipped ${failed.length} of ${ids.length} galleries of ${tag}; ${failed[0]}`);
    }

    return {
        title: `hitomi: ${tag} (${language})`,
        link: `${SITE}/tag/${encodeURIComponent(tag)}-${language}.html`,
        item,
    };
};

export const route: Route = {
    path: '/tag/:tag/:language?',
    name: 'Tag',
    maintainers: ['TakashiAihara'],
    handler,
    example: '/hitomi/tag/female:big breasts/japanese',
    parameters: { tag: 'Tag as in the site URL, with its female: / male: prefix', language: 'all (default) or a language such as japanese' },
    categories: ['anime'],
};
