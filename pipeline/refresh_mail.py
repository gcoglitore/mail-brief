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
from html.parser import HTMLParser
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
BODY_LEN = 2500  # readable-text cap after quote/signature stripping; junk carries none

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


class _HTMLToText(HTMLParser):
    """Convert HTML to readable text with a real parser (handles nested tags and
    entities), inserting newlines at block boundaries and skipping style/script."""
    _BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6",
              "table", "ul", "ol", "blockquote", "section", "article", "header", "footer"}
    _SKIP = {"style", "script", "head", "title", "noscript"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._out = []
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._skip_depth += 1
        elif tag == "br" or tag in self._BLOCK:
            self._out.append("\n")

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._skip_depth:
            self._skip_depth -= 1
        elif tag in self._BLOCK:
            self._out.append("\n")

    def handle_data(self, data):
        if not self._skip_depth:
            self._out.append(data)

    def text(self):
        return "".join(self._out)


def html_to_text(html):
    parser = _HTMLToText()
    try:
        parser.feed(html)
        return parser.text()
    except Exception:  # never let a malformed document break the pipeline
        return html_lib.unescape(re.sub(r"<[^>]+>", " ", html))


# High-precision markers for where a quoted reply chain / signature begins. We cut
# at the earliest match so the brief shows only the new content the sender wrote.
_REPLY_MARKERS = [
    re.compile(r"^\s*On\b.{0,200}\bwrote:\s*$", re.M),          # Gmail/Apple reply
    re.compile(r"^\s*-{2,}\s*Original Message\s*-{2,}", re.M | re.I),  # Outlook
    re.compile(r"^\s*_{5,}\s*$", re.M),                          # Outlook web divider
    re.compile(r"^\s*From:\s.+\n\s*Sent:\s", re.M),             # Outlook forwarded header block (From line then Sent line)
    re.compile(r"^\s*-{2}\s*$", re.M),                           # standard signature "-- "
    re.compile(r"^\s*Sent from my \w+", re.M | re.I),
    re.compile(r"^\s*Get Outlook for \w+", re.M | re.I),
]


def strip_reply_chrome(text):
    """Trim quoted reply chains and signatures, but never trim a body down to
    almost nothing (guards against a marker matching high in a short message)."""
    cut = len(text)
    for rx in _REPLY_MARKERS:
        m = rx.search(text)
        if m:
            cut = min(cut, m.start())
    trimmed = text[:cut].rstrip()
    # Only refuse to trim when nothing readable would remain (e.g. a message that
    # is entirely a quoted chain) — short-but-real replies must still be trimmed.
    return trimmed if trimmed else text.strip()


def extract_text(msg):
    """Extract readable plain text (paragraphs preserved, quotes/signatures
    stripped) from a message, preferring text/plain then text/html."""
    def is_body(p):  # a body part, not a file attachment
        return not p.get_filename() and p.get_content_disposition() != "attachment"
    part = msg
    if msg.is_multipart():
        part = None
        for p in msg.walk():
            if p.get_content_type() == "text/plain" and is_body(p):
                part = p
                break
        if part is None:
            for p in msg.walk():
                if p.get_content_type() == "text/html" and is_body(p):
                    part = p
                    break
    if part is None:
        return ""
    try:
        payload = part.get_payload(decode=True) or b""
        charset = part.get_content_charset() or "utf-8"
        try:
            text = payload.decode(charset, errors="replace")
        except LookupError:  # unknown/invalid charset name — don't lose the body
            text = payload.decode("utf-8", errors="replace")
    except Exception:
        return ""
    if part.get_content_type() == "text/html":
        text = html_to_text(text)
    else:
        text = html_lib.unescape(text)
    text = text.replace("‌", "").replace("͏", "")  # invisible padding chars
    text = text.replace("\xa0", " ")  # normalize non-breaking spaces (&nbsp;)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r" ?\n ?", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = text.strip()
    return strip_reply_chrome(text)


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


def _ai_complete(prompt, anthropic_key, openrouter_key):
    """Return the model's text. Prefers OpenRouter (Gio's active key); falls back
    to the Anthropic API. Only the sender/subject/snippet is ever sent — never the
    full body. Returns None if no key is set."""
    if openrouter_key:
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/chat/completions",
            data=json.dumps({
                "model": "anthropic/claude-haiku-4.5",
                "max_tokens": 1500,
                "messages": [{"role": "user", "content": prompt}],
            }).encode(),
            headers={"Authorization": "Bearer " + openrouter_key, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())["choices"][0]["message"]["content"]
    if anthropic_key:
        req = urllib.request.Request(
            "https://api.anthropic.com/v1/messages",
            data=json.dumps({
                "model": "claude-haiku-4-5-20251001",
                "max_tokens": 1500,
                "messages": [{"role": "user", "content": prompt}],
            }).encode(),
            headers={"x-api-key": anthropic_key, "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read())["content"][0]["text"]
    return None


def claude_refine(items, anthropic_key, openrouter_key):
    """Ask the model to (a) re-classify attention items and (b) for each, name the
    ACTION the sender needs plus lightweight signals (reply/meeting/doc). Only the
    sender, subject, and a short snippet are sent — never the full body. Entirely
    best-effort: any failure leaves the heuristic classification untouched."""
    pending = [i for i in items if i["bucket"] == "attention"]
    if not pending:
        return
    listing = "\n".join(
        f'{n}. From: {i["from_name"]} <{i["from_email"]}> | Subject: {i["subject"]} | Snippet: {i["snippet"][:160]}'
        for n, i in enumerate(pending)
    )
    prompt = (
        "You triage email for Gio, a startup executive (QLAD cybersecurity, Sylabs). "
        "Real people, partners, legal, investors, meeting changes = attention. "
        "Automated-but-relevant (receipts, alerts, CI results, signature-complete notices) = fyi. "
        "Marketing, newsletters, cold sales = junk.\n"
        "For EACH numbered email return: n, bucket (attention|fyi|junk), "
        "summary (<= 8 words naming the ACTION the sender needs FROM Gio, e.g. "
        "'Needs your signature, page 4', 'Confirm Tues 10am', 'Review before merge'; "
        "empty string if purely informational), "
        "reply (true if it needs a reply from Gio), "
        "meeting (true if it's about a meeting or scheduling change), "
        "doc (true if a document needs his review or signature).\n"
        'Reply ONLY with JSON: {"verdicts":[{"n":0,"bucket":"attention",'
        '"summary":"...","reply":true,"meeting":false,"doc":true}]}\n\n' + listing
    )
    try:
        text = _ai_complete(prompt, anthropic_key, openrouter_key)
        if not text:
            return
        match = re.search(r"\{.*\}", text, re.S)
        verdicts = json.loads(match.group(0))["verdicts"]
        for v in verdicts:
            n = v.get("n")
            if not (isinstance(n, int) and 0 <= n < len(pending)):
                continue
            bucket = v.get("bucket")
            if bucket in ("attention", "fyi", "junk"):
                pending[n]["bucket"] = bucket
            summary = (v.get("summary") or "").strip()
            if summary:
                pending[n]["action_summary"] = summary[:80]
            pending[n]["signals"] = {
                "reply": bool(v.get("reply")),
                "meeting": bool(v.get("meeting")),
                "doc": bool(v.get("doc")),
            }
        print(f"AI refined {len(verdicts)} items")
    except Exception as exc:  # scoring is best-effort
        print(f"AI scoring skipped: {exc}")


def thread_key(msg, msgid):
    """A stable key grouping a message with its conversation: the thread root
    (first References id), else In-Reply-To, else the message's own id."""
    refs = (msg.get("References") or "").split()
    if refs:
        return refs[0].strip("<> ")
    irt = (msg.get("In-Reply-To") or "").strip("<> ")
    if irt:
        return irt
    return msgid or ""


def extract_attachments(msg):
    """List of {name, size} for any named parts (attachments / inline files)."""
    out = []
    if not msg.is_multipart():
        return out
    for p in msg.walk():
        name = p.get_filename()
        if not name:
            continue
        try:
            size = len(p.get_payload(decode=True) or b"")
        except Exception:
            size = 0
        out.append({"name": decode_header(name)[:80], "size": size})
        if len(out) >= 6:
            break
    return out


def group_threads(msgs):
    """Collapse received messages into one item per conversation. The latest
    message represents the thread; earlier ones become compact context, and the
    thread counts as unread if any message in it is unread."""
    threads, order = {}, []
    for m in msgs:
        k = m.get("thread_key") or m.get("msgid") or repr(m)
        if k not in threads:
            threads[k] = []
            order.append(k)
        threads[k].append(m)
    out = []
    for k in order:
        group = sorted(threads[k], key=lambda x: x.get("ts", 0))
        rep = group[-1]
        rep.pop("thread_key", None)
        rep["unread"] = any(m.get("unread") for m in group)
        # Escalate to the most important bucket in the thread so an auto-reply or
        # unsubscribe footer as the latest message can't bury an attention thread.
        rank = {"attention": 2, "fyi": 1, "junk": 0}
        best = max(group, key=lambda m: rank.get(m.get("bucket"), 0))
        rep["bucket"] = best.get("bucket", rep.get("bucket"))
        if len(group) > 1:
            rep["thread"] = [
                {"from": m.get("from_name", ""), "ts": m.get("ts", 0),
                 "snippet": (m.get("snippet") or "")[:140]}
                for m in group[:-1]
            ][-3:]
            rep["thread_count"] = len(group)
        out.append(rep)
    return out


def fetch_account(label, addr, host, password, group=True):
    items = []
    box = imaplib.IMAP4_SSL(host)
    box.login(addr, password.replace(" ", ""))
    box.select("INBOX", readonly=True)
    since = time.strftime("%d-%b-%Y", time.gmtime(time.time() - LOOKBACK_DAYS * 86400))
    _, data = box.search(None, f"(SINCE {since})")
    ids = data[0].split()[-MAX_PER_ACCOUNT:]
    skipped = 0
    for mid in reversed(ids):
        # Isolate per-message failures: one malformed/undecodable email must not
        # abort the whole account (which would then look "failed" and lose all mail).
        try:
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
            try:  # a malformed Date header must not drop the whole message
                date_ts = email.utils.parsedate_to_datetime(msg.get("Date")).timestamp() if msg.get("Date") else time.time()
            except Exception:
                date_ts = time.time()
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
                "thread_key": thread_key(msg, msgid),
            }
            atts = extract_attachments(msg)
            if atts:
                item["attachments"] = atts
            item["bucket"] = heuristic_bucket(item, headers)
            items.append(item)
        except Exception as exc:
            skipped += 1
            print(f"  {label}: skipped a malformed message ({str(exc)[:100]})")
    box.logout()
    if not group:
        for it in items:
            it.pop("thread_key", None)
        if skipped:
            print(f"  {label}: {skipped} message(s) skipped, {len(items)} kept (grouping off)")
        return items
    threads = group_threads(items)
    if skipped or len(threads) != len(items):
        print(f"  {label}: {len(items)} message(s) → {len(threads)} thread(s)" + (f", {skipped} skipped" if skipped else ""))
    return threads


def item_id(i):
    return i.get("msgid") or "{}|{}|{}".format(i.get("from_email", ""), i.get("subject", ""), i.get("ts", ""))


def db_get(path, token):
    req = urllib.request.Request(DB_URL + path, headers={"Authorization": "Bearer " + token})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read() or b"null")


def notify_subscribers(new_items, key, token, unread=None):
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
    payload_obj = {"title": title[:80], "body": body[:180],
                   "url": "https://mail-brief-gio.web.app"}
    if unread is not None:
        payload_obj["unread"] = int(unread)  # updates the home-screen icon badge
    payload = json.dumps(payload_obj)
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
            label, addr, host, password = raw.split("|", 3)
            # Normalize label/addr/host once so the failed-account data-loss guard
            # (which matches statuses' label against items' account) can't be
            # disarmed by stray whitespace. Password is left as-is (spaces stripped
            # later in fetch_account for app passwords).
            accounts.append([label.strip(), addr.strip(), host.strip(), password])
    if not accounts:
        print("No MAIL_ACCOUNT_N secrets configured — nothing to do.")
        sys.exit(0)

    key = os.environ["MAILBRIEF_ACCESS_KEY"].strip()
    token = db_token(os.environ["FIREBASE_SERVICE_ACCOUNT"])

    # Thread grouping is a user setting (Preferences → Group email threads),
    # stored in the DB so it applies on the next refresh. Default on.
    group_on = True
    try:
        s = db_get(f"/briefs/{key}/settings.json", token)
        if isinstance(s, dict) and s.get("group_threads") is False:
            group_on = False
    except Exception:
        pass
    print(f"Thread grouping: {'on' if group_on else 'off'}")

    all_items, statuses = [], []
    for label, addr, host, password in accounts:
        try:
            got = fetch_account(label.strip(), addr.strip(), host.strip(), password, group=group_on)
            all_items.extend(got)
            statuses.append({"account": label, "ok": True, "count": len(got)})
            print(f"{label}: {len(got)} messages")
        except Exception as exc:
            statuses.append({"account": label, "ok": False, "error": str(exc)[:200]})
            print(f"{label}: FAILED — {exc}")

    if not any(s.get("ok") for s in statuses):
        print("Every account failed to log in — keeping the previously published brief untouched.")
        sys.exit(0)

    anthropic_key = os.environ.get("ANTHROPIC_API_KEY")
    openrouter_key = os.environ.get("OPENROUTER_API_KEY")
    if anthropic_key or openrouter_key:
        claude_refine(all_items, anthropic_key, openrouter_key)

    # junk never carries full text — keeps the brief lean and the cloud footprint small
    for i in all_items:
        if i["bucket"] == "junk":
            i.pop("body", None)

    # Fetch the previously published brief once — reused for both the failed-account
    # merge below and the attention diff for push notifications.
    try:
        prev = db_get(f"/briefs/{key}/brief.json", token)
    except Exception:
        prev = None

    # DATA-LOSS GUARD: if an account failed to log in this run, keep its mail from
    # the last brief (flagged stale) rather than dropping it. A transient IMAP
    # hiccup on one account must never erase that account's inbox from the app.
    failed_labels = {s["account"] for s in statuses if not s.get("ok")}
    if failed_labels and isinstance(prev, dict) and isinstance(prev.get("items"), list):
        fresh_ids = {item_id(i) for i in all_items}
        kept = 0
        for i in prev["items"]:
            if i.get("account") in failed_labels and item_id(i) not in fresh_ids:
                i["stale"] = True
                all_items.append(i)
                kept += 1
        if kept:
            print(f"Preserved {kept} stale item(s) from failed account(s): {', '.join(sorted(failed_labels))}")

    all_items.sort(key=lambda i: i["ts"], reverse=True)
    brief = {
        "generated_at": int(time.time()),
        "accounts": statuses,
        "items": all_items,
        "counts": {b: sum(1 for i in all_items if i["bucket"] == b and not i.get("stale"))
                   for b in ("attention", "fyi", "junk")},
    }

    prev_ids = ({item_id(i) for i in prev.get("items", []) if i.get("bucket") == "attention"}
                if isinstance(prev, dict) else None)

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
            unread_total = sum(1 for i in all_items if i.get("unread") and not i.get("stale"))
            notify_subscribers(new_attention, key, token, unread=unread_total)


if __name__ == "__main__":
    main()
