import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Context } from 'hono';
import { JSDOM } from 'jsdom';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import type { Data, DataItem, Route } from '@/types';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';

const execFileAsync = promisify(execFile);

/**
 * Lightpanda, not Chromium: it rendered the same client-side page (kaggle's competition list, 37 links
 * against Chromium's 36) in about 160MiB RSS, where Chromium took 726MiB PSS (2026-10-14, vault PR #991).
 */
const LIGHTPANDA = 'lightpanda';
/** Budget for the page load and the settle wait together. */
const RENDER_TIMEOUT = 30000;
/** The page's scripts are stopped this long after the wait gives up, so a run-out wait reports Timeout, not the ScriptError a shared deadline gives. */
const TERMINATE_GRACE = 2000;
/**
 * Default for `settle`: a gap this long with no new `item` match is read as the list having finished painting.
 * Each feed can shorten it; a page that paints in steps can be cut short by a gap shorter than its steps.
 */
const SETTLE_MS = 1500;

type Rules = { item: string; itemTitle: string; itemLink: string; itemDesc: string | null; itemPubDate: string | null };
type Extracted = { title: string; link: string | null; description: string | null; pubDate: string | null };
/** The parts of `lightpanda fetch --json` this route reads. */
type FetchResult = { url: string; http_status: number; error: string | null; content: string | null };

/**
 * Evaluated by Lightpanda until it returns true. The first match alone would cut a list that is still being
 * appended, so it waits for the number of matches to stop moving.
 */
const settleScript = (item: string, settleMs: number): string =>
    `(() => {
        const count = document.evaluate(${JSON.stringify(item)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength;
        const now = Date.now();
        const seen = window.rsshubRenderMatches;
        if (seen === undefined || seen.count !== count) {
            window.rsshubRenderMatches = { count, changedAt: now };
            return false;
        }
        return count > 0 && now - seen.changedAt >= ${settleMs};
    })()`;

