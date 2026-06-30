# gogs

git server (Go 実装、 軽量)。 pi から OCI に移行。

## 設定

| 項目 | 値 |
|---|---|
| image | `gogs/gogs:latest` (multi-arch arm64 / amd64) |
| public port (host) | 3000 |
| volume | `gogs-data:/data` (named) |
| 公開 host | `gogs.takashiaihara.site` (gray cloud + NSG home-only 下) |
| secret env | なし |

## 初回 data 移行 (pi → oi1)

pi 上の `/root/.ghq_src/github.com/TakashiAihara/pi/gogs/data` (約 216 MB) を移行。

```bash
# pi 側で停止 (整合性確保) もしくは live tarball
ssh pi 'cd /root/.ghq_src/github.com/TakashiAihara/pi/gogs && sudo docker compose stop gogs && sudo tar czf /tmp/gogs-data.tar.gz -C . data && sudo docker compose start gogs'

# pi → workstation → oi1
scp pi:/tmp/gogs-data.tar.gz /tmp/
scp /tmp/gogs-data.tar.gz oi1:/tmp/

# OCI 側で named volume に展開 (Coolify resource 作成後、 一度起動 → 停止 → 展開 → 再起動)
ssh oi1 'sudo docker run --rm -v gogs-data:/data -v /tmp/gogs-data.tar.gz:/in.tar.gz:ro alpine sh -c "tar xzf /in.tar.gz -C / && mv /data /tmp/old || true && mv /data /data"'
# (実際の volume 名は Coolify suffix 付くので resource 作成後に再確認)
```

## Coolify 設定

- Resource Type: Docker Compose
- Git URL: `https://github.com/TakashiAihara/oci-compose.git`
- Base Directory: `apps/gogs`
- Domain: `gogs.takashiaihara.site` (Coolify が auto Traefik route)

## ssh push (option)

gogs は ssh push (22 ではなく別 port) を持つが、 OCI 側で 22/tcp は ssh 入口専用 + 他 port は NSG home-only で絞られている。 ssh push が必要なら別 port (例: 2222) を NSG/Security List に追加するか、 HTTPS push を使う。
