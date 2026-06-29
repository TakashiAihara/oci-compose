# Coolify bootstrap on si1 (OCI A1 22GB)

旧 k3s + ArgoCD を撤去後、 si1 単体で Coolify を立ち上げる手順。
進捗・ロールバックは vault [[oci-coolify-migration-2026]] を参照。

## 前提 (Phase 3 完了時点)

- si1 は shape resize 済み (2 OCPU + 22 GB + Boot Vol 47 GB)
- k3s-uninstall.sh で k3s 完全削除済み、 `/var/lib/rancher` も rm 済み
- docker は再 install 済み (もしくは未 install)
- ufw / iptables は OCI security list で代用 (port 22 / 80 / 443 / 8888 だけ通す)

## install

```bash
# Coolify 公式 installer
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash
```

install 後、 8000 番で UI が立ち上がる。 ssh port-forward で開いて初期セットアップ。

```bash
# 手元から
ssh -L 8000:localhost:8000 si1
# ブラウザで http://localhost:8000
```

## 初期セットアップ

1. 初回 admin user 作成
2. Server > Localhost を Default destination として登録
3. Source > Git > 公開リポジトリ `https://github.com/TakashiAihara/oci-compose.git` を登録 (private なら GitHub App 連携)
4. 各 app を resource として登録: `apps/<name>` を base directory として指定

## Resource 登録の順序

依存関係を考慮して以下の順で登録 → start:

1. **smtp** — 他の app の mail 送信に使うので先
2. **homepage** — 静的、 すぐ動く動作確認用
3. **changedetection / n8n / rsshub** — stateless 系
4. **ntfy** — state 復元あり
5. **teleport** — state 復元 + TLS 設定が必要、 一番面倒
6. **tinyproxy** — Coolify 配下に置くなら最後 (host network mode の都合)

## Secrets 注入 (resend pw 等)

- 各 resource の Environment Variables タブで以下を投入:
  - `smtp` resource: `RELAYHOST_USERNAME=resend`, `RELAYHOST_PASSWORD=re_xxxxx` (Resend API key)
- 将来 GitHub Actions → Coolify API で env を流し込む CI を組む TODO

## domain / TLS

- 各 resource の Domains タブで `https://<sub>.takashiaihara.site` を登録
- Coolify は Traefik or Caddy で自動 ACME (Let's Encrypt 経由)
- OCI LB の backend を si1:80 + si1:443 に向ければ DNS 変更不要で cutover

## tinyproxy on si2/si3

Coolify は si1 のみ。 si2/si3 は raw docker で運用:

```bash
ssh si2
git clone https://github.com/TakashiAihara/oci-compose.git
cd oci-compose/apps/tinyproxy
docker compose up -d
```
si3 も同様。 reboot 後の自動起動は `restart: unless-stopped` でカバー。
