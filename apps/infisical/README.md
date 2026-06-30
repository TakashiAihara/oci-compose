# infisical

OSS secret manager (self-hosted)。 pi から OCI に移行。

## 設定

| 項目 | 値 |
|---|---|
| infisical image | `infisical/infisical:v0.161.9` (multi-arch) |
| postgres image | `postgres:14-alpine` |
| redis image | `redis:7-alpine` |
| public port (host) | 8080 (infisical app) |
| postgres volume | `infisical-pg` (named) |
| redis volume | `infisical-redis` (named) |
| 公開 host | `infisical.takashiaihara.site` (gray cloud + NSG home-only 下) |

## Coolify env (secret 投入必須、 pi 側 .env と完全一致)

| key | 説明 |
|---|---|
| `POSTGRES_PASSWORD` | pg DB password、 pi 側現値と一致 (data 移行後の接続用) |
| `ENCRYPTION_KEY` | **過去に保存した secret の暗号化 key**、 **絶対に変えない**、 変えると過去 secret が永久に復号不能 |
| `AUTH_SECRET` | session / token 署名、 引き継ぐと既存 JWT がそのまま有効、 別値にすると全 user 再 login が必要 |

pi 側 `pi:/root/.ghq_src/github.com/TakashiAihara/pi/infisical/.env` から取得。

## 初回 data 移行 (pi → oi1)

postgres (約 159 MB の主要部) + redis (cache、 失っても再生成可) の 2 段。

### postgres dump + restore

```bash
# pi 側で dump (live OK、 short-lived 整合性)
ssh pi 'sudo docker exec pi-infisical-db-1 pg_dump -U infisical -d infisical -F c -f /tmp/infisical.dump'
ssh pi 'sudo docker cp pi-infisical-db-1:/tmp/infisical.dump /tmp/infisical.dump'
scp pi:/tmp/infisical.dump /tmp/
scp /tmp/infisical.dump oi1:/tmp/

# OCI 側で restore (Coolify resource 起動 → 一度 app/redis 停止 → pg のみ起動状態で restore → 再起動)
ssh oi1 'sudo docker cp /tmp/infisical.dump <coolify-pg-container>:/tmp/'
ssh oi1 'sudo docker exec <coolify-pg-container> pg_restore -U infisical -d infisical --clean --if-exists /tmp/infisical.dump'
```

### redis (option、 cache のみなので未移行可)

```bash
ssh pi 'sudo docker exec pi-infisical-redis-1 redis-cli BGSAVE'
sleep 5
ssh pi 'sudo docker cp pi-infisical-redis-1:/data/dump.rdb /tmp/infisical-redis.rdb'
scp pi:/tmp/infisical-redis.rdb /tmp/
scp /tmp/infisical-redis.rdb oi1:/tmp/
# OCI 側 redis volume に展開 (起動前に投入推奨)
```

redis を移行しない場合は session cache が消えるだけ (再 login で復活)。

## Coolify 設定

- Resource Type: Docker Compose
- Git URL: `https://github.com/TakashiAihara/oci-compose.git`
- Base Directory: `apps/infisical`
- Domain: `infisical.takashiaihara.site` (infisical service の :8080 に proxy)
- Env Vars: `POSTGRES_PASSWORD`, `ENCRYPTION_KEY`, `AUTH_SECRET`

## SITE_URL 切替の意味

`SITE_URL: https://infisical.takashiaihara.site` は OAuth callback / email link / web UI 生成 link で使われる。 pi 側は `https://infisical.local` だったので、 移行後 web UI 側の link が全部新 URL に切り替わる。 既存 user の login session は影響なし (AUTH_SECRET が同じなら)。
