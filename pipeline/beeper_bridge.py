#!/usr/bin/env python3
"""Mail Brief messages bridge — runs on the Mac, the "connector".

Pulls conversations from two sources and publishes one merged snapshot to the
Realtime Database so the phone/desktop app shows them next to email:

  • Beeper Desktop API (Signal / Slack / WhatsApp / …) — needs ~/.beeper-token
  • iMessage / SMS — read straight from this Mac's own Messages database
    (~/Library/Messages/chat.db). No Apple-ID re-registration → no ban risk.
    Requires Full Disk Access for whatever runs this script.

Also drains an outbox: replies written in the app are queued in the DB; this
sends them (Beeper API for Beeper chats, the Messages app for iMessage) and
clears them. Outbox entries are routed by chat id — "imsg:" prefix = iMessage.

Local creds: ~/.beeper-token, ~/.mailbrief-sa.json, ~/.mailbrief_access_key
"""

import json
import os
import re
import sqlite3
import ssl
import subprocess
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
CHATDB = os.path.join(HOME, "Library/Messages/chat.db")
LOOKBACK_DAYS = 30
MAX_CHATS = 40
MSGS_PER_CHAT = 15
APPLE_EPOCH = 978307200  # 2001-01-01 in unix time


# ---------- Beeper ----------
def beeper_token():
    t = os.environ.get("BEEPER_ACCESS_TOKEN", "").strip()
    if t:
        return t
    try:
        with open(os.path.join(HOME, ".beeper-token")) as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


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
    if isinstance(resp, list):
        return resp
    if isinstance(resp, dict):
        for k in ("items", "chats", "messages", "data", "results"):
            v = resp.get(k)
            if isinstance(v, list):
                return v
            if isinstance(v, dict):
                inner = items_of(v)
                if inner:
                    return inner
    return []


def iso_epoch(ts):
    if not ts:
        return 0
    try:
        from datetime import datetime
        return int(datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp())
    except Exception:
        return 0


def build_beeper_chats(token):
    if not token:
        return []
    try:
        chats = items_of(beeper_get(f"/v1/chats?limit={MAX_CHATS * 2}", token))
    except Exception as exc:
        print(f"Beeper unavailable: {exc}")
        return []
    chats = [c for c in chats if not c.get("isArchived")]
    chats.sort(key=lambda c: iso_epoch(c.get("lastActivity")), reverse=True)
    out = []
    for c in chats[:MAX_CHATS]:
        cid = c.get("id")
        if not cid:
            continue
        msgs = []
        try:
            raw = items_of(beeper_get(
                f"/v1/chats/{urllib.parse.quote(cid, safe='')}/messages?limit={MSGS_PER_CHAT}", token))
            for m in raw:
                msgs.append({"id": m.get("id"), "text": (m.get("text") or "")[:2000],
                             "ts": iso_epoch(m.get("timestamp")),
                             "sender": m.get("senderName") or ("You" if m.get("isSender") else "?"),
                             "is_me": bool(m.get("isSender")), "kind": m.get("type") or "TEXT"})
        except Exception:
            pass
        msgs.sort(key=lambda x: x["ts"])
        last = msgs[-1] if msgs else {}
        out.append({"id": cid, "network": c.get("network") or "", "title": c.get("title") or "(no title)",
                    "group": c.get("type") == "group", "unread": int(c.get("unreadCount") or 0),
                    "ts": iso_epoch(c.get("lastActivity")) or last.get("ts", 0),
                    "preview": ((("You: " if last.get("is_me") else "") + (last.get("text") or "")).strip() or "(no text)")[:140],
                    "messages": msgs})
    return out


# ---------- iMessage (local chat.db) ----------
def attr_text(blob):
    """Extract the visible text from a streamtyped NSAttributedString blob.
    macOS Ventura+ stores message text here instead of the plain `text` column."""
    if not blob:
        return ""
    try:
        i = blob.find(b"NSString")
        if i == -1:
            return ""
        plus = blob.find(b"\x2b", i)  # the '+' marker precedes the length-prefixed string
        if plus == -1:
            return ""
        p = plus + 1
        b0 = blob[p]
        if b0 == 0x81:
            ln = int.from_bytes(blob[p + 1:p + 3], "little"); start = p + 3
        elif b0 == 0x82:
            ln = int.from_bytes(blob[p + 1:p + 4], "little"); start = p + 4
        else:
            ln = b0; start = p + 1
        return blob[start:start + ln].decode("utf-8", "replace")
    except Exception:
        return ""


