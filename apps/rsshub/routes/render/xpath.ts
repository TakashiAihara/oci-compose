import type { Context } from 'hono';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import type { Data, DataItem, Route } from '@/types';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import { getPlaywrightPage } from '@/utils/playwright';

/** One budget for goto and the waits. Chromium's launch comes on top: the goto timeout is computed before the browser exists. */
const RENDER_TIMEOUT = 30000;
/** A gap this long with no new `item` match is read as the list having finished painting, as in the kaggle route. */
const SETTLE_MS = 1500;
/** Playwright reads `timeout: 0` as "wait forever", so it never floors at zero. */
const budgetLeft = (deadline: number): number => Math.max(deadline - Date.now(), 1);

type Rules = { item: string; itemTitle: string; itemLink: string; itemDesc: string | null; itemPubDate: string | null };
type Extracted = { title: string; link: string | null; description: string | null; pubDate: string | null };

/**
 * Runs inside the page: XPath needs the live DOM, and `document.evaluate` is already there. It holds no
 * nested named function, since esbuild wraps those in a `__name` helper that does not exist in the page.
 */
const extract = (rules: Rules): Extracted[] => {
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

    const deadline = Date.now() + RENDER_TIMEOUT;
    const { page, destroy } = await getPlaywrightPage(url, {
        closeTimeout: 0,
        gotoConfig: { waitUntil: 'domcontentloaded', timeout: budgetLeft(deadline) },
    });
    try {
        try {
            // The first match alone would cut a list that is still being appended, so this waits for the count to stop moving.
            await page.waitForFunction(
                ([xpath, quietMs]: [string, number]) => {
                    const pageState = window as Window & { rsshubRenderMatches?: { count: number; changedAt: number } };
                    const count = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null).snapshotLength;
                    const now = performance.now();
                    const seen = pageState.rsshubRenderMatches;
                    if (seen === undefined || seen.count !== count) {
                        pageState.rsshubRenderMatches = { count, changedAt: now };
                        return false;
                    }
                    return count > 0 && now - seen.changedAt >= quietMs;
                },
                [item, SETTLE_MS] as [string, number],
                { polling: 200, timeout: budgetLeft(deadline) }
            );
        } catch (error) {
            // A crashed browser or a bad XPath is not a slow page, so only a timeout falls through to the empty check below.
            if (!(error instanceof Error && error.name === 'TimeoutError')) {
                throw error;
            }
            logger.warn(`render: ${url} did not settle on ${item} within the render budget`);
        }
        const extracted = await page.evaluate(extract, rules);
        const pageTitle = await page.title();
        // Relative links resolve as the page itself resolves them: after redirects, and against any <base href>.
        const base = await page.evaluate(() => document.baseURI);
        if (extracted.length === 0) {
            throw new Error(`render: ${url} rendered no node for item=${item}`);
        }
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
            title: params.get('title') || pageTitle,
            link: url,
            description: `Rendered ${url}`,
            item: items,
        };
    } finally {
        await destroy();
    }
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
    description: `Opens the page in Chromium, waits until \`item\` matches, and reads every match as a feed item. For pages that a plain HTTP client gets empty because they render client-side; \`/rsshub/transform/html\` covers the rest.

| Key | Meaning | Default |
|---|---|---|
| \`item\` | XPath of the item nodes (required) | |
| \`itemTitle\` | XPath relative to the item; its text | \`.\` |
| \`itemLink\` | XPath relative to the item; select the attribute itself (\`./a/@href\`) | \`(./@href \\| .//a/@href)[1]\` |
| \`itemDesc\` | XPath relative to the item; an element gives its inner HTML | none |
| \`itemPubDate\` | XPath relative to the item; parsed as a date | none |
| \`title\` | Feed title | the page's \`<title>\` |

Attributes are read by selecting them in XPath, so there are no \`*Attr\` keys. Relative links resolve as the page does (after redirects, honouring \`<base href>\`); links that are not http(s) are dropped, items with an empty title are dropped, and items sharing a link keep the first. A pubDate that does not parse is left off.`,
    categories: ['other'],
    features: {
        requireConfig: [{ name: 'ALLOW_USER_SUPPLY_UNSAFE_DOMAIN', description: '' }],
        requirePuppeteer: true,
    },
};
