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
| `/hitomi/tag/:tag/:language?` | The tag list of `hitomi.la` (`/tag/<tag>-<language>.html`), read from the `.nozomi` id list the page itself loads | The 25 newest galleries. `tag` keeps its `female:` / `male:` prefix as in the site URL; `language` defaults to `all`. Each item carries the first page's thumbnail through `/hitomi/thumb/:hash`, at the public host, since the browser opening FreshRSS loads it. A tag the site does not have fails the feed with a 404 |
| `/hitomi/thumb/:hash` | A gallery page's big thumbnail on `tn.gold-usergeneratedcontent.net` | Adds the `Referer: https://hitomi.la/` the host demands (404 without it). Takes only a 64-hex hash, so it proxies nothing else |
| `/playlists` | The Atom feed of `playlists.sakura.ne.jp` | The entries of the site's own feed, each linking to the book on its author page and carrying the book's cover thumbnail, whose path the route builds from the entry id's author code and ISBN. The image opens without a Referer, so there is no proxy. An id without them leaves that entry without a cover; when no entry has one the feed fails |
| `/google-discover` | The Discover feed of the Google app, read on an Android emulator at home by `TakashiAihara/google-discover-rss`, which PUTs `seen.json` hourly to `apps/dav` as the user `google-discover`; the route reads it at `http://dav:6065` as `google-discover-reader` (`GOOGLE_DISCOVER_DAV_READER_PASSWORD`) | Newest first by the time the collector first saw each card, up to 500, each with Google's thumbnail. Discover gives no publish time. A `seen.json` last modified over 3 hours ago fails the feed with `the collector stopped`; look at the collector host |
| `/google-news-foryou` | The For you tab of `news.google.com`, from `news.json` on dav | `TakashiAihara/google-news-rss` on a home host signs in with the main account's cookie, keeps it rotated, and PUTs the tab (about 200 articles, images as gstatic thumbnails) every 10 minutes as the dav user `google-news`. This route reads it as `google-news-reader` (`GOOGLE_NEWS_DAV_READER_PASSWORD`) It fails the feed when the file is over an hour old (`the collector stopped`; look at the collector's `cron.log`), when no article has a date, or when the newest is over 24 hours old. No cookie lives on oi1 |
| `/taba/rows/:source/:routeParams` | A taba collector's rows from `taba web` on taba1 (`http://192.168.0.182:8790/api/rows`), over the site-to-site link with `TABA_WEB_KEY` | The collector's newest run (read from the first 1000 rows of its newest day), one item per guid. routeParams names the columns (`itemTitle` / `itemLink` required; `itemImage` / `itemGuid` / `itemAuthor` / `itemDesc` / `itemPubDate`, default `_fetched_at`) and `title`; the values are encoded, then the whole segment again, as for `/render/xpath`. Serves only the collectors listed in `SOURCES` in the route, each with how old its newest run may be (RSSHub has no login in front, taba web does). A column the collector lacks, or a newest run past that age, fails the feed. Thumbnails must be https. This is how pages taba opens in browser1's logged-in Chrome (`ctx.browse`) reach FreshRSS |

## Feeds on `/taba/rows`

| Feed | Path |
|---|---|
| Google 画像検索 (taba google-images, daily; thumbnails are Google's gstatic ones) | `/taba/rows/google-images/itemTitle%3Dtitle%26itemLink%3Dpage_url%26itemImage%3Dthumbnail_url%26itemGuid%3Ddoc_id%26itemAuthor%3Dsource%26itemDesc%3Dquery%26title%3DGoogle%2520%25E7%2594%25BB%25E5%2583%258F%25E6%25A4%259C%25E7%25B4%25A2` (before encoding: `itemTitle=title&itemLink=page_url&itemImage=thumbnail_url&itemGuid=doc_id&itemAuthor=source&itemDesc=query&title=Google 画像検索`). An image under two queries in a run is one item, since the guid is `doc_id`. FreshRSS drops the feed's guid-based matching for good when one fetch repeats a guid, so the route never does |

## Feeds built on `/render/xpath`

The path is `/render/xpath/<encodeURIComponent(url)>/<encodeURIComponent(routeParams)>`, where routeParams is a query string whose values are each already `encodeURIComponent`ed (`item=<enc(xpath)>&itemTitle=<enc(xpath)>`). The segment is decoded twice, so encoding only once turns a `+` in an XPath into a space. The table shows the values before either encoding.

| Feed | Page | routeParams (before encoding) |
|---|---|---|
| DIME 最新記事 | `https://dime.jp/` | `item=//section[contains(@class,'listBlock-latest')]//a[contains(@class,'summary_link')]&itemTitle=.//h3&itemDesc=.//div[contains(@class,'summary_cat')]&itemPubDate=.//div[contains(@class,'summary_date')]&title=DIME 最新記事` |
| NVIDIA build models (newest first, 24 cards; no dates, the page keeps them only in its script payload) | `https://build.nvidia.com/models` | `item=//li[.//a[@data-nvtrack-nav-object='artifact-card']]&itemTitle=.//h3&itemLink=.//h3/a/@href&itemDesc=.//span[contains(@class,'line-clamp-2')]&title=NVIDIA build models` |
| NVIDIA build models, Free Endpoint only | `https://build.nvidia.com/models?filters=nimType%3Anim_type_preview` | Same rules as the row above, with `title=NVIDIA build models (Free Endpoint)` |

## Feeds on other routes

| Feed | Route |
|---|---|
| OpenRouter models (newest first, from `https://openrouter.ai/api/v1/models`) | `/rsshub/transform/json/<enc(url)>/<enc(title=OpenRouter models&item=data&itemTitle=name&itemLink=id&itemLinkPrefix=https://openrouter.ai/&itemDesc=description)>?limit=50&format=json` — `format=json` because FreshRSS reads any URL containing `json` as a JSON Feed and fails on RSS. No dates: `created` is Unix seconds, which the route reads as milliseconds |
| Ollama library (newest) | `/ollama/library?limit=50` |
| Ollama blog | `/ollama/blog` |
| X おすすめ (For you) of the sub account | `/twitter/home` — needs `TWITTER_AUTH_TOKEN` (Coolify env, from Infisical home/prod). `/twitter/home_latest` is the Following tab |
