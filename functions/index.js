// Mail Brief reply sender.
// POST { key, account, to, subject, body, inReplyTo, references }
// Auth = the same access key that unlocks the brief. Accounts and their app
// passwords arrive as MAIL_ACCOUNT_N env vars set at deploy time from the
// repo's GitHub secrets — the single place credentials are managed.
const functions = require('@google-cloud/functions-framework');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const sentLog = []; // in-memory send timestamps; resets on cold start
let lastDispatch = 0; // cooldown for update-now requests

function keyOk(given) {
  const expected = process.env.MAILBRIEF_ACCESS_KEY || '';
  if (!given || !expected) return false;
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function findAccount(label) {
  for (let n = 1; n <= 8; n++) {
    const raw = process.env['MAIL_ACCOUNT_' + n];
    if (!raw) continue;
    const parts = raw.split('|');
    if (parts.length === 4 && parts[0].trim() === label) {
      return {
        email: parts[1].trim(),
        smtpHost: parts[2].trim().replace(/^imap\./, 'smtp.'),
        password: parts[3].replace(/\s+/g, ''),
      };
    }
  }
  return null;
}

functions.http('sendReply', async (req, res) => {
  // Browser calls are restricted to the Mail Brief site itself; the access
  // key (checked below) is the real gate for all callers.
  res.set('Access-Control-Allow-Origin', 'https://mail-brief-gio.web.app');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { key, account, to, subject, body, inReplyTo, references, action } = req.body || {};
  if (!keyOk(key)) return res.status(401).json({ error: 'bad key' });

  if (action === 'refresh') {
    // "Update now": kick the mail-check workflow immediately.
    const ghToken = process.env.GH_DISPATCH_TOKEN;
    if (!ghToken) {
      return res.status(503).json({ error: 'update-now not set up yet — add the GH_DISPATCH_TOKEN secret and redeploy' });
    }
    if (Date.now() - lastDispatch < 120000) {
      return res.json({ ok: true, note: 'already checking' });
    }
    const r = await fetch(
      'https://api.github.com/repos/gcoglitore/mail-brief/actions/workflows/refresh-mail.yml/dispatches',
      {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + ghToken,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'mail-brief',
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ref: 'main' }),
      }
    );
    if (r.status === 204) {
      lastDispatch = Date.now();
      return res.json({ ok: true });
    }
    return res.status(502).json({ error: 'GitHub answered ' + r.status });
  }

  const now = Date.now();
  while (sentLog.length && now - sentLog[0] > 3600000) sentLog.shift();
  if (sentLog.length >= 20) return res.status(429).json({ error: 'too many sends this hour' });

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(to || ''))) {
    return res.status(400).json({ error: 'bad recipient address' });
  }
  if (!body || String(body).length > 20000) {
    return res.status(400).json({ error: 'message body missing or too long' });
  }
  const acct = findAccount(String(account || ''));
  if (!acct) {
    return res.status(404).json({ error: 'account not connected — add its app password secret first' });
  }

  const transporter = nodemailer.createTransport({
    host: acct.smtpHost,
    port: 465,
    secure: true,
    auth: { user: acct.email, pass: acct.password },
  });

  const msg = {
    from: acct.email,
    to: String(to),
    subject: String(subject || '').slice(0, 300),
    text: String(body),
  };
  if (inReplyTo) {
    const id = '<' + String(inReplyTo).replace(/[<>]/g, '') + '>';
    msg.inReplyTo = id;
    msg.references = (references ? String(references).slice(0, 2000) + ' ' : '') + id;
  }

  try {
    await transporter.sendMail(msg);
    sentLog.push(now);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'send failed: ' + ((e && e.message) || 'unknown') });
  }
});
