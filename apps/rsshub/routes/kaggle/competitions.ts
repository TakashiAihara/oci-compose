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
/** Every competition link on the page, in either card shape; how many distinct hrefs there are says how far the grid has painted. */
const ANCHOR = 'a[href^="/competitions/"]';
/** One card of each shape: the grid list, and the lower list that finishes painting after it. */
const GRID_CARD = `[role="listitem"] ${ANCHOR}`;
const LOWER_CARD = `li[aria-label$=" List Item"] ${ANCHOR}`;
/** A gap of this long with no new link is read as the grid having finished painting. */
const SETTLE_MS = 1500;
/** One budget for the whole render, so it has to fit inside the browser window the helper leaves open. */
const RENDER_TIMEOUT = 20000;
/** What is left of the render budget. Playwright reads `timeout: 0` as "wait forever", so it never floors at zero. */
const budgetLeft = (deadline: number): number => Math.max(deadline - Date.now(), 1);

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
    // The helper's default closeTimeout (30s) closes the browser, which is the upper bound for the whole render.
    const { page, destroy } = await getPlaywrightPage(LIST_URL);
    try {
        // The grid list is on screen long before the lower one, so a snapshot taken at the first anchor
        // catches the grid alone and silently drops every lower-list card. Both shapes are therefore
        // waited for on one budget; exhausting it is not fatal, since the lower list is also the one that
        // may never render at all and the grid alone is still a usable feed.
        // Both shapes appear while grid cards are still being appended (31 of 35 at that point,
        // 2026-10-04), so the wait goes on until the link count stops moving for SETTLE_MS.
        const deadline = Date.now() + RENDER_TIMEOUT;
        try {
            await page.waitForFunction(
                (selectors: string[]) => selectors.every((selector) => document.querySelector(selector) !== null),
                [GRID_CARD, LOWER_CARD],
                { timeout: budgetLeft(deadline) }
            );
            // Distinct hrefs, not anchors: the feed deduplicates by slug, so a href repeated by two cards
            // is not progress. Polled on a timer rather than per frame, since the predicate decides on
            // elapsed time and needs no finer a resolution than the gap it is looking for.
            await page.waitForFunction(
                ([selector, quietMs]: [string, number]) => {
                    const pageState = window as Window & { kaggleLinks?: { count: number; changedAt: number } };
                    const count = new Set(Array.from(document.querySelectorAll(selector), (anchor) => anchor.getAttribute('href'))).size;
                    const now = performance.now();
                    const seen = pageState.kaggleLinks;
                    if (seen === undefined || seen.count !== count) {
                        pageState.kaggleLinks = { count, changedAt: now };
                        return false;
                    }
                    return now - seen.changedAt >= quietMs;
                },
                [ANCHOR, SETTLE_MS],
                { polling: 100, timeout: budgetLeft(deadline) }
            );
        } catch {
            // Read whatever did render: a page with neither shape is rejected by the checks below.
        }
        const $ = load(await page.content());
        const items: DataItem[] = [];
        const slugs = new Set<string>();
        let unlabelled = 0;

        for (const anchor of $(ANCHOR).toArray()) {
            const href = $(anchor).attr('href') ?? '';
            const slug = /^\/competitions\/([\w-]+)$/.exec(href)?.[1];
            if (slug === undefined || slugs.has(slug)) {
                continue;
            }
            slugs.add(slug);

            // The grid card labels itself on the `role="listitem"` wrapper, the lower list on its own `<li>`
            // with a "List Item" suffix; the anchor is labelled in that second shape instead.
            const card = $(anchor).closest('[role="listitem"], li').get(0);
            const label = ariaLabel(anchor) || ariaLabel(card);
            const title = label || slug;
            if (!label) {
                unlabelled += 1;
            }

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
        // Titles that all fell back to their slug are a reader-visible failure wearing a working feed's
        // clothes, so the feed errors out instead of publishing a page of slugs.
        if (unlabelled === items.length) {
            throw new Error('kaggle: no competition card carried an aria-label, so every title fell back to its slug');
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

Cards come in two shapes — the \`role="listitem"\` grid and a differently marked-up \`<li>\` list further down the same page — and only structure is stable: every card styles itself with generated \`sc-*\` class names that change on redeploys, so the feed reads the anchor's href, the card's \`aria-label\` and the text of its lines instead. A title comes from that label, and the description gathers the card's remaining lines. The two shapes do not carry the same lines, so their descriptions come out differently: a grid card gives \`COMPETITION / Start here! … / 10630 Teams\` — its type, subtitle and team count, with no prize — while a lower-list card gives \`Swag · Playground · 3575 Teams\` — its prize, category and team count joined by \`·\`, with no subtitle.

Items carry **no pubDate**. The only time a card shows is a relative "3 days ago" chip, and the page never says whether that counts from when a competition was created or from when it was last updated, so there is nothing on it that can be published as a date. Readers deduplicate items by link, which is the guid, so a competition that reaches the list for the first time still arrives as a new item.`,
    categories: ['programming'],
    features: {
        requirePuppeteer: true,
    },
};
