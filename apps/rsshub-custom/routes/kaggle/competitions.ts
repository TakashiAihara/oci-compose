import type { CheerioAPI, Element } from 'cheerio';
import { load } from 'cheerio';

import type { Data, DataItem, Route } from '@/types';
import { getPlaywrightPage } from '@/utils/playwright';

const HOST = 'https://www.kaggle.com';
const LIST_URL = `${HOST}/competitions`;
/** Material glyphs the cards render as text beside their real labels, plus the option-menu icons. */
const ICONS = new Set(['trophy', 'rocket_launch', 'more_vert', 'more_horiz']);
/** Cards carry a relative "3 days ago" chip. It is not an ordering key, so it never reaches the feed. */
const RELATIVE_TIME = /^(?:\d+|a|an)\s+(?:minute|hour|day|week|month|year)s?\s+ago$/i;
const LINE = 'p, span, div';
const BLOCK = 'p, div, h2, h3, a, button, img';

const normalize = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();

/**
 * Both card shapes nest their text lines, `<p><span>x</span></p>` and `<span>x</span>` alike, so a line is
 * an element holding no further block. Anything wrapping a block is a container, not a line.
 */
const isLine = ($: CheerioAPI, el: Element): boolean => $(el).find(BLOCK).length === 0;

/** An element's own text, leaving icon glyphs and option buttons out. */
const plainText = (el: Element): string =>
    normalize(
        el.childNodes
            .map((node) => {
                if (node.type === 'text') {
                    return node.data;
                }
                if (node.type !== 'tag') {
                    return '';
                }
                const value = plainText(node);
                return node.name === 'button' || ICONS.has(value) ? '' : value;
            })
            .join(' ')
    );

const ariaLabel = (el: Element | undefined): string => normalize(el?.attribs['aria-label']).replace(/ List Item$/, '');

export const handler = async (): Promise<Data> => {
    const { page, destroy } = await getPlaywrightPage(LIST_URL);
    try {
        await page.waitForSelector('a[href^="/competitions/"]', { state: 'attached', timeout: 15000 });
        const $ = load(await page.content());
        const items: DataItem[] = [];
        const slugs = new Set<string>();

        for (const anchor of $('a[href^="/competitions/"]').toArray()) {
            const href = $(anchor).attr('href') ?? '';
            const slug = /^\/competitions\/([\w-]+)$/.exec(href)?.[1];
            if (slug === undefined || slugs.has(slug)) {
                continue;
            }
            slugs.add(slug);

            // The grid card labels itself on the `role="listitem"` wrapper, the lower list on its own `<li>`
            // with a "List Item" suffix; the anchor is labelled in that second shape instead.
            const card = $(anchor).closest('[role="listitem"], li').get(0);
            const title = ariaLabel(anchor) || ariaLabel(card) || slug;

            const details: string[] = [];
            for (const el of $(anchor).find(LINE).toArray()) {
                if (!isLine($, el)) {
                    continue;
                }
                const value = plainText(el);
                if (!value || value === title || ICONS.has(value) || RELATIVE_TIME.test(value) || details.includes(value)) {
                    continue;
                }
                details.push(value);
            }

            const link = new URL(href, HOST).href;
            items.push({ title, link, description: details.join(' / ') || null });
        }

        if (items.length === 0) {
            throw new Error('kaggle: the competitions page rendered no /competitions/<slug> links');
        }
        return {
            title: 'Kaggle Competitions',
            link: LIST_URL,
            item: items,
        };
    } finally {
        await destroy();
    }
};

export const route: Route = {
    path: '/competitions',
    name: 'Competitions',
    url: 'www.kaggle.com',
    maintainers: ['TakashiAihara'],
    handler,
    example: '/kaggle/competitions',
    description: `The competition list on Kaggle. The page is rendered client-side and a plain HTTP client gets no cards at all, so the feed drives a browser.

Cards come in two shapes — the \`role="listitem"\` grid and a differently marked-up \`<li>\` list further down the same page — and only structure is stable: every card styles itself with generated \`sc-*\` class names that change on redeploys, so the feed reads the anchor's href, the card's \`aria-label\` and the text of its lines instead. A title comes from that label, and the description gathers the card's remaining lines: the type (COMPETITION, Playground), the prize, the team count and the subtitle.

Items carry **no pubDate**. Each card shows a relative "3 days ago" chip, but the list is ordered by Kaggle's own ranking rather than by time, so there is no reliable date and no ordering to diff against — a poll is a plain listing, not a stream of new competitions.`,
    categories: ['programming'],
    features: {
        requirePuppeteer: true,
    },
};
