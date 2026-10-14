# syntax=docker/dockerfile:1
# Upstream RSSHub bundles every route into dist at build time, so custom routes
# can only be added by building from source with them dropped into lib/routes.
# Lightpanda renders the pages /render/xpath reads. Pinned with its checksum, so a new version is
# taken by bumping both on purpose rather than by whatever the release page serves that day.
# Its own stage, so the download is cached instead of repeated after every upstream ADD.
FROM node:24-trixie AS lightpanda
ARG LIGHTPANDA_VERSION=1.0.0
ARG TARGETARCH
RUN case "$TARGETARCH" in \
        amd64) arch=x86_64 sum=aa5a4b8ed53d1e38b3c73f5b2647d0a84a82e6744557f45f9a9c85858aa031c3 ;; \
        arm64) arch=aarch64 sum=69791924bcee43b13b224af4c845622c5fe66fdbc1b8143bfaa39ca8f85244f5 ;; \
        *) echo "no lightpanda build for $TARGETARCH" >&2; exit 1 ;; \
    esac \
    && curl -fsSL -o /usr/local/bin/lightpanda "https://github.com/lightpanda-io/browser/releases/download/${LIGHTPANDA_VERSION}/lightpanda-${arch}-linux" \
    && echo "$sum  /usr/local/bin/lightpanda" | sha256sum -c - \
    && chmod 755 /usr/local/bin/lightpanda \
    && /usr/local/bin/lightpanda version

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
# Lightpanda runs inside this container as a child process of the route: a separate browser service
# would expose an unauthenticated CDP port on Coolify's shared network.
# Lightpanda otherwise reports every run and navigation to telemetry.lightpanda.io.
ENV LIGHTPANDA_DISABLE_TELEMETRY=true
WORKDIR /app
RUN apt-get update \
    && apt-get install -yq --no-install-recommends dumb-init ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app /app
COPY --from=lightpanda /usr/local/bin/lightpanda /usr/local/bin/lightpanda
# Renders a page and runs its script where the route will, not just the CLI: the check in the download
# stage ran on the full image. A data: URL keeps the build off the network.
RUN lightpanda fetch 'data:text/html,<p id=x>ok</p>' --dump html --wait-script 'document.getElementById("x")!==null' --wait-ms 5000 > /dev/null
EXPOSE 1200
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--max-http-header-size=32768", "dist/index.mjs"]
