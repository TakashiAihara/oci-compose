# 公式イメージは coding agent の CLI を持たない。OpenDesign は PATH の claude を子プロセスで起動するので、
# ここで足して Max のサブスクの枠 (CLAUDE_CODE_OAUTH_TOKEN) で動かす。
# OpenDesign は claude の stream-json の形に依存するので、claude も版を固定し、FROM と一緒に上げる
FROM ghcr.io/nexu-io/od:0.26.1

USER root
# alpine (musl) では同梱の ripgrep が動かないので、apk の rg を使わせる
RUN apk add --no-cache libgcc libstdc++ ripgrep \
 && npm install -g @anthropic-ai/claude-code@2.1.310 \
 && npm cache clean --force \
 && mkdir -p /home/open-design \
 && chown open-design:open-design /home/open-design
# global の npm は root 所有で、自動更新は毎回失敗するだけなので止める
ENV USE_BUILTIN_RIPGREP=0 \
    DISABLE_AUTOUPDATER=1
USER open-design
