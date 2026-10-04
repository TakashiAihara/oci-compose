# syntax=docker/dockerfile:1
# Upstream RSSHub bundles every route into dist at build time, so custom routes
# can only be added by building from source with them dropped into lib/routes.
FROM node:24-trixie AS build
WORKDIR /app
ADD --keep-git-dir=true https://github.com/DIYgod/RSSHub.git#master /app
RUN git rev-parse HEAD > /app/UPSTREAM_COMMIT
RUN corepack enable pnpm && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true pnpm install --frozen-lockfile
COPY routes/ /tmp/routes/
# Fail instead of silently merging when upstream starts shipping a namespace we also define.
RUN for d in /tmp/routes/*/; do n=$(basename "$d"); if [ -e "lib/routes/$n" ]; then echo "upstream already has lib/routes/$n" >&2; exit 1; fi; done \
    && cp -r /tmp/routes/. lib/routes/
RUN pnpm build && pnpm prune --prod --ignore-scripts && rm -rf .git

FROM node:24-trixie-slim
ENV NODE_ENV=production TZ=Asia/Tokyo
# Chromium runs inside this container: a separate browser service would expose an
# unauthenticated CDP port on Coolify's shared network.
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
RUN apt-get update \
    && apt-get install -yq --no-install-recommends dumb-init chromium \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
EXPOSE 1200
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--max-http-header-size=32768", "dist/index.mjs"]
