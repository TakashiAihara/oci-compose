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
| `POSTGRES_PASSWORD` | mattermost DB パスワード。 新規 32 桁を生成し Coolify env に投入済み (= runtime の source of truth、 暗号化保存)。 旧 k3s の値は破棄済み。 Infisical `home/prod` へのミラーは machine identity が read-only のため未実施 (欲しければ Coolify UI から値を写して手動投入)。 内部 DB 用途で外部依存が無く再発行も容易 |

## Coolify 設定 (API で構築済み)

skill `ta.oci.add-app` の手順で Coolify API + tinker により構築済み。

- Resource: application uuid `gz3c8sl1yqqjug1khvagumdb` (project oci-apps / localhost server)
- Build Pack: Docker Compose / Base Directory `/apps/mattermost`
- Domain: `chat.takashiaihara.site` (service `mattermost` にバインド、 wildcard cert 既存)
- `connect_to_docker_network = true` (Traefik ルーティング + 内部 smtp 到達の前提)
- Env: `POSTGRES_PASSWORD` (生成値を注入済み)
- git branch: 一旦 `feat/mattermost-rebuild` を指す。 **PR merge 後に `main` へ戻す** (API PATCH `git_branch`)

deploy 済み・HTTPS `chat.takashiaihara.site/api/v4/system/ping` = 200 (status OK) を確認済み。

## 初回セットアップ (ユーザー作業)

1. `https://chat.takashiaihara.site` を開いて初回管理者アカウントを作成 (自宅 IP からのみ到達可、 NSG home-only 傘下)
2. System Console → Integrations → Integration Management で Incoming Webhooks = true を確認 (compose 側で有効化済み)
3. digest 投稿用チャンネル (例: `9router-updates`) を作成
4. そのチャンネルで Incoming Webhook を発行し、 URL を Infisical `home/prod` に `MATTERMOST_9ROUTER_WEBHOOK_URL` 等で格納
   - webhook URL は `https://chat.takashiaihara.site/hooks/xxxx` 形式
5. 9router 週次 digest routine (別途) がこの webhook に要約を POST する

## 移行メモ

- 旧構成の詳細は vault `mattermost-rebuild-memo-2026.md` を参照
- 過去メッセージ履歴は復元不能 (PVC 破棄済み)。 digest 用途は履歴ゼロで問題なし
- nvidia nim 連携は廃止。 LLM 連携は 9router 経由 (incoming webhook で外から投稿する形)
