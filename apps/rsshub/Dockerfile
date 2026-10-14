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
# Lightpanda renders the pages /render/xpath reads. Pinned: it is a bare release binary with no
# package manager to say what changed, so a new version is taken by bumping this on purpose.
ARG LIGHTPANDA_VERSION=1.0.0
ARG TARGETARCH
RUN case "$TARGETARCH" in amd64) arch=x86_64 ;; arm64) arch=aarch64 ;; *) echo "no lightpanda build for $TARGETARCH" >&2; exit 1 ;; esac \
    && curl -fsSL -o /usr/local/bin/lightpanda "https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-${arch}-linux" \
    && chmod 755 /usr/local/bin/lightpanda \
    && /usr/local/bin/lightpanda version

FROM node:24-trixie-slim
ENV NODE_ENV=production TZ=Asia/Tokyo
# Chromium (the kaggle route) and Lightpanda (/render/xpath) run inside this container: a separate
# browser service would expose an unauthenticated CDP port on Coolify's shared network.
ENV CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
WORKDIR /app
RUN apt-get update \
    && apt-get install -yq --no-install-recommends dumb-init chromium ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
COPY --from=build /usr/local/bin/lightpanda /usr/local/bin/lightpanda
EXPOSE 1200
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--max-http-header-size=32768", "dist/index.mjs"]
