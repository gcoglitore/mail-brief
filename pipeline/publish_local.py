#!/usr/bin/env python3
"""Publish a Mail Brief JSON (built by the local Claude scheduled task from the
Gmail connector) to the Realtime Database, and buzz subscribed devices about
newly arrived attention mail.

Usage: python3 publish_local.py /path/to/brief.json

Local credentials (this Mac only):
  ~/.mailbrief-sa.json     service-account key for database writes
  ~/.mailbrief-vapid.pem   notification signing key (optional)
  ~/.mailbrief_access_key  the access key (path segment)
"""

import json
import os
import subprocess
import sys
import time
import urllib.request

DB_URL = "https://mail-brief-gio-default-rtdb.firebaseio.com"
HOME = os.path.expanduser("~")
REQUIRED_ITEM_FIELDS = {"account", "from_name", "from_email", "subject", "snippet", "ts", "bucket"}
VALID_BUCKETS = {"attention", "fyi", "junk"}


def get_token():
    """Mint an access token from the local service-account key (no external deps)."""
    try:
        from google.oauth2 import service_account
        import google.auth.transport.requests
        creds = service_account.Credentials.from_service_account_file(
            os.path.join(HOME, ".mailbrief-sa.json"),
            scopes=["https://www.googleapis.com/auth/firebase.database",
                    "https://www.googleapis.com/auth/userinfo.email"],
        )
        creds.refresh(google.auth.transport.requests.Request())
        return creds.token
    except ImportError:
        # fall back to gcloud's bundled python environment via CLI
        out = subprocess.run(
            ["gcloud", "auth", "print-access-token",
             "--impersonate-service-account=mail-brief-ci@mail-brief-gio.iam.gserviceaccount.com"],
            capture_output=True, text=True)
        if out.returncode == 0:
            return out.stdout.strip()
        raise SystemExit("No token path available: pip3 install --user google-auth")


def db_request(path, token, method="GET", payload=None):
    req = urllib.request.Request(
        DB_URL + path,
        data=json.dumps(payload).encode() if payload is not None else None,
        method=method,
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read() or b"null")


def item_id(i):
    return i.get("msgid") or "{}|{}|{}".format(i.get("from_email", ""), i.get("subject", ""), i.get("ts", ""))


def validate(brief):
    assert isinstance(brief.get("items"), list), "items must be a list"
    for i in brief["items"]:
        missing = REQUIRED_ITEM_FIELDS - set(i)
        assert not missing, f"item missing fields: {missing}"
        assert i["bucket"] in VALID_BUCKETS, f"bad bucket {i['bucket']}"
    brief["generated_at"] = int(brief.get("generated_at") or time.time())
    brief.setdefault("accounts", [])
    brief["counts"] = {b: sum(1 for i in brief["items"] if i["bucket"] == b) for b in VALID_BUCKETS}
    return brief


def send_pushes(new_items, key, token):
    pem = os.path.join(HOME, ".mailbrief-vapid.pem")
    if not os.path.exists(pem) or not new_items:
        return
    try:
        from pywebpush import webpush, WebPushException
    except ImportError:
        print("pywebpush not installed locally — skipping buzz (pip3 install --user pywebpush)")
        return
    subs = db_request(f"/briefs/{key}/subs.json", token) or {}
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
            webpush(subscription_info=sub, data=payload, vapid_private_key=pem,
                    vapid_claims={"sub": "mailto:gio@qlad.com"})
            sent += 1
        except WebPushException as exc:
            code = getattr(getattr(exc, "response", None), "status_code", None)
            if code in (404, 410):
                try:
                    db_request(f"/briefs/{key}/subs/{sid}.json", token, method="DELETE")
                except Exception:
                    pass
    print(f"buzzed {sent} device(s)")


def main():
    brief = validate(json.load(open(sys.argv[1])))
    key = open(os.path.join(HOME, ".mailbrief_access_key")).read().strip()
    token = get_token()

    prev = None
    try:
        prev = db_request(f"/briefs/{key}/brief.json", token)
    except Exception:
        pass
    prev_ids = ({item_id(i) for i in prev.get("items", []) if i.get("bucket") == "attention"}
                if prev else None)

    db_request(f"/briefs/{key}/brief.json", token, method="PUT", payload=brief)
    c = brief["counts"]
    print(f"published {len(brief['items'])} items "
          f"(attention {c['attention']}, fyi {c['fyi']}, junk {c['junk']})")

    if prev_ids is not None:
        new_attention = [i for i in brief["items"]
                         if i["bucket"] == "attention" and item_id(i) not in prev_ids]
        if new_attention:
            send_pushes(new_attention, key, token)


if __name__ == "__main__":
    main()