/** Reads the rendered DOM with XPath; Lightpanda hands back markup, and jsdom gives it `document.evaluate` again. */
const extract = (window: JSDOM['window'], rules: Rules): Extracted[] => {
    const { document, XPathResult, Element } = window;
    const snapshot = document.evaluate(rules.item, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    const items: Extracted[] = [];
    for (let i = 0; i < snapshot.snapshotLength; i++) {
        const context = snapshot.snapshotItem(i)!;
        const values: Array<string | null> = [];
        for (const [xpath, asHtml] of [
            [rules.itemTitle, false],
            [rules.itemLink, false],
            [rules.itemDesc, true],
            [rules.itemPubDate, false],
        ] as Array<[string | null, boolean]>) {
            const node = xpath === null ? null : document.evaluate(xpath, context, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
            // A text or attribute node reads as its value; an element reads as its text, or as its markup for the description.
            values.push(node === null ? null : asHtml && node instanceof Element ? node.innerHTML : node.textContent);
        }
        const [title, link, description, pubDate] = values;
        items.push({ title: (title ?? '').replace(/\s+/g, ' ').trim(), link, description, pubDate });
    }
    return items;
};

const render = async (url: string, item: string, settleMs: number): Promise<FetchResult> => {
    const args = [
        'fetch',
        url,
        '--json',
        '--dump',
        'html',
        '--with-base',
        '--strip-mode',
        'js',
        // A URL from the subscription must not reach the coolify network, the host or the cloud metadata service; checked after DNS, so redirects are covered too.
        '--block-private-networks',
        // Not private by its list, but internal in practice: carrier-grade NAT (tailnets) and the benchmarking range.
        '--block-cidrs',
        '100.64.0.0/10',
        '--block-cidrs',
        '198.18.0.0/15',
        '--wait-script',
        settleScript(item, settleMs),
        '--wait-ms',
        String(RENDER_TIMEOUT),
        '--terminate-ms',
        String(RENDER_TIMEOUT + TERMINATE_GRACE),
    ];
    let stdout: string;
    let killedBy = '0';
    try {
        ({ stdout } = await execFileAsync(LIGHTPANDA, args, { timeout: RENDER_TIMEOUT + 10000, maxBuffer: 64 * 1024 * 1024 }));
    } catch (error) {
        // Exit 1 also means "the wait ran out", which still leaves a dump on stdout; anything without one is a real failure.
        // The message is rebuilt, since execFile's own repeats the whole argument list, settle script included.
        const { stdout: partial, stderr, signal, code } = error as { stdout?: string; stderr?: string; signal?: string | null; code?: unknown };
        killedBy = String(signal ?? code);
        if (!partial) {
            throw new Error(`render: lightpanda failed on ${url} (${killedBy}): ${(stderr ?? '').trim().split('\n').slice(-3).join(' | ')}`);
        }
        stdout = partial;
    }
    try {
        return JSON.parse(stdout) as FetchResult;
    } catch {
        throw new Error(`render: lightpanda gave no JSON for ${url} (${stdout.length} bytes, exit ${killedBy})`);
    }
};

export const handler = async (ctx: Context): Promise<Data> => {
    // A browser that fetches any URL it is handed reaches whatever this container can, so it sits behind the same switch as upstream's transform routes.
    if (!config.feature.allow_user_supply_unsafe_domain) {
        throw new ConfigNotFoundError(`This RSS is disabled unless 'ALLOW_USER_SUPPLY_UNSAFE_DOMAIN' is set to 'true'.`);
    }
    const url = ctx.req.param('url') ?? '';
    if (!/^https?:\/\//.test(url)) {
        throw new Error(`render: only http(s) URLs are rendered, got ${url}`);
    }
    const params = new URLSearchParams(ctx.req.param('routeParams') ?? '');
    const item = params.get('item');
    if (!item) {
        throw new Error('render: routeParams needs item=<XPath>');
    }
    const rules: Rules = {
        item,
        itemTitle: params.get('itemTitle') || '.',
        itemLink: params.get('itemLink') || '(./@href | .//a/@href)[1]',
        // `itemDesc=` with no value means "none", not an empty XPath, which document.evaluate rejects.
        itemDesc: params.get('itemDesc') || null,
        itemPubDate: params.get('itemPubDate') || null,
    };
    const settleParam = params.get('settle');
    const settleMs = settleParam ? Number(settleParam) : SETTLE_MS;
    if (!Number.isInteger(settleMs) || settleMs < 0 || settleMs >= RENDER_TIMEOUT) {
        throw new Error(`render: settle must be whole milliseconds from 0 to ${RENDER_TIMEOUT - 1}, got ${settleParam}`);
    }
    // A bad XPath would otherwise only surface as a wait that never succeeds, 30 seconds later.
    const probe = new JSDOM('').window;
    try {
        for (const xpath of [rules.item, rules.itemTitle, rules.itemLink, rules.itemDesc, rules.itemPubDate]) {
            if (xpath !== null) {
                probe.document.createExpression(xpath);
            }
        }
    } finally {
        probe.close();
    }

    const result = await render(url, item, settleMs);
    // Status 0 is a load that never got a response (refused, blocked as private, DNS), but also a wait script
    // that threw or returned true before the page loaded; `count > 0` in the settle script keeps the second
    // from happening. A wait that ran out keeps its status and its dump.
    if (result.http_status === 0 || !result.content) {
        throw new Error(`render: ${url} did not load (${result.error ?? 'no content'})`);
    }
    if (result.http_status >= 400) {
        throw new Error(`render: ${url} answered ${result.http_status}`);
    }
    if (result.error) {
        logger.warn(`render: ${url} did not settle on ${item} within the render budget (${result.error}); reading what rendered`);
    }

    const { window } = new JSDOM(result.content, { url: result.url || url });
    try {
        return toFeed(window, rules, url, params.get('title'));
    } finally {
        window.close();
    }
};

const toFeed = (window: JSDOM['window'], rules: Rules, url: string, title: string | null): Data => {
    const extracted = extract(window, rules);
    if (extracted.length === 0) {
        throw new Error(`render: ${url} rendered no node for item=${rules.item}`);
    }
    // Relative links resolve as the page does: after redirects, and against any <base href>.
    const base = window.document.baseURI;
    const items: DataItem[] = [];
    const links = new Set<string>();
    for (const entry of extracted) {
        // An item with no title is unreadable in a reader, and keeping it would let it claim a link before a titled duplicate.
        if (!entry.title) {
            continue;
        }
        // A malformed href or a javascript:/mailto: link drops only that item's link, not the feed.
        let link: string | undefined;
        try {
            link = entry.link ? new URL(entry.link.trim(), base).href : undefined;
        } catch {
            link = undefined;
        }
        if (link !== undefined && !/^https?:/.test(link)) {
            link = undefined;
        }
        // Readers deduplicate by link anyway; two cards pointing at one page would show as one item twice.
        if (link !== undefined) {
            if (links.has(link)) {
                continue;
            }
            links.add(link);
        }
        const pubDate = entry.pubDate ? parseDate(entry.pubDate.trim()) : undefined;
        items.push({
            title: entry.title,
            link,
            description: entry.description ?? undefined,
            pubDate: pubDate && !Number.isNaN(pubDate.getTime()) ? pubDate : undefined,
        });
    }
    // No titled item means itemTitle points at nothing; publishing that would look like a working feed.
    if (items.length === 0) {
        throw new Error(`render: itemTitle=${rules.itemTitle} gave no text on any of the ${extracted.length} items`);
    }
    return {
        title: title || window.document.title,
        link: url,
        description: `Rendered ${url}`,
        item: items,
    };
};

export const route: Route = {
    path: '/xpath/:url/:routeParams',
    name: 'Rendered page, read with XPath',
    maintainers: ['TakashiAihara'],
    handler,
    example: '/render/xpath/https%3A%2F%2Fdime.jp%2F/item%3D%252F%252Fa%255Bcontains(%2540class%252C\'summary_link\')%255D%26itemTitle%3D.%252F%252Fh3',
    parameters: {
        url: '`encodeURIComponent`ed URL of the page',
        routeParams: 'A query string whose values are each `encodeURIComponent`ed, then the whole string `encodeURIComponent`ed again. The segment is decoded twice, so a single encoding turns `+` into a space',
    },
    description: `Opens the page in Lightpanda (a headless browser that runs the page's JavaScript), waits until the number of \`item\` matches stops changing, and reads every match as a feed item. Requests to private and internal addresses are blocked. For pages that a plain HTTP client gets empty because they render client-side; \`/rsshub/transform/html\` covers the rest.

| Key | Meaning | Default |
|---|---|---|
| \`item\` | XPath of the item nodes (required) | |
| \`itemTitle\` | XPath relative to the item; its text | \`.\` |
| \`itemLink\` | XPath relative to the item; select the attribute itself (\`./a/@href\`) | \`(./@href \\| .//a/@href)[1]\` |
| \`itemDesc\` | XPath relative to the item; an element gives its inner HTML | none |
| \`itemPubDate\` | XPath relative to the item; parsed as a date | none |
| \`title\` | Feed title | the page's \`<title>\` |
| \`settle\` | Milliseconds with no change in the number of \`item\` matches before the page is read as finished. Shorter is faster but can cut off a list that paints in steps | \`1500\` |

Attributes are read by selecting them in XPath, so there are no \`*Attr\` keys. Relative links resolve as the page does (after redirects, honouring \`<base href>\`); links that are not http(s) are dropped, items with an empty title are dropped, and items sharing a link keep the first. A pubDate that does not parse is left off.`,
    categories: ['other'],
    features: {
        requireConfig: [{ name: 'ALLOW_USER_SUPPLY_UNSAFE_DOMAIN', description: '' }],
        requirePuppeteer: false,
    },
};
