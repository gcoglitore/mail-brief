#!/usr/bin/env python3
"""Mail Brief pipeline: fetch recent mail from all configured accounts over IMAP,
classify each thread (attention / fyi / junk), and publish a compact JSON brief
to the Firebase Realtime Database under the private access-key path.

Configuration via environment variables (GitHub Actions secrets):
  MAIL_ACCOUNT_1..MAIL_ACCOUNT_8  "Label|email|imap_host|app_password"
  MAILBRIEF_ACCESS_KEY            private key segment of the database path
  FIREBASE_SERVICE_ACCOUNT        service-account JSON (writer credentials)
  ANTHROPIC_API_KEY               optional — enables Claude scoring
"""

import email
import email.header
import email.utils
import html as html_lib
import imaplib
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request

DB_URL = "https://mail-brief-gio-default-rtdb.firebaseio.com"
LOOKBACK_DAYS = 3
MAX_PER_ACCOUNT = 60
SNIPPET_LEN = 180
BODY_LEN = 6000  # full readable text cap; junk items never carry a body

JUNK_DOMAINS = (
    "goalphalabs.com", "orbitz.com", "reply.ebay.com", "learn.heygen.com",
    "email.heygen.com", "openrouter.ai", "mail.perplexity.ai",
    "info.arcesium.com", "htecgroup.com", "news.railway.app",
    "em1.cloudflare.com", "email.claude.com",
)
FYI_SENDERS = (
    "docusign.net", "github.com", "firebase-noreply@google.com",
    "no-reply@accounts.google.com", "stripe.com", "noreply",
    "drive-shares-dm-noreply",
)


def decode_header(value):
    if not value:
        return ""
    parts = email.header.decode_header(value)
    out = []
    for text, charset in parts:
        if isinstance(text, bytes):
            out.append(text.decode(charset or "utf-8", errors="replace"))
        else:
            out.append(text)
    return " ".join(out).strip()


def extract_text(msg):
    """Extract readable plain text (paragraphs preserved) from a message."""
    part = msg
    if msg.is_multipart():
        part = None
        for p in msg.walk():
            if p.get_content_type() == "text/plain":
                part = p
                break
        if part is None:
            for p in msg.walk():
                if p.get_content_type() == "text/html":
                    part = p
                    break
    if part is None:
        return ""
    try:
        payload = part.get_payload(decode=True) or b""
        text = payload.decode(part.get_content_charset() or "utf-8", errors="replace")
    except Exception:
        return ""
    if part.get_content_type() == "text/html":
        text = re.sub(r"<(style|script).*?</\1>", " ", text, flags=re.S | re.I)
        text = re.sub(r"<br\s*/?>|</p>|</div>|</tr>|</li>|</h[1-6]>", "\n", text, flags=re.I)
        text = re.sub(r"<[^>]+>", " ", text)
    text = html_lib.unescape(text)
    text = text.replace("‌", "").replace("͏", "")  # invisible padding chars
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" ?\n ?", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def heuristic_bucket(item, headers):
    sender = item["from_email"].lower()
    domain = sender.split("@")[-1]
    if any(domain.endswith(d) or d in sender for d in JUNK_DOMAINS):
        return "junk"
    bulk = bool(headers.get("List-Unsubscribe")) or \
        headers.get("Precedence", "").lower() in ("bulk", "list")
    if any(s in sender for s in FYI_SENDERS):
        return "fyi"
    if bulk:
        return "junk"
    return "attention"


