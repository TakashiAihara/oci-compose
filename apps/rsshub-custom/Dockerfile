# syntax=docker/dockerfile:1
# Upstream RSSHub bundles every route into dist at build time, so custom routes
# can only be added by building from source with them dropped into lib/routes.
FROM node:24-trixie AS build
WORKDIR /app
ADD https://github.com/DIYgod/RSSHub.git#master /app
RUN corepack enable pnpm && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true pnpm install --frozen-lockfile
COPY routes/ /app/lib/routes/
RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM node:24-trixie-slim
ENV NODE_ENV=production TZ=Asia/Tokyo
WORKDIR /app
RUN apt-get update && apt-get install -yq --no-install-recommends dumb-init && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
EXPOSE 1200
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--max-http-header-size=32768", "dist/index.mjs"]
