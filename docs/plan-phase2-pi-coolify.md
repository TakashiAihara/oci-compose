# Phase 2 実行計画: pi アプリ系サービスの Coolify 移管

Tracking: #10 / 関連: TakashiAihara/pi#3 (pi 用 postfix), vault `oci-home-site-to-site-wireguard.md`

status: 承認待ち draft (2026-07-05)

## 目的

pi 上のアプリ系サービスを oi1 Coolify の server「pi」(192.168.0.10, WireGuard site-to-site 経由) 管理下に移し、oi1 と運用を一元化する。基盤系は pi 単体で完結する独立性を維持するため移管しない。

## スコープ

### 移管する (アプリ系、7 service)

| service | 現在地 (pi repo) | data | 備考 |
|---|---|---|---|
| uptime-kuma | monitoring/ | bind: `monitoring/uptime-kuma-data` | traefik routing (`uptime.local`) あり |
| speedtest-exporter | monitoring/ | なし | healthcheck override 済み (pi#2) |
| blackbox-exporter | monitoring/ | config bind: `monitoring/blackbox.yml` | |
| pve-exporter | monitoring/ | なし (env 3 つ: PVE_* secret) | |
| cadvisor | monitoring/ | なし (privileged + host mounts) | |
| tor | tor/ | なし | |
| tinyproxy | tinyproxy/ (別 compose project) | local build image | Dockerfile ごと移す。upstream は ci1 向き |

新設 1 件: smtp (Resend relay、pi#3) — oi1 の `apps/smtp` と同構成で server=pi に deploy。

### 移管しない (基盤系、pi repo 残置)

technitium (DNS/DHCP) / traefik / homepage (LAN dashboard) / vector + minio (hooks 収集) / cloudflare-ddns。
理由: pi 単体で家の基盤が完結する独立性を守る (deploy 経路をトンネル + oi1 に依存させない)。DHCP reservation 不採用と同じ判断軸。

### スコープ外

- prompt-inbox: private repo の local build image のため Coolify 移管には ghcr push か GitHub App が必要。既に安定稼働中なので本 Phase では触らず、単独 follow-up にする
- bastion (Phase 4 で撤去) / vmagent・iperf3 (未稼働)
- 移管完了後の pi repo からの定義削除 → 7/7 予定の fallback 削除 PR に合流

## 設計方針

1. compose 置き場所: 本 repo (oci-compose) に **`apps-pi/<service>/`** を新設。private pi repo + GitHub App 案は不採用 (既存の public repo + Coolify env 投入フローと同一運用にする)
2. 1 service = 1 Coolify resource、server は「pi」(uuid `o2lzprfk2kz72zn4t0oqrrvg`、proxy=NONE)
3. pi 既存 traefik との連携: Coolify は pi に proxy を立てない (NONE)。routing が必要な kuma のみ、compose で external network **`pi_default`** に attach + 既存と同じ traefik labels を書く → pi の traefik (docker provider) がそのまま拾う
4. **service 名は現行と同一を維持** (network alias が service 名で付くため、将来 vmagent 等の scrape 設定を壊さない)
5. secret (PVE_* / RELAYHOST_*) は git に入れず Coolify env (`is_literal` 注意、`${VAR:?msg}` 構文は使わない — Coolify parser bug 回避)
6. data 移行は kuma のみ: 旧 bind dir を Coolify 側 volume path へ cp (gogs 移行と同じ「起動 → 停止 → data 展開 → 再起動」方式)
7. multi-port EXPOSE / Traefik service port 明示等、skill `ta.oci.add-app` の既知の落とし穴チェックリストを全 service で通す

## 移行順序 (リスク昇順)

```text
Step 1: 無状態 exporters 4 種 (cadvisor / pve / blackbox / speedtest)
Step 2: tor / tinyproxy
Step 3: uptime-kuma (data 移行あり)
Step 4: smtp 新設 (pi#3) + kuma の通知を smtp:587 に設定
各 step: 旧 container 停止 → Coolify deploy → 検証 → 次へ
```

## 検証項目

1. 各 exporter: `curl http://<container>:<port>/metrics` が pi_default 内から応答
2. cadvisor / pve-exporter: メトリクス内容が移行前と同等 (ラベル欠落なし)
3. uptime-kuma: `http://uptime.local` 到達 + 既存 monitor / 履歴が残っている
4. tinyproxy: ci1 upstream 経由で proxy 動作
5. smtp: kuma からの test 通知が Resend 経由で届く
6. 全体: `docker compose -f pi repo` 側に停止済み定義が残っていること (rollback 用)、Coolify UI で全 resource healthy

## ロールバック

pi repo の compose 定義は検証完了まで削除しない。失敗時は Coolify resource を stop し、pi 上で `docker compose up -d <service>` で即復旧 (data は kuma のみ注意: 移行後に kuma へ書き込まれた分は戻らない)。

## 実施しないと決めたこと (再掲)

- 全サービス移管 (基盤系の独立性優先)
- pi への Coolify 別建て (リソース・UI 分裂)
- private pi repo の GitHub App 接続 (運用を public + env 投入に統一)

## 承認後の作業ブロック

- [ ] apps-pi/ 8 ディレクトリ (7 移管 + smtp) の compose + README
- [ ] Coolify resource 8 件作成 (API、server=pi) + env 投入
- [ ] Step 1-4 の順次 cutover + 検証
- [ ] pi repo 側の削除 PR (7/7 合流) / vault note 更新 / #10 チェック
