import { load } from 'cheerio';

import type { Data, DataItem, Route } from '@/types';

const SITE = 'https://playlists.sakura.ne.jp';
const TIMEOUT_MS = 20000;
/** An entry id is `<SITE>/?mode=author&code=<author>#ISBN<isbn>`; the author page names its cover `image/cover_thumbnail/<author>_<isbn>.jpg`. */
const ID = /[?&]code=([a-z0-9_]+)#ISBN([0-9X-]+)$/;

/**
 * Built from the id instead of read off the author page, so no request per entry: the rule held for all 46 covers on the site's pages (2002-2026, 10- and 13-digit ISBNs, a trailing X).
 * The regex's character sets are also what keep the URL safe inside the src attribute.
 */
const coverOf = (id: string): string | undefined => {
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
            const id = entry.children('id').text().trim();
            const image = coverOf(id);
            const summary = entry.children('summary').text();
            return {
                title: entry.children('title').text(),
                // The id is the author page with the book's anchor; the entry's link is only the top of that page, which lists all of the author's books.
                link: id,
                guid: id,
                pubDate: entry.children('published').text() || entry.children('updated').text() || undefined,
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
    // Fail rather than serve a feed without covers; a warning in the log is read by nobody.
    if (!item.some((i) => i.image)) {
        throw new Error('playlists: no entry id carries an author code and ISBN; the id format moved');
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
    name: 'Reviews',
    maintainers: ['TakashiAihara'],
    handler,
    example: '/playlists',
    categories: ['reading'],
    features: { nsfw: true },
};
