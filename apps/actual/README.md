# actual

家計簿 server (Actual Budget self-hosted)。 pi から OCI に移行。

## 設定

| 項目 | 値 |
|---|---|
| image | `actualbudget/actual-server:latest` (multi-arch arm64 / amd64) |
| public port (host) | 5006 |
| volume | `actual-data:/data` (named) |
| 公開 host | `actual.takashiaihara.site` (gray cloud + NSG home-only 下) |
| secret env | なし |

## SharedArrayBuffer / COOP COEP

Actual は SharedArrayBuffer を使うため、 reverse proxy (Coolify Traefik) で以下の response header を注入する必要がある:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Coolify UI の Application Settings → Custom Labels or Headers で設定 (compose 側の Traefik labels は Coolify の router 命名と競合するため、 UI 設定を推奨)。 設定が漏れると web UI 表示で表計算等が動かない。

## 初回 data 移行 (pi → oi1)

```bash
ssh pi 'cd /root/.ghq_src/github.com/TakashiAihara/pi/actual && sudo docker compose stop actual && sudo tar czf /tmp/actual-data.tar.gz -C . data && sudo docker compose start actual'
scp pi:/tmp/actual-data.tar.gz /tmp/
scp /tmp/actual-data.tar.gz oi1:/tmp/
# Coolify resource 作成後、 起動 → 停止 → volume へ展開 → 再起動
```

(132 KB と小さいので体感即時)

## Coolify 設定

- Resource Type: Docker Compose
- Git URL: `https://github.com/TakashiAihara/oci-compose.git`
- Base Directory: `apps/actual`
- Domain: `actual.takashiaihara.site`
- Custom Headers: COOP / COEP (上記)
