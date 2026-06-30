# 9router

AI coding 用 LLM API router (Claude / GPT / Gemini 等の 40+ provider 中継、 OAuth token を local SQLite に保存)。 pi から OCI に移行。

## 設定

| 項目 | 値 |
|---|---|
| image | `decolua/9router:latest` (multi-arch arm64 + amd64) |
| public port (host) | 20128 |
| volume | `9router-data:/app/data` (SQLite: `$DATA_DIR/db/data.sqlite`) |
| 公開 host | `9router.takashiaihara.site` (gray cloud + NSG home-only 下) |
| 認証 | `REQUIRE_API_KEY=true` (HTTPS 後段なので `AUTH_COOKIE_SECURE=true`) |

## Coolify env (secret 投入必須)

| key | 説明 |
|---|---|
| `INITIAL_PASSWORD` | 初回 dashboard ログイン用、 pi 側の値と完全一致が必要 (data 移行する場合) |
| `JWT_SECRET` | dashboard JWT 署名、 pi 側の値と完全一致が必要 (data 移行する場合) |

pi 側の現在値は `pi:/root/.ghq_src/github.com/TakashiAihara/pi/9router/.env` を参照。

## 初回 data 移行 (pi → oi1)

192 KB と軽量、 SQLite 1 ファイル。

```bash
ssh pi 'cd /root/.ghq_src/github.com/TakashiAihara/pi/9router && sudo docker compose stop 9router && sudo tar czf /tmp/9router-data.tar.gz -C . data && sudo docker compose start 9router'
scp pi:/tmp/9router-data.tar.gz /tmp/
scp /tmp/9router-data.tar.gz oi1:/tmp/
```

## Coolify 設定

- Resource Type: Docker Compose
- Git URL: `https://github.com/TakashiAihara/oci-compose.git`
- Base Directory: `apps/9router`
- Domain: `9router.takashiaihara.site`
- Env Vars: `INITIAL_PASSWORD`, `JWT_SECRET` (secret 扱い)

## CGNAT 注意

deepwiki 確認済の制約: built-in rate limit なし。 LAN 外公開時は reverse proxy (Coolify Traefik) 側で rate limit middleware を被せる、 もしくは Cloudflare Access で SSO 認証を追加する。 本構成では NSG home-only で自宅 IP 限定なので外部攻撃面は最小化されている。

## レイテンシ

LAN 内 (pi) → OCI 移行で +20-50ms 程度のレイテンシ増 (CLI 利用時に体感)。 メイン用途が自宅 LAN 内 CLI 連携なら pi 残置の方が体感速い。
