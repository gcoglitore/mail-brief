#!/usr/bin/env python3
"""Mail Brief ↔ Beeper bridge.

Reads recent chats + messages from the local Beeper Desktop API (localhost:23373)
and publishes a compact snapshot to the Mail Brief Realtime Database so the phone
and desktop app can show Signal / Slack / WhatsApp / texts next to email.

Also drains an outbox: replies the user writes in the app are queued in the DB;
this bridge sends them through Beeper and clears them.

Runs on the Mac (where Beeper Desktop lives) — same "connector" role as the mail
pipeline. Local creds:
  ~/.beeper-token        Beeper API token (Settings → Integrations → +)
  ~/.mailbrief-sa.json   service-account key for DB writes
  ~/.mailbrief_access_key the access key (path segment)
"""

import json
import os
import ssl
import time
import urllib.parse
import urllib.request

try:
    import certifi
    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    SSL_CTX = ssl.create_default_context()

BEEPER = "http://localhost:23373"
DB_URL = "https://mail-brief-gio-default-rtdb.firebaseio.com"
HOME = os.path.expanduser("~")
MAX_CHATS = 25
MSGS_PER_CHAT = 12
PREVIEW_LEN = 140


def beeper_token():
    t = os.environ.get("BEEPER_ACCESS_TOKEN", "").strip()
    if t:
        return t
    with open(os.path.join(HOME, ".beeper-token")) as f:
        return f.read().strip()


def beeper_get(path, token):
    req = urllib.request.Request(BEEPER + path, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read() or b"null")


def beeper_post(path, token, payload):
    req = urllib.request.Request(
        BEEPER + path, data=json.dumps(payload).encode(), method="POST",
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read() or b"null")


def items_of(resp):
    """Beeper list endpoints wrap rows differently across versions — be liberal."""
    if isinstance(resp, list):
        return resp
    if isinstance(resp, dict):
        for k in ("items", "chats", "messages", "data", "results"):
            v = resp.get(k)
            if isinstance(v, list):
                return v
            if isinstance(v, dict):  # e.g. {results:{messages:{items:[...]}}}
                inner = items_of(v)
                if inner:
                    return inner
    return []


def to_epoch(ts):
    if not ts:
        return 0
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp())
    except Exception:
        return 0


def db_token():
    from google.oauth2 import service_account
    import google.auth.transport.requests
    creds = service_account.Credentials.from_service_account_file(
        os.path.join(HOME, ".mailbrief-sa.json"),
        scopes=["https://www.googleapis.com/auth/firebase.database",
                "https://www.googleapis.com/auth/userinfo.email"])
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def db_request(path, dbtok, method="GET", payload=None):
    req = urllib.request.Request(
        DB_URL + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        method=method,
        headers={"Authorization": "Bearer " + dbtok, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
        return json.loads(resp.read() or b"null")


def drain_outbox(key, btok, dbtok):
    """Send any replies the app queued, then clear them."""
    try:
        pending = db_request(f"/briefs/{key}/msg_outbox.json", dbtok) or {}
    except Exception:
        return 0
    sent = 0
    for oid, entry in (pending.items() if isinstance(pending, dict) else []):
        chat_id = (entry or {}).get("chatID")
        text = (entry or {}).get("text")
        if not chat_id or not text:
            db_request(f"/briefs/{key}/msg_outbox/{oid}.json", dbtok, method="DELETE")
            continue
        try:
            beeper_post(f"/v1/chats/{urllib.parse.quote(chat_id, safe='')}/messages", btok, {"text": text})
            db_request(f"/briefs/{key}/msg_outbox/{oid}.json", dbtok, method="DELETE")
            sent += 1
        except Exception as exc:
            print(f"send failed for {chat_id}: {exc}")
    return sent


def build_snapshot(btok):
    chats = items_of(beeper_get(f"/v1/chats?limit={MAX_CHATS * 2}", btok))
    chats = [c for c in chats if not c.get("isArchived")]
    chats.sort(key=lambda c: to_epoch(c.get("lastActivity")), reverse=True)
    chats = chats[:MAX_CHATS]

    out = []
    for c in chats:
        cid = c.get("id")
        if not cid:
            continue
        msgs = []
        try:
            raw = items_of(beeper_get(
                f"/v1/chats/{urllib.parse.quote(cid, safe='')}/messages?limit={MSGS_PER_CHAT}", btok))
            for m in raw:
                msgs.append({
                    "id": m.get("id"),
                    "text": (m.get("text") or "")[:2000],
                    "ts": to_epoch(m.get("timestamp")),
                    "sender": m.get("senderName") or ("You" if m.get("isSender") else "?"),
                    "is_me": bool(m.get("isSender")),
                    "kind": m.get("type") or "TEXT",
                })
        except Exception as exc:
            print(f"messages fetch failed for {cid}: {exc}")
        msgs.sort(key=lambda x: x["ts"])
        last = msgs[-1] if msgs else {}
        out.append({
            "id": cid,
            "network": c.get("network") or "",
            "title": c.get("title") or "(no title)",
            "group": c.get("type") == "group",
            "unread": int(c.get("unreadCount") or 0),
            "ts": to_epoch(c.get("lastActivity")) or last.get("ts", 0),
            "preview": ((("You: " if last.get("is_me") else "") + (last.get("text") or "")).strip()
                        or "(no text)")[:PREVIEW_LEN],
            "messages": msgs,
        })
    out.sort(key=lambda x: x["ts"], reverse=True)
    return {"generated_at": int(time.time()), "chats": out,
            "counts": {"unread": sum(c["unread"] for c in out), "chats": len(out)}}


def main():
    key = open(os.path.join(HOME, ".mailbrief_access_key")).read().strip()
    btok = beeper_token()
    dbtok = db_token()

    sent = drain_outbox(key, btok, dbtok)
    snap = build_snapshot(btok)
    db_request(f"/briefs/{key}/messages.json", dbtok, method="PUT", payload=snap)
    print(f"published {snap['counts']['chats']} chats "
          f"({snap['counts']['unread']} unread); sent {sent} queued reply(s)")


if __name__ == "__main__":
    main()
