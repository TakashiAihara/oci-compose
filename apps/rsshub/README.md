# rsshub

RSSHub built from upstream master with this directory's own routes, plus Lightpanda, a headless browser, for `/render/xpath` to render client-side pages (about 160MiB RSS per render, where Chromium took 726MiB PSS). There is no Chromium in the image, so upstream routes that need a browser (`requirePuppeteer`) fail here.

## URLs

- Browse: `https://rsshub.takashiaihara.site/<route>` (443 is open to the home IP only, via the OCI NSG)
- Subscribe in FreshRSS: `http://rsshub:1200/<route>` — same path, internal host
    - oi1 cannot hairpin to its own public IP, so FreshRSS cannot fetch the public name
    - FreshRSS resolves feed hosts with its own DNS lookup and pins the result, so an `extra_hosts` override does not help
    - `apps/freshrss` allows exactly this host with `INTERNAL_HOST_ALLOWLIST: rsshub:1200`
- For browser-rendered feeds, set the feed's timeout to 60s in FreshRSS (feed settings, advanced). FreshRSS's global default is 30s, and a browser route may spend up to 30s rendering on top of starting the browser. A `/render/xpath` feed that settles takes a few seconds; one whose `item` never matches runs the full 30s before failing

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
| `/render/xpath/:url/:routeParams` | Any page, rendered in Lightpanda | Rules are XPath; keys and defaults are in the route's description. Needs `ALLOW_USER_SUPPLY_UNSAFE_DOMAIN` (set in the compose file). Requests to private and internal addresses are blocked |

## Feeds built on `/render/xpath`

The path is `/render/xpath/<encodeURIComponent(url)>/<encodeURIComponent(routeParams)>`, where routeParams is a query string whose values are each already `encodeURIComponent`ed (`item=<enc(xpath)>&itemTitle=<enc(xpath)>`). The segment is decoded twice, so encoding only once turns a `+` in an XPath into a space. The table shows the values before either encoding.

| Feed | Page | routeParams (before encoding) |
|---|---|---|
| DIME 最新記事 | `https://dime.jp/` | `item=//section[contains(@class,'listBlock-latest')]//a[contains(@class,'summary_link')]&itemTitle=.//h3&itemDesc=.//div[contains(@class,'summary_cat')]&itemPubDate=.//div[contains(@class,'summary_date')]&title=DIME 最新記事` |
| NVIDIA build models (newest first, 24 cards; no dates, the page keeps them only in its script payload) | `https://build.nvidia.com/models` | `item=//li[.//a[@data-nvtrack-nav-object='artifact-card']]&itemTitle=.//h3&itemLink=.//h3/a/@href&itemDesc=.//span[contains(@class,'line-clamp-2')]&title=NVIDIA build models` |

## Feeds on other routes

| Feed | Route |
|---|---|
| OpenRouter models (newest first, from `https://openrouter.ai/api/v1/models`) | `/rsshub/transform/json/<enc(url)>/<enc(title=OpenRouter models&item=data&itemTitle=name&itemLink=id&itemLinkPrefix=https://openrouter.ai/&itemDesc=description)>?limit=50&format=json` — `format=json` because FreshRSS reads any URL containing `json` as a JSON Feed and fails on RSS. No dates: `created` is Unix seconds, which the route reads as milliseconds |
| Ollama library (newest) | `/ollama/library?limit=50` |
| Ollama blog | `/ollama/blog` |