def apple_ts_to_epoch(d):
    if not d:
        return 0
    return int(d / 1e9 + APPLE_EPOCH) if d > 1e12 else int(d + APPLE_EPOCH)


def norm_handle(h):
    if not h:
        return ""
    if "@" in h:
        return h.strip().lower()
    digits = re.sub(r"\D", "", h)
    return digits[-10:] if len(digits) >= 10 else digits


def load_contacts():
    """Map phone/email → contact name from the Mac's Address Book (needs FDA)."""
    import glob
    names = {}
    paths = glob.glob(os.path.join(HOME, "Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb"))
    paths += glob.glob(os.path.join(HOME, "Library/Application Support/AddressBook/AddressBook-v22.abcddb"))
    for p in paths:
        try:
            con = sqlite3.connect(f"file:{p}?mode=ro&immutable=1", uri=True)
            rows = con.execute("""
                SELECT r.ZFIRSTNAME, r.ZLASTNAME, r.ZORGANIZATION, ph.ZFULLNUMBER, em.ZADDRESS
                FROM ZABCDRECORD r
                LEFT JOIN ZABCDPHONENUMBER ph ON ph.ZOWNER = r.Z_PK
                LEFT JOIN ZABCDEMAILADDRESS em ON em.ZOWNER = r.Z_PK
            """).fetchall()
            con.close()
            for first, last, org, phone, email in rows:
                name = (" ".join(x for x in (first, last) if x).strip()) or (org or "")
                if not name:
                    continue
                if phone:
                    names.setdefault(norm_handle(phone), name)
                if email:
                    names.setdefault(norm_handle(email), name)
        except Exception:
            continue
    return names


def display_name(handle, contacts):
    return contacts.get(norm_handle(handle)) or handle


def is_sendable_handle(ident):
    return bool(ident) and ("@" in ident or ident.startswith("+") or re.fullmatch(r"[0-9 ()\-+]{7,}", ident or ""))


def build_imessage_chats():
    if not os.path.exists(CHATDB):
        return []
    since = int(time.time()) - LOOKBACK_DAYS * 86400
    since_apple_ns = int((since - APPLE_EPOCH) * 1e9)
    try:
        con = sqlite3.connect(f"file:{CHATDB}?mode=ro&immutable=1", uri=True)
    except sqlite3.OperationalError as exc:
        print(f"iMessage db not readable (needs Full Disk Access): {exc}")
        return []
    con.row_factory = sqlite3.Row
    rows = con.execute("""
        SELECT c.ROWID AS chat_id, c.chat_identifier, c.display_name, c.style,
               m.ROWID AS msg_id, m.text, m.attributedBody, m.is_from_me, m.date,
               m.service AS service, h.id AS handle
        FROM chat c
        JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
        JOIN message m ON m.ROWID = cmj.message_id
        LEFT JOIN handle h ON h.ROWID = m.handle_id
        WHERE m.date > ?
        ORDER BY m.date DESC
    """, (since_apple_ns,)).fetchall()
    con.close()
    contacts = load_contacts()

    chats = {}
    for r in rows:
        cid = r["chat_id"]
        ch = chats.setdefault(cid, {"identifier": r["chat_identifier"], "display": r["display_name"],
                                    "group": r["style"] == 43, "service": r["service"] or "", "msgs": []})
        if len(ch["msgs"]) >= MSGS_PER_CHAT:
            continue
        text = r["text"] or attr_text(r["attributedBody"])
        if not text:
            continue
        ch["msgs"].append({"id": str(r["msg_id"]), "text": text[:2000], "ts": apple_ts_to_epoch(r["date"]),
                           "sender": "You" if r["is_from_me"] else display_name(r["handle"], contacts),
                           "is_me": bool(r["is_from_me"]), "kind": "TEXT"})

    out = []
    for cid, ch in chats.items():
        if not ch["msgs"]:
            continue
        ch["msgs"].sort(key=lambda x: x["ts"])
        last = ch["msgs"][-1]
        ident = ch["identifier"] or ""
        net = "imessage" if str(ch["service"]).lower() == "imessage" else "sms"
        title = ch["display"] or (display_name(ident, contacts) if not ch["group"] else ident) or "(unknown)"
        out.append({"id": "imsg:" + ident, "network": net, "title": title,
                    "group": ch["group"], "unread": 0,  # chat.db read-state is unreliable; leave 0
                    "ts": last["ts"], "sendable": is_sendable_handle(ident) and not ch["group"],
                    "preview": ((("You: " if last["is_me"] else "") + last["text"]).strip() or "(no text)")[:140],
                    "messages": ch["msgs"]})
    out.sort(key=lambda x: x["ts"], reverse=True)
    return out[:MAX_CHATS]


