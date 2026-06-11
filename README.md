# Mail Brief

Private unified inbox for Gio — all accounts on one screen, important mail on top,
junk buried. Seventh member of the Brief family.

**Live at:** https://mail-brief-gio.web.app (requires the access key)

## How it works

```
GitHub Actions (every 30 min)
  └─ pipeline/refresh_mail.py
       ├─ fetches recent inbox mail from each account over IMAP
       ├─ classifies: attention / fyi / junk  (Claude if ANTHROPIC_API_KEY set,
       │   sender/header heuristics otherwise)
       └─ publishes compact JSON to Firebase Realtime Database
            └─ /briefs/<ACCESS KEY>   (database denies everything else)

public/index.html (Firebase Hosting, deployed on push)
  └─ asks for the access key once per device, then renders the brief
```

No mail content is ever committed to this repo or served from Hosting —
only the Realtime Database holds it, behind the unguessable key path.

## Secrets (repo → Settings → Secrets and variables → Actions)

| Secret | Format |
|---|---|
| `MAIL_ACCOUNT_1` … `MAIL_ACCOUNT_6` | `Label\|email\|imap_host\|app_password` e.g. `QLAD\|gio@qlad.com\|imap.gmail.com\|abcdefghijklmnop` |
| `MAILBRIEF_ACCESS_KEY` | the private key segment of the database path |
| `FIREBASE_SERVICE_ACCOUNT` | service-account JSON used to write the database and deploy hosting |
| `ANTHROPIC_API_KEY` | optional — turns on Claude classification |

IMAP hosts: Gmail/Workspace = `imap.gmail.com` (app password requires 2-Step
Verification), Yahoo = `imap.mail.yahoo.com` (app password from Account Security).

**After adding or changing MAIL_ACCOUNT secrets**, run BOTH workflows from the
Actions tab: "Refresh Mail Brief" (starts fetching) and "Deploy Reply Function"
(bakes the credentials into the reply sender — it only reads secrets at deploy
time). The same app password powers both reading and replying.

## Replying

The Reply button POSTs to `/api/send` (Cloud Function `sendReply`, us-central1).
Gate: the access key, checked with a timing-safe compare; 20 sends/hour cap;
browser calls restricted to the app's origin. Replies thread correctly via
In-Reply-To/References. Rotate the access key to revoke instantly.

## Rotating the access key

Generate a new random key, update the `MAILBRIEF_ACCESS_KEY` secret, run the
"Refresh Mail Brief" workflow, delete the old path from the database, and enter
the new key on each device.
