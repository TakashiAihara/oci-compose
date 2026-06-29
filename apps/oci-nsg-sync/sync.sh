#!/bin/sh
set -eu

: "${NSG_OCID:?NSG_OCID required}"
DDNS_DOMAIN="${DDNS_DOMAIN:-aihara.online}"
INGRESS_PORT="${INGRESS_PORT:-443}"
INGRESS_PROTOCOL="${INGRESS_PROTOCOL:-6}"
DNS_RESOLVER="${DNS_RESOLVER:-1.1.1.1}"

STATE_DIR=/var/lib/oci-nsg-sync
mkdir -p "$STATE_DIR"
STATE_FILE="$STATE_DIR/last-ip"

ts() { date -u +'%Y-%m-%dT%H:%M:%SZ'; }
log() { echo "[$(ts)] $*"; }

NEW_IP=$(dig +short +time=3 +tries=2 "$DDNS_DOMAIN" @"$DNS_RESOLVER" | head -n1)
if [ -z "$NEW_IP" ]; then
  log "ERROR: failed to resolve $DDNS_DOMAIN via $DNS_RESOLVER"
  exit 1
fi

case "$NEW_IP" in
  *[!0-9.]*) log "ERROR: invalid IPv4 '$NEW_IP'"; exit 1 ;;
esac

case "$NEW_IP" in
  100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*)
    log "WARN: $NEW_IP is in CGNAT range (100.64.0.0/10); DDNS approach broken, consider Cloudflare Tunnel"
    ;;
esac

LAST_IP=""
if [ -f "$STATE_FILE" ]; then
  LAST_IP=$(cat "$STATE_FILE")
fi

if [ "$NEW_IP" = "$LAST_IP" ]; then
  exit 0
fi

log "change detected: ${LAST_IP:-<empty>} -> $NEW_IP"

RULES_JSON=$(oci --auth instance_principal network nsg-security-rule list \
  --nsg-id "$NSG_OCID" --direction INGRESS --all 2>&1) || {
  log "ERROR: oci nsg-security-rule list failed: $RULES_JSON"
  exit 1
}

EXISTING_RULE_ID=$(echo "$RULES_JSON" | jq -r \
  --arg port "$INGRESS_PORT" --arg proto "$INGRESS_PROTOCOL" \
  '.data[] | select(.protocol == $proto)
   | select(.["tcp-options"]["destination-port-range"]["min"] == ($port|tonumber))
   | select(.["tcp-options"]["destination-port-range"]["max"] == ($port|tonumber))
   | .id' 2>/dev/null | head -n1)

if [ -z "$EXISTING_RULE_ID" ] || [ "$EXISTING_RULE_ID" = "null" ]; then
  log "ERROR: no managed ingress rule found in NSG $NSG_OCID for protocol=$INGRESS_PROTOCOL port=$INGRESS_PORT; bootstrap a dummy rule first (see README)"
  exit 1
fi

NEW_CIDR="${NEW_IP}/32"

UPDATE_PAYLOAD=$(jq -n \
  --arg id "$EXISTING_RULE_ID" \
  --arg src "$NEW_CIDR" \
  --arg port "$INGRESS_PORT" \
  --arg proto "$INGRESS_PROTOCOL" \
  '[{
    "id": $id,
    "direction": "INGRESS",
    "protocol": $proto,
    "source": $src,
    "sourceType": "CIDR_BLOCK",
    "isStateless": false,
    "tcpOptions": {
      "destinationPortRange": {
        "min": ($port|tonumber),
        "max": ($port|tonumber)
      }
    },
    "description": "managed by oci-nsg-sync (auto-updated from " + env.DDNS_DOMAIN + ")"
  }]')

UPDATE_RESULT=$(oci --auth instance_principal network nsg-security-rule update \
  --nsg-id "$NSG_OCID" \
  --security-rules "$UPDATE_PAYLOAD" 2>&1) || {
  log "ERROR: oci nsg-security-rule update failed: $UPDATE_RESULT"
  exit 1
}

echo "$NEW_IP" > "$STATE_FILE"
log "updated NSG rule $EXISTING_RULE_ID source -> $NEW_CIDR"
