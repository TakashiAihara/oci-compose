import type { Context } from 'hono';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import type { Data, DataItem, Route } from '@/types';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import { getPlaywrightPage } from '@/utils/playwright';

/** One budget for launch, goto and the wait, the same shape as the kaggle route. */
const RENDER_TIMEOUT = 30000;
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
        itemDesc: params.get('itemDesc'),
        itemPubDate: params.get('itemPubDate'),
    };

    const deadline = Date.now() + RENDER_TIMEOUT;
    const { page, destroy } = await getPlaywrightPage(url, {
        closeTimeout: 0,
        gotoConfig: { waitUntil: 'domcontentloaded', timeout: budgetLeft(deadline) },
    });
    try {
        try {
            await page.waitForFunction((xpath: string) => document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue !== null, item, {
                polling: 200,
                timeout: budgetLeft(deadline),
            });
        } catch (error) {
            // A crashed browser or a bad XPath is not a slow page, so only a timeout falls through to the empty check below.
            if (!(error instanceof Error && error.name === 'TimeoutError')) {
                throw error;
            }
            logger.warn(`render: ${url} showed no ${item} within ${RENDER_TIMEOUT}ms`);
        }
        const extracted = await page.evaluate(extract, rules);
        const pageTitle = await page.title();
        if (extracted.length === 0) {
            throw new Error(`render: ${url} rendered no node for item=${item}`);
        }
        const items: DataItem[] = extracted.map((entry) => ({
            title: entry.title,
            link: entry.link ? new URL(entry.link.trim(), url).href : undefined,
            description: entry.description ?? undefined,
            pubDate: entry.pubDate ? parseDate(entry.pubDate.trim()) : undefined,
        }));
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
    example: '/render/xpath/https%3A%2F%2Fwww.kaggle.com%2Fcompetitions/item=%2F%2Fa%5Bstarts-with(%40href%2C%22%2Fcompetitions%2F%22)%5D',
    parameters: { url: '`encodeURIComponent`ed URL of the page', routeParams: 'Rules in query-string form, URL encoded' },
    description: `Opens the page in Chromium, waits until \`item\` matches, and reads every match as a feed item. For pages that a plain HTTP client gets empty because they render client-side; \`/rsshub/transform/html\` covers the rest.

| Key | Meaning | Default |
|---|---|---|
| \`item\` | XPath of the item nodes (required) | |
| \`itemTitle\` | XPath relative to the item; its text | \`.\` |
| \`itemLink\` | XPath relative to the item; select the attribute itself (\`./a/@href\`) | \`(./@href \\| .//a/@href)[1]\` |
| \`itemDesc\` | XPath relative to the item; an element gives its inner HTML | none |
| \`itemPubDate\` | XPath relative to the item; parsed as a date | none |
| \`title\` | Feed title | the page's \`<title>\` |

Attributes are read by selecting them in XPath, so there are no \`*Attr\` keys. Relative links resolve against \`url\`.`,
    categories: ['other'],
    features: {
        requireConfig: [{ name: 'ALLOW_USER_SUPPLY_UNSAFE_DOMAIN', description: '' }],
        requirePuppeteer: true,
    },
};
