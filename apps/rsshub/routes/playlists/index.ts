import { load } from 'cheerio';

import type { Data, DataItem, Route } from '@/types';
import logger from '@/utils/logger';

const SITE = 'https://playlists.sakura.ne.jp';
const TIMEOUT_MS = 20000;
/** An entry id is `<SITE>/?mode=author&code=<author>#ISBN<isbn>`; the author page names its cover `image/cover_thumbnail/<author>_<isbn>.jpg`. */
const ID = /[?&]code=([a-z0-9_]+)#ISBN([0-9X-]+)$/;

/** Built from the id instead of read off the author page: all 5 entries of 2026-10-27 resolved this way, and it costs no request per entry. */
export const coverOf = (id: string): string | undefined => {
    const m = ID.exec(id);
    return m ? `${SITE}/image/cover_thumbnail/${m[1]}_${m[2]}.jpg` : undefined;
};

export const handler = async (): Promise<Data> => {
    const res = await fetch(`${SITE}/atom.xml`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
        throw new Error(`playlists: atom.xml answered ${res.status}`);
    }
    const $ = load(await res.text(), { xml: true });
    const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;');

    const item: DataItem[] = $('entry')
        .toArray()
        .map((e) => {
            const entry = $(e);
            const id = entry.children('id').text();
            const image = coverOf(id);
            const summary = entry.children('summary').text();
            return {
                title: entry.children('title').text(),
                link: entry.children('link').attr('href'),
                guid: id,
                pubDate: entry.children('published').text() || undefined,
                image,
                description: `${image ? `<p><img src="${image}"></p>` : ''}<p>${esc(summary)}</p>`,
                enclosure_url: image,
                enclosure_type: image ? 'image/jpeg' : undefined,
                enclosure_length: image ? 0 : undefined,
            };
        });
    if (item.length === 0) {
        throw new Error('playlists: atom.xml has no entry');
    }
    if (!item.some((i) => i.image)) {
        logger.warn('playlists: no entry id carries code and ISBN; the id format moved');
    }

    return {
        title: 'プレイ・リスト',
        link: `${SITE}/`,
        language: 'ja',
        item,
    };
};

export const route: Route = {
    path: '/',
    name: 'New books',
    maintainers: ['TakashiAihara'],
    handler,
    example: '/playlists',
    categories: ['anime'],
};
