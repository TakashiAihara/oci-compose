# oci-compose

OCI Always Free 上の単一 A1 インスタンス + Coolify で運用する個人サービスの docker-compose 集約 repo。

旧構成 (`oci-cluster` の k3s + ArgoCD) からの移行については vault [[oci-coolify-migration-2026]] 参照。

## 構造

```
apps/
├── changedetection/docker-compose.yml
├── homepage/
│   ├── docker-compose.yml
│   └── config/             # services.yaml 等
├── n8n/docker-compose.yml
├── ntfy/
│   ├── docker-compose.yml
│   └── config/             # server.yml
├── rsshub/docker-compose.yml
├── smtp/docker-compose.yml
├── teleport/docker-compose.yml
└── tinyproxy/docker-compose.yml
infra/
└── coolify-bootstrap.md     # Coolify install / git 連携手順
```

## 運用方針

- 各 `apps/<name>/` を Coolify の 1 resource に対応
- Coolify UI から git URL `https://github.com/TakashiAihara/oci-compose.git` を登録、 base directory に `apps/<name>` を指定
- Secrets (resend pw, teleport JWT 等) は git に入れない。 Coolify UI の Environment Variables 機能で注入
- branch は基本 `main`、 重大な変更時のみ feature branch + PR

## ホスト

- 本番: si1 (158.101.141.135 / 2 OCPU + 22 GB)
- LB front: 155.248.171.144 (OCI LB)
- DNS: `*.takashiaihara.site` (Cloudflare or 他)

## 将来 TODO

- [ ] env injection を CI 化 (GitHub Actions → Coolify API で env 流し込み)
- [ ] Coolify backup の S3 / B2 連携
- [ ] tinyproxy を si2/si3 にも自動 deploy (現状は手動 ssh + docker run)
