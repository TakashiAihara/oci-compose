import type { CheerioAPI, Element } from 'cheerio';
import { load } from 'cheerio';

import type { Data, DataItem, Route } from '@/types';
import logger from '@/utils/logger';
import type { Page } from '@/utils/playwright';
import { getPlaywrightPage } from '@/utils/playwright';

const HOST = 'https://www.kaggle.com';
const LIST_URL = `${HOST}/competitions`;
/** Material glyphs the cards render as text beside their real labels, plus the option-menu icons. */
const ICONS = new Set(['trophy', 'rocket_launch', 'more_vert', 'more_horiz']);
/** Cards carry a relative "3 days ago" chip. What that chip counts from, creation or the last update, the page never says, so it never reaches the feed. */
const RELATIVE_TIME = /^(?:\d+|a|an)\s+(?:minute|hour|day|week|month|year)s?\s+ago$/i;
/** How many teams are competing: `10630 Teams`, or `1 Team`. It moves on every fetch, so it never reaches the feed. */
const TEAM_COUNT = /^\d[\d,]*\s+Teams?$/i;
const LINE = 'p, span, div';
const BLOCK = 'p, div, h2, h3, a, button, img';
/** Every competition link on the page, in either card shape; how many distinct hrefs there are says how far the page has painted. */
const ANCHOR = 'a[href^="/competitions/"]';
/** A grid card. The lower list is deliberately left unnamed: it is not worth a requirement of its own, and the settle wait covers the links it adds. */
const GRID_CARD = `[role="listitem"] ${ANCHOR}`;
/** A gap of this long with no new link is read as the page having finished painting. */
const SETTLE_MS = 1500;
/**
 * One budget for the whole render, running from before the browser is even asked for. Launch and goto come
 * out of it as much as the waits do, so a slow page load shortens the waits rather than escaping the budget.
 */
const RENDER_TIMEOUT = 30000;
/** What is left of the render budget. Playwright reads `timeout: 0` as "wait forever", so it never floors at zero. */
const budgetLeft = (deadline: number): number => Math.max(deadline - Date.now(), 1);
/** Distinct hrefs on the page right now, the same measure the settle wait watches, read on its own when that wait times out. */
const distinctLinks = (page: Page): Promise<number> =>
    page.evaluate((selector: string) => new Set(Array.from(document.querySelectorAll(selector), (anchor) => anchor.getAttribute('href'))).size, ANCHOR);

const normalize = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();

/**
 * A line with the team count off it. The count is a line of its own on a grid card and the last ` · ` segment
 * of the single line a lower-list card carries, and one split covers both: a line with no separator is a
 * single segment, so a count standing alone leaves nothing behind for the empty check in the loop to drop.
 */
const withoutTeams = (line: string): string => line.split(' · ').filter((part) => !TEAM_COUNT.test(part)).join(' · ');

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
    // One deadline for launch, goto and every wait, taken before the browser exists. The helper's own 30s
    // close timer starts before goto, so on a slow load it would fire while the waits were still running and
    // take the browser away mid-wait; disabling it is what closeTimeout: 0 is for, and the finally below
    // always awaits destroy().
    const deadline = Date.now() + RENDER_TIMEOUT;
    const { page, destroy } = await getPlaywrightPage(LIST_URL, {
        closeTimeout: 0,
        gotoConfig: { waitUntil: 'domcontentloaded', timeout: budgetLeft(deadline) },
    });
    try {
        // Only the grid is waited for by name. The lower list is the one that may never render at all, and
        // the grid alone is still a usable feed, so demanding it would turn a slow page into a failure. What
        // waits for the lower list is the settle below, which watches every link on the page: it keeps
        // arriving while grid cards are still being appended (31 of 35 at that point, 2026-10-04).
        try {
            await page.waitForSelector(GRID_CARD, { state: 'attached', timeout: budgetLeft(deadline) });
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
        } catch (error) {
            // Running out of budget is survivable: whatever did render is read below, and the checks there
            // decide whether it amounts to a feed — no links at all, or every title back to its slug, is an
            // error. A crashed browser or a renderer torn down mid-wait also lands here, so it is rethrown
            // instead of being read as a page that merely failed to settle.
            if (!(error instanceof Error && error.name === 'TimeoutError')) {
                throw error;
            }
            logger.warn(`kaggle: ${LIST_URL} did not settle within ${RENDER_TIMEOUT}ms; ${await distinctLinks(page)} distinct competition links were on the page`);
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
                const value = withoutTeams(plainText(el));
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

Cards come in two shapes — the \`role="listitem"\` grid and a differently marked-up \`<li>\` list further down the same page — and only structure is stable: every card styles itself with generated \`sc-*\` class names that change on redeploys, so the feed reads the anchor's href, the card's \`aria-label\` and the text of its lines instead. A title comes from that label, and the description gathers the card's remaining lines. The two shapes do not carry the same lines, so their descriptions come out differently. The feed joins a grid card's lines with \` / \`, giving \`COMPETITION / Start here! Predict survival on the Titanic and get familiar with ML basics\` — its type and subtitle, with no prize. A lower-list card carries a single line that already joins its prize and category with \`·\`, and it reaches the feed with its last segment off: \`Swag · Playground\` — no subtitle.

Team counts are left out of both shapes, whether they stand as a line of their own or hang off the end of that \`·\` line. The count moves on every fetch, so publishing it would rewrite every item on every poll and tell a reader nothing they did not already have.

Items carry **no pubDate**. The only time a card shows is a relative "3 days ago" chip, and the page never says whether that counts from when a competition was created or from when it was last updated, so there is nothing on it that can be published as a date. Readers deduplicate items by link, which is the guid, so a competition that reaches the list for the first time still arrives as a new item.`,
    categories: ['programming'],
    features: {
        requirePuppeteer: true,
    },
};