def claude_refine(items, api_key):
    """Ask Claude to classify items the heuristics marked 'attention'.
    Falls back silently if the API call fails."""
    pending = [i for i in items if i["bucket"] == "attention"]
    if not pending:
        return
    listing = "\n".join(
        f'{n}. From: {i["from_name"]} <{i["from_email"]}> | Subject: {i["subject"]} | Snippet: {i["snippet"][:100]}'
        for n, i in enumerate(pending)
    )
    prompt = (
        "You triage email for Gio, a startup executive (QLAD cybersecurity, Sylabs). "
        "Real people, partners, legal, investors, meeting changes = attention. "
        "Automated-but-relevant (receipts, alerts, CI results, signature-complete notices) = fyi. "
        "Marketing, newsletters, cold sales = junk.\n"
        "Classify each numbered email. Reply ONLY with JSON: "
        '{"verdicts": [{"n": 0, "bucket": "attention|fyi|junk"}, ...]}\n\n' + listing
    )
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps({
            "model": "claude-haiku-4-5-20251001",
            "max_tokens": 2000,
            "messages": [{"role": "user", "content": prompt}],
        }).encode(),
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
        text = data["content"][0]["text"]
        match = re.search(r"\{.*\}", text, re.S)
        verdicts = json.loads(match.group(0))["verdicts"]
        for v in verdicts:
            n = v.get("n")
            bucket = v.get("bucket")
            if isinstance(n, int) and 0 <= n < len(pending) and bucket in ("attention", "fyi", "junk"):
                pending[n]["bucket"] = bucket
        print(f"Claude refined {len(verdicts)} classifications")
    except Exception as exc:  # scoring is best-effort
        print(f"Claude scoring skipped: {exc}")


def fetch_account(label, addr, host, password):
    items = []
    box = imaplib.IMAP4_SSL(host)
    box.login(addr, password)
    box.select("INBOX", readonly=True)
    since = time.strftime("%d-%b-%Y", time.gmtime(time.time() - LOOKBACK_DAYS * 86400))
    _, data = box.search(None, f"(SINCE {since})")
    ids = data[0].split()[-MAX_PER_ACCOUNT:]
    for mid in reversed(ids):
        _, msg_data = box.fetch(mid, "(RFC822 FLAGS)")
        raw = b""
        flags = ""
        for part in msg_data:
            if isinstance(part, tuple):
                raw = part[1]
                flags += part[0].decode(errors="replace")
            elif isinstance(part, bytes):
                flags += part.decode(errors="replace")
        msg = email.message_from_bytes(raw)
        from_name, from_email = email.utils.parseaddr(decode_header(msg.get("From")))
        date_ts = email.utils.parsedate_to_datetime(msg.get("Date")).timestamp() if msg.get("Date") else time.time()
        msgid = (msg.get("Message-ID") or "").strip("<> ")
        if "gmail" in host:
            link = f"https://mail.google.com/mail/u/{addr}/#search/rfc822msgid%3A{urllib.parse.quote(msgid)}"
        else:
            link = "https://mail.yahoo.com/d/folders/1"
        headers = {k: msg.get(k, "") for k in ("List-Unsubscribe", "Precedence")}
        reply_to = email.utils.parseaddr(decode_header(msg.get("Reply-To") or msg.get("From")))[1]
        refs = " ".join((msg.get("References") or "").split()[-5:])
        text = extract_text(msg)
        item = {
            "account": label,
            "from_name": from_name or from_email,
            "from_email": from_email,
            "subject": decode_header(msg.get("Subject")) or "(no subject)",
            "snippet": re.sub(r"\s+", " ", text)[:SNIPPET_LEN],
            "body": text[:BODY_LEN],
            "ts": int(date_ts),
            "unread": "\\Seen" not in flags,
            "link": link,
            "msgid": msgid,
            "reply_to": reply_to,
            "references": refs,
        }
        item["bucket"] = heuristic_bucket(item, headers)
        items.append(item)
    box.logout()
    return items


def item_id(i):
    return i.get("msgid") or "{}|{}|{}".format(i.get("from_email", ""), i.get("subject", ""), i.get("ts", ""))


def db_get(path, token):
    req = urllib.request.Request(DB_URL + path, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read() or b"null")


def previous_attention_ids(key, token):
    """IDs of attention items from the last published brief, or None on first run."""
    try:
        prev = db_get(f"/briefs/{key}/brief.json", token)
        if not prev:
            return None
        return {item_id(i) for i in prev.get("items", []) if i.get("bucket") == "attention"}
    except Exception:
        return None


