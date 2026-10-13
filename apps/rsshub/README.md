# rsshub

RSSHub built from upstream master with this directory's own routes, plus Chromium for routes that need a browser to render the page.

## URLs

- Browse: `https://rsshub.takashiaihara.site/<route>` (443 is open to the home IP only, via the OCI NSG)
- Subscribe in FreshRSS: `http://rsshub:1200/<route>` — same path, internal host
    - oi1 cannot hairpin to its own public IP, so FreshRSS cannot fetch the public name
    - FreshRSS resolves feed hosts with its own DNS lookup and pins the result, so an `extra_hosts` override does not help
    - `apps/freshrss` allows exactly this host with `INTERNAL_HOST_ALLOWLIST: rsshub:1200`
- For browser-rendered feeds, set the feed's timeout to 60s in FreshRSS (feed settings, advanced). FreshRSS's global default is 30s, and a browser route may spend up to 30s rendering on top of launching Chromium

## Adding a route

1. Put `routes/<namespace>/namespace.ts` and the route file(s) here, in upstream's `lib/routes` layout
2. Push, then trigger a deploy in Coolify (there is no webhook; a push alone does not deploy)
3. The build fails if upstream already ships `lib/routes/<namespace>`, rather than merging into it

Deploy is needed only when routes, the Dockerfile or the compose file change, not for new subscriptions.

## Upstream version

- Every build takes upstream master at that moment
- The commit it was built from is in `/app/UPSTREAM_COMMIT` inside the container
- A cold build on oi1 takes over 20 minutes; if upstream master is broken the build fails and the running container stays

## Routes

| Route | Source | Notes |
|---|---|---|
| `/kaggle/competitions` | kaggle.com/competitions (client-side rendered) | Sample route. No pubDate; new competitions arrive as new items by link. Team counts left out |
| `/render/xpath/:url/:routeParams` | Any page, rendered in Chromium | Rules are XPath; keys and defaults are in the route's description. Needs `ALLOW_USER_SUPPLY_UNSAFE_DOMAIN` (set in the compose file) |

## Feeds built on `/render/xpath`

Build the URL with `encodeURIComponent(url)` and `encodeURIComponent(routeParams)`, where routeParams is a plain query string such as `item=//a&itemTitle=.//h3`.

| Feed | Page | routeParams (before encoding) |
|---|---|---|
| DIME 最新記事 | `https://dime.jp/` | `item=//section[contains(@class,'listBlock-latest')]//a[contains(@class,'summary_link')]&itemTitle=.//h3&itemDesc=.//div[contains(@class,'summary_cat')]&itemPubDate=.//div[contains(@class,'summary_date')]&title=DIME 最新記事` |
