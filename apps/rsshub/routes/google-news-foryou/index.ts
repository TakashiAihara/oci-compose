import type { Data, DataItem, Route } from '@/types';
import logger from '@/utils/logger';

const ORIGIN = 'https://news.google.com';
const PAGE = `${ORIGIN}/foryou?hl=ja&gl=JP&ceid=JP:ja`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
/** The tab stops handing out continuation tokens at 200 articles (8 pages after the first, 2026-10-25), so this only bounds a token that never ends. */
const MAX_PAGES = 12;
/** Per request; upstream's global fetch has no timeout, and a stalled Google answer would hold the route forever. */
const TIMEOUT_MS = 20000;

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
        pubDate: ts,
    };
};

const pick = (html: string, re: RegExp, what: string): string => {
    const m = html.match(re);
    if (!m) {
        throw new Error(`google-news-foryou: ${what} not found in the page; signed out (refresh GOOGLE_COOKIE) or the page layout changed`);
    }
    return m[1];
};

/** SyntaxError quotes the input, which here is signed-in page data; the message names the part instead. */
const parse = <T>(text: string, what: string): T => {
    try {
        return JSON.parse(text) as T;
    } catch {
        throw new Error(`google-news-foryou: ${what} is not JSON; the data layout changed`);
    }
};

/** fetch errors quote an invalid header value whole, which would put the cookie in the log and the error page; this keeps only the kind. */
const get = async (url: string, init: RequestInit, what: string): Promise<Response> => {
    try {
        return await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
        throw new Error(`google-news-foryou: ${what} failed (${error instanceof Error ? error.name : 'error'})`);
    }
};

export const handler = async (): Promise<Data> => {
    // Trimmed: a value pasted with a trailing newline is an invalid header and the error would echo the whole cookie.
    // A pasted `cookie:` header name would turn the first cookie into `cookie: SID` and sign the request out.
    const cookie = (process.env.GOOGLE_COOKIE ?? '').trim().replace(/^cookie:\s*/i, '');
    if (!cookie) {
        throw new Error('google-news-foryou: GOOGLE_COOKIE is not set');
    }
    if (!/^[\x20-\x7e]+$/.test(cookie)) {
        throw new Error('google-news-foryou: GOOGLE_COOKIE has a line break or a non-ASCII character; paste the value again on one line');
    }
    const headers = { cookie, 'user-agent': UA, 'accept-language': 'ja' };

    // manual: a dead cookie answers with a redirect to the sign-in page, which must fail the feed rather than read as an empty tab.
    const res = await get(PAGE, { headers }, 'the For you page');
    if (res.status !== 200) {
        throw new Error(`google-news-foryou: ${PAGE} answered ${res.status} ${res.headers.get('location')?.startsWith('https://accounts.google.com') ? '(signed out: refresh GOOGLE_COOKIE)' : ''}`);
    }
    const html = await res.text();

    const at = pick(html, /"SNlM0e":"([^"]+)"/, 'XSRF token');
    const fsid = pick(html, /"FdrFJe":"([^"]+)"/, 'session id');
    const bl = pick(html, /"cfb2h":"([^"]+)"/, 'build label');
    const template = parse<unknown[]>(pick(html, /'ds:0' : \{id:'JqDnie',request:(\[.*?\])\}/, 'request template'), 'request template');
    const first = parse<unknown[][]>(pick(html, /AF_initDataCallback\(\{key: 'ds:0'.*?data:(.*?), sideChannel/s, 'initial data'), 'initial data');

    const articles = new Map<string, Article>();
    collect(first, articles);

    // The page asks for more with the token of the last answer and an offset that grows by 10 from 11, as its own scrolling does.
    // Without the first token the feed would quietly stop at the first page; that is a layout change, not a short tab.
    let token = first[1]?.[1];
    if (typeof token !== 'string') {
        throw new Error('google-news-foryou: no continuation token in the initial data; the data layout changed');
    }
    let page = 0;
    for (let offset = 11; page < MAX_PAGES && typeof token === 'string'; page++, offset += 10) {
        // A later page failing keeps what was read: only that page is lost, and the log says so.
        try {
            const qs = new URLSearchParams({ rpcids: 'JqDnie', 'source-path': '/foryou', 'f.sid': fsid, bl, hl: 'ja', gl: 'JP', rt: 'c' });
            const body = new URLSearchParams({ 'f.req': JSON.stringify([[['JqDnie', JSON.stringify([...template.slice(0, 2), token, offset]), null, 'generic']]]), at });
            const more = await get(`${ORIGIN}/_/DotsSplashUi/data/batchexecute?${qs}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, body }, `page ${page + 1}`);
            if (more.status !== 200) {
                throw new Error(`google-news-foryou: page ${page + 1} answered ${more.status}`);
            }
            const line = (await more.text()).split('\n').find((l) => l.startsWith('[["wrb.fr"'));
            const wrapped = line ? parse<unknown[][]>(line, `page ${page + 1}`)[0]?.[2] : undefined;
            if (typeof wrapped !== 'string') {
                throw new Error(`google-news-foryou: page ${page + 1} had no JqDnie answer`);
            }
            const answer = parse<unknown[][]>(wrapped, `page ${page + 1}`);
            collect(answer, articles);
            token = answer[1]?.[1];
        } catch (error) {
            logger.warn(`${error instanceof Error ? error.message : error}; serving the ${articles.size} articles read so far`);
            break;
        }
    }
    if (page === MAX_PAGES) {
        logger.warn(`google-news-foryou: stopped at MAX_PAGES (${MAX_PAGES}) with a token left`);
    }

    // An empty tab means the data moved, not that there is no news; publishing it would look like a working feed.
    if (articles.size === 0) {
        throw new Error('google-news-foryou: no article found; the data layout changed');
    }
    return {
        title: 'Google ニュース おすすめ',
        link: PAGE,
        // Readers key items on the link; one story under two ids would show twice.
        item: [...new Map([...articles.values()].map((a) => [a[6] as string, toItem(a)])).values()],
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
