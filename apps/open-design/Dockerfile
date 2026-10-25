# 公式イメージは coding agent の CLI を持たない。OpenDesign は PATH の claude を子プロセスで起動するので、
# ここで足して Max のサブスクの枠 (CLAUDE_CODE_OAUTH_TOKEN) で動かす。版上げは FROM のタグを変えるだけ
FROM ghcr.io/nexu-io/od:0.26.1

USER root
# alpine (musl) では同梱の ripgrep が動かないので、apk の rg を使わせる
RUN apk add --no-cache libgcc libstdc++ ripgrep \
 && npm install -g @anthropic-ai/claude-code \
 && npm cache clean --force \
 && mkdir -p /home/open-design \
 && chown open-design:open-design /home/open-design
ENV USE_BUILTIN_RIPGREP=0
USER open-design