def notify_subscribers(new_items, key, token):
    """Web-push a buzz to every subscribed device about newly arrived attention mail."""
    pem_path = os.environ.get("VAPID_PEM_PATH")
    claim = os.environ.get("VAPID_SUB")
    if not pem_path or not claim:
        return
    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        print("pywebpush not installed — skipping notifications")
        return
    try:
        subs = db_get(f"/briefs/{key}/subs.json", token) or {}
    except Exception:
        return
    if not subs:
        return
    if len(new_items) == 1:
        title, body = new_items[0]["from_name"], new_items[0]["subject"]
    else:
        title = f"{len(new_items)} important emails"
        body = "; ".join(i["from_name"] for i in new_items[:4])
    payload = json.dumps({"title": title[:80], "body": body[:180],
                          "url": "https://mail-brief-gio.web.app"})
    sent = 0
    for sid, rec in subs.items():
        sub = (rec or {}).get("sub")
        if not sub:
            continue
        try:
            webpush(subscription_info=sub, data=payload,
                    vapid_private_key=pem_path, vapid_claims={"sub": claim})
            sent += 1
        except WebPushException as exc:
            code = getattr(getattr(exc, "response", None), "status_code", None)
            if code in (404, 410):  # device unsubscribed — clean it up
                req = urllib.request.Request(f"{DB_URL}/briefs/{key}/subs/{sid}.json",
                                             method="DELETE",
                                             headers={"Authorization": "Bearer " + token})
                try:
                    urllib.request.urlopen(req, timeout=15)
                except Exception:
                    pass
    print(f"Notifications: buzzed {sent} device(s) about {len(new_items)} new item(s)")


def db_token(sa_json):
    from google.oauth2 import service_account
    import google.auth.transport.requests
    creds = service_account.Credentials.from_service_account_info(
        json.loads(sa_json),
        scopes=[
            "https://www.googleapis.com/auth/firebase.database",
            "https://www.googleapis.com/auth/userinfo.email",
        ],
    )
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token


def main():
    accounts = []
    for n in range(1, 9):
        raw = os.environ.get(f"MAIL_ACCOUNT_{n}")
        if raw and raw.count("|") == 3:
            accounts.append(raw.split("|", 3))
    if not accounts:
        print("No MAIL_ACCOUNT_N secrets configured — nothing to do.")
        sys.exit(0)

    all_items, statuses = [], []
    for label, addr, host, password in accounts:
        try:
            got = fetch_account(label.strip(), addr.strip(), host.strip(), password)
            all_items.extend(got)
            statuses.append({"account": label, "ok": True, "count": len(got)})
            print(f"{label}: {len(got)} messages")
        except Exception as exc:
            statuses.append({"account": label, "ok": False, "error": str(exc)[:200]})
            print(f"{label}: FAILED — {exc}")

    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if api_key:
        claude_refine(all_items, api_key)

    # junk never carries full text — keeps the brief lean and the cloud footprint small
    for i in all_items:
        if i["bucket"] == "junk":
            i.pop("body", None)

    all_items.sort(key=lambda i: i["ts"], reverse=True)
    brief = {
        "generated_at": int(time.time()),
        "accounts": statuses,
        "items": all_items,
        "counts": {b: sum(1 for i in all_items if i["bucket"] == b)
                   for b in ("attention", "fyi", "junk")},
    }

    key = os.environ["MAILBRIEF_ACCESS_KEY"].strip()
    token = db_token(os.environ["FIREBASE_SERVICE_ACCOUNT"])

    prev_ids = previous_attention_ids(key, token)

    req = urllib.request.Request(
        f"{DB_URL}/briefs/{key}/brief.json",
        data=json.dumps(brief).encode(),
        method="PUT",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        resp.read()
    print(f"Published {len(all_items)} items "
          f"(attention {brief['counts']['attention']}, fyi {brief['counts']['fyi']}, junk {brief['counts']['junk']})")

    if prev_ids is not None:
        new_attention = [i for i in all_items
                         if i["bucket"] == "attention" and item_id(i) not in prev_ids]
        if new_attention:
            notify_subscribers(new_attention, key, token)


if __name__ == "__main__":
    main()
