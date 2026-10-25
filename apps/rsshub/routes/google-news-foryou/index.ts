import type { Data, DataItem, Route } from '@/types';

const ORIGIN = 'https://news.google.com';
const PAGE = `${ORIGIN}/foryou?hl=ja&gl=JP&ceid=JP:ja`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
/** The tab stops handing out continuation tokens at 200 articles (8 pages after the first, 2026-10-25), so this only bounds a token that never ends. */
const MAX_PAGES = 12;

type Article = unknown[];

/** An article is the array whose [1][1] is its CBMi id, [2] the title, [4][0] epoch seconds, [6] the source URL and [10][2] the publisher. */
const isArticle = (x: unknown[]): boolean =>
    x.length > 10 &&
    Array.isArray(x[1]) &&
    typeof x[1][1] === 'string' &&
    x[1][1].startsWith('CBMi') &&
    typeof x[2] === 'string' &&
    typeof x[6] === 'string' &&
    x[6].startsWith('http');

export const collect = (x: unknown, out: Map<string, Article>): void => {
    if (!Array.isArray(x)) {
        return;
    }
    if (isArticle(x)) {
        const id = (x[1] as string[])[1];
        if (!out.has(id)) {
            out.set(id, x);
        }
    }
    for (const y of x) {
        collect(y, out);
    }
};

export const toItem = (a: Article): DataItem => {
    const ts = Array.isArray(a[4]) && typeof a[4][0] === 'number' ? new Date(a[4][0] * 1000) : undefined;
    const publisher = Array.isArray(a[10]) && typeof a[10][2] === 'string' ? a[10][2] : undefined;
    return {
        title: a[2] as string,
        link: a[6] as string,
        author: publisher,
        description: publisher,
        pubDate: ts,
    };
};

const pick = (html: string, re: RegExp, what: string): string => {
    const m = html.match(re);
    if (!m) {
        throw new Error(`google-news-foryou: ${what} not found in the page; the page layout changed`);
    }
    return m[1];
};

export const handler = async (): Promise<Data> => {
    // Trimmed: a value pasted with a trailing newline is an invalid header and the error would echo the whole cookie.
    const cookie = (process.env.GOOGLE_COOKIE ?? '').trim();
    if (!cookie) {
        throw new Error('google-news-foryou: GOOGLE_COOKIE is not set');
    }
    const headers = { cookie, 'user-agent': UA, 'accept-language': 'ja' };

    // manual: a dead cookie answers with a redirect to the sign-in page, which must fail the feed rather than read as an empty tab.
    const res = await fetch(PAGE, { headers, redirect: 'manual' });
    if (res.status !== 200) {
        throw new Error(`google-news-foryou: ${PAGE} answered ${res.status} ${res.headers.get('location')?.startsWith('https://accounts.google.com') ? '(signed out: refresh GOOGLE_COOKIE)' : ''}`);
    }
    const html = await res.text();

    const at = pick(html, /"SNlM0e":"([^"]+)"/, 'XSRF token');
    const fsid = pick(html, /"FdrFJe":"([^"]+)"/, 'session id');
    const bl = pick(html, /"cfb2h":"([^"]+)"/, 'build label');
    const template = JSON.parse(pick(html, /'ds:0' : \{id:'JqDnie',request:(\[.*?\])\}/, 'request template')) as unknown[];
    const first = JSON.parse(pick(html, /AF_initDataCallback\(\{key: 'ds:0'.*?data:(.*?), sideChannel/s, 'initial data')) as unknown[][];

    const articles = new Map<string, Article>();
    collect(first, articles);

    // The page asks for more with the token of the last answer and an offset that grows by 10 from 11, as its own scrolling does.
    let token = first[1]?.[1];
    for (let page = 0, offset = 11; page < MAX_PAGES && typeof token === 'string'; page++, offset += 10) {
        const qs = new URLSearchParams({ rpcids: 'JqDnie', 'source-path': '/foryou', 'f.sid': fsid, bl, hl: 'ja', gl: 'JP', rt: 'c' });
        const body = new URLSearchParams({ 'f.req': JSON.stringify([[['JqDnie', JSON.stringify([...template.slice(0, 2), token, offset]), null, 'generic']]]), at });
        const more = await fetch(`${ORIGIN}/_/DotsSplashUi/data/batchexecute?${qs}`, {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body,
            redirect: 'manual',
        });
        if (more.status !== 200) {
            throw new Error(`google-news-foryou: page ${page + 1} answered ${more.status}`);
        }
        const line = (await more.text()).split('\n').find((l) => l.startsWith('[["wrb.fr"'));
        if (!line) {
            throw new Error(`google-news-foryou: page ${page + 1} had no JqDnie answer`);
        }
        const answer = JSON.parse(JSON.parse(line)[0][2]) as unknown[][];
        collect(answer, articles);
        token = answer[1]?.[1];
    }

    // An empty tab means the data moved, not that there is no news; publishing it would look like a working feed.
    if (articles.size === 0) {
        throw new Error('google-news-foryou: no article found; the data layout changed');
    }
    return {
        title: 'Google ニュース おすすめ',
        link: PAGE,
        item: [...articles.values()].map(toItem),
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
        requireConfig: [{ name: 'GOOGLE_COOKIE', description: 'Cookie header of a signed-in news.google.com request' }],
    },
};
