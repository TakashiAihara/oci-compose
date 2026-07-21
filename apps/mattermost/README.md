# mattermost

セルフホスト chat。 旧 3-node k3s から OCI 移行時に一旦破棄 (PVC データも破棄済み) → oi1 Coolify 上で新規建て直し。
初期の常設用途は 9router repo (`decolua/9router`) の週次アップデート要約を bot 投稿する digest チャンネル。

## 設定

| 項目 | 値 |
|---|---|
| image | `rheens/mattermost-app:v11.8.3` (arm64 community build。 公式 team-edition は amd64 のみ) |
| DB | `postgres:16-alpine` (同梱、 `mattermost-db`) |
| listen port | 8000 (公式の 8065 ではない。 image の EXPOSE / entrypoint 生成 config が :8000) |
| 公開 host | `chat.takashiaihara.site` |
| SMTP | 内部 `smtp` (postfix→resend relay) :587 認証なし |

## Coolify env (secret 投入必須)

| key | 説明 |
|---|---|
| `POSTGRES_PASSWORD` | mattermost DB パスワード。 新規発行 (旧 k3s の値は破棄済み)。 Infisical `home/prod` にも同名で格納 |

## Coolify 設定

- Resource Type: Docker Compose
- Git URL: `https://github.com/TakashiAihara/oci-compose.git`
- Base Directory: `apps/mattermost`
- Domain: `chat.takashiaihara.site` (wildcard cert 既存)
- Env Vars: `POSTGRES_PASSWORD` (secret 扱い)

## 初回セットアップ (deploy 後・ユーザー作業)

1. `https://chat.takashiaihara.site` を開いて初回管理者アカウントを作成
2. System Console → Integrations → Integration Management で Incoming Webhooks = true を確認 (compose 側で有効化済み)
3. digest 投稿用チャンネル (例: `9router-updates`) を作成
4. そのチャンネルで Incoming Webhook を発行し、 URL を Infisical `home/prod` に `MATTERMOST_9ROUTER_WEBHOOK_URL` 等で格納
   - webhook URL は `https://chat.takashiaihara.site/hooks/xxxx` 形式
5. 9router 週次 digest routine (別途) がこの webhook に要約を POST する

## 移行メモ

- 旧構成の詳細は vault `mattermost-rebuild-memo-2026.md` を参照
- 過去メッセージ履歴は復元不能 (PVC 破棄済み)。 digest 用途は履歴ゼロで問題なし
- nvidia nim 連携は廃止。 LLM 連携は 9router 経由 (incoming webhook で外から投稿する形)
