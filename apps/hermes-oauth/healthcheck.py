"""Hermes gateway の healthcheck。.env に認証情報がある platform が、今の gateway プロセスで
connected になっているかを見る。

gateway は plugin の読み込みが時間切れになると、その platform を黙って外したまま動き続ける
(2026-10-05 の oi1 再起動で Telegram が抜けた)。gateway_state.json には前のプロセスが書いた
connected も残るので、writer_pid が今の pid のものだけを数える。

異常 / 回復に変わったときだけ ntfy の HERMES_ALERT_NTFY_TOPIC に 1 通送る。
apps/hermes と apps/hermes-oauth に同じものを置く (Coolify は base directory しか展開しない)。
"""
import json
import os
import sys
import time
import urllib.request

DATA = "/opt/data"
STATE = "/tmp/hermes-health-state"
# 起動直後は plugin の読み込み中で未接続が正常。ホスト再起動時は gateway の起動に 7 分かかった
GRACE_SECS = 900
CRED_KEYS = {
    "matrix": "MATRIX_ACCESS_TOKEN",
    "telegram": "TELEGRAM_BOT_TOKEN",
    "ntfy": "NTFY_TOPIC",
    "slack": "SLACK_BOT_TOKEN",
}


def read_env():
    env = {}
    with open(f"{DATA}/.env") as f:
        for line in f:
            k, sep, v = line.strip().partition("=")
            if sep and not k.startswith("#"):
                env[k] = v
    return env


def problems(env):
    expected = [p for p, k in CRED_KEYS.items() if env.get(k)]
    try:
        with open(f"{DATA}/gateway_state.json") as f:
            st = json.load(f)
    except (OSError, ValueError) as e:
        return [f"gateway_state.json を読めない: {e}"]
    pid = st.get("pid")
    if st.get("gateway_state") != "running" or not os.path.exists(f"/proc/{pid}"):
        return [f"gateway が動いていない (state={st.get('gateway_state')} pid={pid})"]
    out = []
    for p in expected:
        e = (st.get("platforms") or {}).get(p) or {}
        if e.get("writer_pid") != pid or e.get("state") != "connected":
            out.append(f"{p} 未接続 (state={e.get('state')} writer_pid={e.get('writer_pid')} pid={pid})")
    return out


def uptime():
    with open("/proc/uptime") as f:
        host_up = float(f.read().split()[0])
    with open("/proc/1/stat") as f:
        start_ticks = int(f.read().rsplit(")", 1)[1].split()[19])
    return host_up - start_ticks / os.sysconf("SC_CLK_TCK")


def notify(env, title, body):
    topic, token = env.get("HERMES_ALERT_NTFY_TOPIC"), env.get("HERMES_ALERT_NTFY_TOKEN")
    if not (topic and token):
        return
    req = urllib.request.Request(
        f"{env.get('HERMES_ALERT_NTFY_URL', 'http://ntfy')}/{topic}", data=body.encode(), method="POST",
        headers={"Authorization": f"Bearer {token}", "Title": title.encode().decode("latin-1", "replace"),
                 "Tags": "warning"})
    try:
        urllib.request.urlopen(req, timeout=10)
    except OSError as e:
        print(f"ntfy への通知に失敗: {e}", file=sys.stderr)


def main():
    env = read_env()
    name = os.environ.get("HERMES_INSTANCE", "hermes")
    bad = problems(env)
    if bad and uptime() < GRACE_SECS:
        print("起動直後のため判定を保留: " + "; ".join(bad))
        return 0
    prev = open(STATE).read().strip() if os.path.exists(STATE) else "ok"
    now = "bad" if bad else "ok"
    if now != prev:
        if bad:
            notify(env, f"{name}: 異常", "\n".join(bad))
        else:
            notify(env, f"{name}: 回復", "全 platform が接続済み")
        with open(STATE, "w") as f:
            f.write(now)
    print("; ".join(bad) if bad else "ok")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