def send_imessage(handle, text):
    script = ('on run {h, t}\n'
              ' tell application "Messages"\n'
              '  set svc to 1st service whose service type = iMessage\n'
              '  send t to buddy h of svc\n'
              ' end tell\n'
              'end run')
    subprocess.run(["osascript", "-e", script, handle, text], check=True, capture_output=True, timeout=25)


# ---------- DB ----------
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
        DB_URL + path, data=json.dumps(payload).encode() if payload is not None else None,
        method=method, headers={"Authorization": "Bearer " + dbtok, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30, context=SSL_CTX) as resp:
        return json.loads(resp.read() or b"null")


def drain_outbox(key, btok, dbtok):
    try:
        pending = db_request(f"/briefs/{key}/msg_outbox.json", dbtok) or {}
    except Exception:
        return 0
    sent = 0
    for oid, entry in (pending.items() if isinstance(pending, dict) else []):
        entry = entry or {}
        chat_id = entry.get("chatID")
        action = entry.get("action") or "send"
        text = entry.get("text")
        cq = urllib.parse.quote(chat_id, safe="") if chat_id else ""
        if not chat_id or (action == "send" and not text):
            db_request(f"/briefs/{key}/msg_outbox/{oid}.json", dbtok, method="DELETE")
            continue
        try:
            if action == "read":
                # Mark the conversation read in Beeper (syncs to the real service).
                if chat_id.startswith("imsg:"):
                    pass  # iMessage read-state isn't writable from here — just clear the queue entry
                elif btok:
                    beeper_post(f"/v1/chats/{cq}/read", btok, {})
                else:
                    continue  # need a Beeper token — leave queued
            else:  # send a reply
                if chat_id.startswith("imsg:"):
                    send_imessage(chat_id[5:], text)
                elif btok:
                    beeper_post(f"/v1/chats/{cq}/messages", btok, {"text": text})
                else:
                    continue  # Beeper send needs a token we don't have yet — leave queued
            db_request(f"/briefs/{key}/msg_outbox/{oid}.json", dbtok, method="DELETE")
            sent += 1
        except Exception as exc:
            print(f"{action} failed for {chat_id}: {exc}")
    return sent


def main():
    key = open(os.path.join(HOME, ".mailbrief_access_key")).read().strip()
    btok = beeper_token()
    dbtok = db_token()

    sent = drain_outbox(key, btok, dbtok)

    beeper_chats = build_beeper_chats(btok)
    imsg_chats = build_imessage_chats()
    chats = beeper_chats + imsg_chats

    # Preserve a source that produced NOTHING this run (e.g. launchd python without
    # Full Disk Access → iMessage empty, or Beeper momentarily down) so one failing
    # source can't wipe the OTHER source's already-published chats. Previously the
    # guard only fired when BOTH were empty, so a partial failure silently wiped
    # half the messages.
    if not beeper_chats or not imsg_chats:
        try:
            existing = db_request(f"/briefs/{key}/messages.json", dbtok)
            prev = (existing or {}).get("chats") or []
        except Exception:
            prev = []
        IMSG = {"imessage", "sms"}
        if not imsg_chats:
            kept = [c for c in prev if c.get("network") in IMSG]
            if kept:
                chats += kept
                print(f"iMessage empty this run — preserved {len(kept)} prior iMessage/SMS chats")
        if not beeper_chats:
            kept = [c for c in prev if c.get("network") not in IMSG]
            if kept:
                chats += kept
                print(f"Beeper empty this run — preserved {len(kept)} prior DM chats")

    if not chats:
        print("0 chats this run and nothing to preserve — no overwrite")
        return

    chats.sort(key=lambda c: c.get("ts", 0), reverse=True)
    snap = {"generated_at": int(time.time()), "chats": chats,
            "counts": {"unread": sum(c.get("unread", 0) for c in chats), "chats": len(chats)}}
    db_request(f"/briefs/{key}/messages.json", dbtok, method="PUT", payload=snap)
    n_imsg = sum(1 for c in chats if c.get("network") == "imessage")
    print(f"published {len(chats)} chats ({n_imsg} iMessage); sent {sent} queued reply(s)")


if __name__ == "__main__":
    main()
