import { createHash, createHmac } from 'node:crypto';

import type { Context } from 'hono';

import type { Data, DataItem, Route } from '@/types';

const BUCKET = 'taba-feeds';
const TIMEOUT_MS = 20000;
const HOUR_MS = 60 * 60 * 1000;

type FeedItem = { title: string; link: string; guid: string; image?: string; author?: string; desc?: string; pubDate?: string };
type Feed = { title: string; stale_after_hours: number; run: string; items: FeedItem[] };

const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

const toItem = (item: FeedItem): DataItem => {
    const body = (item.image ? `<img src="${escape(item.image)}" referrerpolicy="no-referrer">` : '') + (item.desc ? `<p>${escape(item.desc)}</p>` : '');
    return {
        title: item.title,
        link: item.link,
        guid: item.guid,
        author: item.author,
        pubDate: item.pubDate ? new Date(item.pubDate) : undefined,
        image: item.image,
        description: body || undefined,
        enclosure_url: item.image,
        enclosure_type: item.image ? 'image/jpeg' : undefined,
        enclosure_length: item.image ? 0 : undefined,
    };
};

const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest();

/** An S3 GET signed with SigV4. RSSHub has no S3 client among its dependencies, and this is the only call. */
export const signedGet = (url: URL, keyId: string, secret: string, now: Date) => {
    const stamp = now.toISOString().replaceAll(/[:-]|\.\d{3}/g, '');
    const day = stamp.slice(0, 8);
    const scope = `${day}/auto/s3/aws4_request`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonical = ['GET', url.pathname, '', `host:${url.host}`, 'x-amz-content-sha256:UNSIGNED-PAYLOAD', `x-amz-date:${stamp}`, '', signedHeaders, 'UNSIGNED-PAYLOAD'].join('\n');
    const toSign = ['AWS4-HMAC-SHA256', stamp, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${secret}`, day), 'auto'), 's3'), 'aws4_request');
    const signature = hmac(signingKey, toSign).toString('hex');
    return {
        authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
        'x-amz-date': stamp,
    };
};

export const handler = async (ctx: Context): Promise<Data> => {
    const source = ctx.req.param('source') ?? '';
    // Goes into the object key, so no / or .. can reach another key. The key below reads only this bucket of feeds.
    if (!/^[a-z0-9-]+$/.test(source)) {
        throw new Error(`taba: ${source} is not a collector name`);
    }
    const { TABA_FEEDS_R2_ACCESS_KEY_ID: keyId, TABA_FEEDS_R2_SECRET_ACCESS_KEY: secret, TABA_FEEDS_R2_ENDPOINT: endpoint } = process.env;
    if (!keyId || !secret || !endpoint) {
        throw new Error('taba: TABA_FEEDS_R2_ACCESS_KEY_ID, TABA_FEEDS_R2_SECRET_ACCESS_KEY and TABA_FEEDS_R2_ENDPOINT must be set');
    }

    const url = new URL(`/${BUCKET}/${source}.json`, endpoint);
    const res = await fetch(url, { headers: signedGet(url, keyId, secret, new Date()), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) {
        throw new Error(`taba: R2 answered ${res.status} for ${source}`);
    }
    const feed = (await res.json()) as Feed;

    // run is the newest run id (20261101T000509Z); a stopped collector would otherwise serve its last run forever.
    const run = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(feed.run ?? '');
    if (!run) {
        throw new Error(`taba: the feed of ${source} has no run id`);
    }
    const ranAt = Date.UTC(+run[1], +run[2] - 1, +run[3], +run[4], +run[5], +run[6]);
    if (Date.now() - ranAt > feed.stale_after_hours * HOUR_MS) {
        throw new Error(`taba: the newest run of ${source} is ${Math.round((Date.now() - ranAt) / HOUR_MS)} hours old; the collector stopped`);
    }

    return {
        title: feed.title,
        link: 'https://taba.takashiaihara.site/',
        description: `taba ${source}, run ${feed.run}`,
        item: feed.items.map((item) => toItem(item)),
    };
};

export const route: Route = {
    // routeParams is unread: FreshRSS is subscribed to this URL with it, and keeping the URL keeps the feed's read state.
    path: '/rows/:source/:routeParams?',
    name: 'Rows of a collector',
    maintainers: ['TakashiAihara'],
    handler,
    example: '/taba/rows/google-images',
    parameters: {
        source: 'The collector name, one with a [feeds] table in taba.toml',
        routeParams: 'Unread',
    },
    description: "The items of the collector's newest run, from the JSON file taba writes to the R2 bucket taba-feeds after each run. The mapping from columns to items lives in taba's taba.toml.",
    categories: ['other'],
    features: {
        requireConfig: [
            { name: 'TABA_FEEDS_R2_ACCESS_KEY_ID', description: 'R2 key that reads only the bucket taba-feeds (Infisical home/prod)' },
            { name: 'TABA_FEEDS_R2_SECRET_ACCESS_KEY', description: 'Its secret (Infisical home/prod)' },
            { name: 'TABA_FEEDS_R2_ENDPOINT', description: 'The S3 endpoint of the R2 account (Infisical home/prod CLOUDFLARE_S3_API_ENDPOINT)' },
        ],
    },
};
