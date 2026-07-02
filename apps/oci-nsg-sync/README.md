# oci-nsg-sync

oi1 上で 1 分間隔の cron で動き、 `aihara.online` apex の DNS A レコード (= 自宅 Starlink global IP) を OCI NSG の ingress rule 群 (`MANAGED_RULES`、 既定 443/tcp) の source CIDR に反映する。 ペア側の DDNS 更新は pi 上の `cloudflare-ddns` (favonia/cloudflare-ddns) が担当。

設計の全体像は vault `oci-home-only-nsg-ddns-2026.md` 参照。

## 仕組み

```text
1 min cron
  └─ sync.sh
       ├─ dig +short aihara.online @1.1.1.1   → home IP 取得
       ├─ /var/lib/oci-nsg-sync/last-ip と比較 → 変化なしなら no-op で exit 0
       ├─ CGNAT (100.64.0.0/10) 検出 → WARN 出すが処理は継続 (oci 側 update する意味は無いので別途撤退判断)
       ├─ oci network nsg-security-rule list で MANAGED_RULES の各 entry (protocol + port) に対応する rule を特定
       └─ oci network nsg-security-rule update で全 rule の source を <new IP>/32 に一括上書き
```

OCI API 認証は **instance principal** を使うので、 oi1 に API key を置く必要はない (metadata service `169.254.169.254` 経由で動的に認証情報を取得)。

## 必須 env

| 変数 | 必須 | 既定 | 説明 |
|---|---|---|---|
| `NSG_OCID` | はい | - | 対象 NSG (例: `nsg-home-only`) の OCID |
| `DDNS_DOMAIN` | いいえ | `aihara.online` | 解決する FQDN |
| `MANAGED_RULES` | いいえ | `443/tcp` | 管理対象 rule のカンマ区切りリスト (例: `443/tcp,51820/udp`)。各 entry に対応する rule が NSG に事前 bootstrap されている必要あり |
| `INGRESS_PORT` / `INGRESS_PROTOCOL` | いいえ | `443` / `6` | 旧 interface (後方互換)。`MANAGED_RULES` 指定時は無視される |
| `DNS_RESOLVER` | いいえ | `1.1.1.1` | DNS 解決に使う resolver |

NSG_OCID は Coolify UI の Environment Variables で投入する (`.env` には書かない、 secret ではないが env 管理を Coolify に寄せる方針)。

## OCI 事前作業 (1 回限り、 OCI コンソール手作業)

このコンテナを起動する前に、 以下を OCI コンソールで実施する。

### 1. Dynamic Group

OCI コンソール → Identity & Security → Domains → (Default) → Dynamic Groups → Create:

- Name: `dg-oi1-self-manage-nsg`
- Matching Rules:

```text
instance.id = 'ocid1.instance.oc1...<oi1 の OCID>'
```

oi1 の OCID は以下で取得:

```bash
ssh oi1 'curl -s -H "Authorization: Bearer Oracle" http://169.254.169.254/opc/v2/instance/id'
```

### 2. IAM Policy

OCI コンソール → Identity & Security → Policies → Create:

- Name: `policy-oi1-nsg-self-manage`
- Compartment: oi1 が属する compartment
- Statements:

```text
Allow dynamic-group dg-oi1-self-manage-nsg to manage network-security-groups in compartment <compartment-name>
Allow dynamic-group dg-oi1-self-manage-nsg to use virtual-network-family in compartment <compartment-name>
```

### 3. NSG 作成 + 初期 (dummy) ingress rule

OCI コンソール → Networking → VCNs → (oi1 の VCN) → Network Security Groups → Create:

- Name: `nsg-home-only`
- 作成後、 ingress rule を 1 件追加:
  - Source type: CIDR
  - Source: `127.0.0.1/32` (dummy、 後で sync.sh が上書き)
  - Protocol: TCP
  - Destination port range: 443
- egress: stateless No、 Destination CIDR `0.0.0.0/0`、 Protocol All

NSG 作成後、 OCID を控えて Coolify env に投入。

### 4. oi1 VNIC に attach

OCI コンソール → Compute → Instances → oi1 → Attached VNICs → primary VNIC → Edit VNIC:

- Network Security Groups → Add → `nsg-home-only` を選択

## Coolify 設定

- Resource Type: Docker Compose
- Git URL: `https://github.com/TakashiAihara/oci-compose.git`
- Branch: `main`
- Base Directory: `apps/oci-nsg-sync`
- Environment Variables:
  - `NSG_OCID`: 上記で控えた OCID

## 動作確認

```bash
# pi 側の DDNS が成功している前提
dig +short aihara.online @1.1.1.1
# → 自宅 global IP が返る

# oi1 上でログ確認
docker logs -f oci-nsg-sync-<coolify-suffix>
# 初回起動から 1 分以内に "change detected: <empty> -> <home IP>" + "updated NSG rule ... source -> <IP>/32"

# OCI 側で NSG ingress を直接確認
oci --auth instance_principal network nsg-security-rule list \
  --nsg-id $NSG_OCID --direction INGRESS --all | jq '.data[] | {source, "tcp-options"}'
```

## Security List 側の閉鎖 (cutover)

oci-nsg-sync が安定動作したら、 Security List 側の 443 0.0.0.0/0 ingress を削除する (NSG 側が allow しているので自宅からは到達可能なまま、 LAN 外 IP は弾かれる)。

OCI コンソール → Networking → VCNs → (oi1 の VCN) → Security Lists → Default Security List → Ingress Rules:

- Source `0.0.0.0/0` + Destination Port `443` の rule を削除
- 22/tcp (ssh) は残す (NSG 側に巻き込まない、 home IP 変動中の締め出し回避)

## トラブルシューティング

- `oci nsg-security-rule list failed`: IAM Policy の statements (manage network-security-groups + use virtual-network-family) を確認
- `no managed ingress rule found`: NSG に MANAGED_RULES の該当 entry の dummy rule が無い。OCI コンソール、または container 内から bootstrap する:

  ```bash
  # 例: 51820/udp を追加 (source は dummy でよい、次回 sync で home IP に上書きされる)
  sudo docker exec oci-nsg-sync-<suffix> oci --auth instance_principal network nsg rules add \
    --nsg-id $NSG_OCID --security-rules '[{"direction":"INGRESS","protocol":"17","source":"127.0.0.1/32","sourceType":"CIDR_BLOCK","isStateless":false,"udpOptions":{"destinationPortRange":{"min":51820,"max":51820}},"description":"managed by oci-nsg-sync (bootstrap)"}]'
  ```
- `IP is in CGNAT range`: Starlink が CGNAT に切り替わった、 DDNS 構成では救えないので Cloudflare Tunnel 化を検討
- `failed to resolve aihara.online`: pi 側の cloudflare-ddns が動いていない、 もしくは Cloudflare DNS の伝播待ち

## 撤退方法

1. Coolify でこの resource を停止
2. OCI コンソールで NSG ingress を `0.0.0.0/0` に手動戻し、 もしくは Security List 側の 443 0.0.0.0/0 を復活
3. (任意) NSG を VNIC から detach
