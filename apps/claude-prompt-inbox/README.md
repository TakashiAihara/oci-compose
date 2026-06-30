# claude-prompt-inbox

個人 inbox webapp (Bun + SQLite)。 pi から OCI に移行。

実装は別 repo: `https://github.com/TakashiAihara/claude-prompt-inbox` (Dockerfile 同梱、 Bun ベース)。

## 設定

| 項目 | 値 |
|---|---|
| build | git repo `TakashiAihara/claude-prompt-inbox` ルートの Dockerfile (Bun + multi-stage) |
| public port (host) | 8787 |
| volume | `claude-prompt-inbox-data:/data` (SQLite: `/data/inbox.db`) |
| 公開 host | `inbox.takashiaihara.site` (gray cloud + NSG home-only 下) |
| secret env | なし |
| env | `PORT=8787` / `INBOX_DB=/data/inbox.db` / `INBOX_MAX_LEN=280` |

## Coolify 設定 (Public Repository Build)

oci-compose には `docker-compose.yml` を置かず、 Coolify UI で直接 git build:

- Resource Type: **Public Repository** (Dockerfile build モード)
- Git URL: `https://github.com/TakashiAihara/claude-prompt-inbox.git`
- Branch: `main`
- Dockerfile: repo ルートの `Dockerfile`
- Port mapping: `8787:8787`
- Volume: `claude-prompt-inbox-data:/data`
- Env Vars:
  - `PORT=8787`
  - `INBOX_DB=/data/inbox.db`
  - `INBOX_MAX_LEN=280`
- Domain: `inbox.takashiaihara.site`
- Healthcheck: `bun -e "fetch('http://localhost:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`

## 初回 data 移行 (pi → oi1)

SQLite 1 ファイル、 軽量。

```bash
ssh pi 'sudo docker stop prompt-inbox && sudo tar czf /tmp/prompt-inbox-data.tar.gz -C /root/.ghq_src/github.com/TakashiAihara/claude-prompt-inbox/pi data && sudo docker start prompt-inbox'
scp pi:/tmp/prompt-inbox-data.tar.gz /tmp/
scp /tmp/prompt-inbox-data.tar.gz oi1:/tmp/
# Coolify resource 作成後、 起動 → 停止 → volume へ展開 → 再起動
```

## 削除 / 復元

Coolify Resource を削除すると named volume は (デフォ設定で) 残る。 完全削除する場合は volume も明示削除。
