// Mail Brief reply sender.
// POST { key, account, to, subject, body, inReplyTo, references }
// Auth = the same access key that unlocks the brief. Accounts and their app
// passwords arrive as MAIL_ACCOUNT_N env vars set at deploy time from the
// repo's GitHub secrets — the single place credentials are managed.
const functions = require('@google-cloud/functions-framework');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
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
        imapHost: parts[2].trim(),
        smtpHost: parts[2].trim().replace(/^imap\./, 'smtp.'),
        password: parts[3].replace(/\s+/g, ''),
      };
    }
  }
  return null;
}

// Find a message's UIDs by its Message-ID. Gmail's IMAP ignores plain
// HEADER MESSAGE-ID searches, so for Gmail use its native rfc822msgid: search;
// fall back to the standard header search (works for Yahoo and others).
async function findUids(client, isGmail, id) {
  if (isGmail) {
    try {
      const u = await client.search({ gmailRaw: 'rfc822msgid:' + id }, { uid: true });
      if (u && u.length) return u;
    } catch (_) { /* fall through to header search */ }
  }
  return (await client.search({ header: { 'message-id': id } }, { uid: true })) || [];
}

// Gio's voice, for AI-drafted replies.
const GIO_PERSONA =
  "You draft replies AS Giovanni \"Gio\" Coglitore. He is founder/CEO of QLAD (a " +
  "cybersecurity / national-security company) and is also involved with Sylabs and " +
  "partners including Hitachi Ventures, Jabil, Matrice.ai, Divergent Space, DIU and the " +
  "defense community. His voice: direct, concise, warm but no fluff, action-oriented — he " +
  "gets to the point fast and is friendly with partners. He typically signs emails simply " +
  "\"Gio\". For chat messages (Signal/Slack/iMessage) keep it short and casual with NO sign-off. " +
  "Never invent facts, numbers, dates, or commitments; if a specific detail is needed but " +
  "unknown, leave a short [bracketed placeholder]. Match the formality of the incoming message.";

async function draftReplies(kind, sender, subject, bodyText, intent) {
  const orKey = process.env.OPENROUTER_API_KEY;   // preferred — one key, easy signup
  const anthKey = process.env.ANTHROPIC_API_KEY;  // fallback — direct Anthropic
  if (!orKey && !anthKey) {
    return { error: 'AI drafting not set up — add an OPENROUTER_API_KEY (or ANTHROPIC_API_KEY) secret and redeploy' };
  }
  const user =
    `Incoming ${kind === 'message' ? 'chat message' : 'email'}:\n` +
    `From: ${sender || '?'}\n` + (subject ? `Subject: ${subject}\n` : '') +
    `Message:\n${(bodyText || '').slice(0, 4000)}\n\n` +
    (intent ? `Gio's intent for the reply: ${intent}\n\n` : '') +
    `Write 3 ready-to-send reply options in Gio's voice, of varying tone (1: brief/affirmative, ` +
    `2: a little more detailed, 3: a polite defer or a clarifying question). ` +
    `${kind === 'message' ? 'Short and casual, no sign-off.' : 'Email style; sign as "Gio".'} ` +
    `Reply with ONLY JSON: {"options":["...","...","..."]}`;
  try {
    let text;
    if (orKey) {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + orKey, 'Content-Type': 'application/json',
          'HTTP-Referer': 'https://mail-brief-gio.web.app', 'X-Title': 'Mail Brief' },
        body: JSON.stringify({ model: 'anthropic/claude-fable-5', max_tokens: 600,
          messages: [{ role: 'system', content: GIO_PERSONA }, { role: 'user', content: user }] }),
      });
      const d = await r.json();
      text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (!text) return { error: 'openrouter: ' + JSON.stringify(d && d.error ? d.error : d).slice(0, 400) };
    } else {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 600,
          system: GIO_PERSONA, messages: [{ role: 'user', content: user }] }),
      });
      const d = await r.json();
      text = d && d.content && d.content[0] && d.content[0].text;
    }
    if (!text) return { error: 'no draft returned' };
    const m = text.match(/\{[\s\S]*\}/);
    const opts = m ? JSON.parse(m[0]).options : null;
    if (!Array.isArray(opts) || !opts.length) return { error: 'could not parse draft' };
    return { options: opts.slice(0, 3).map(o => String(o).slice(0, 2000)) };
  } catch (e) {
    return { error: 'draft failed: ' + ((e && e.message) || 'unknown') };
  }
}

functions.http('sendReply', async (req, res) => {
  // Browser calls are restricted to the Mail Brief site itself; the access
  // key (checked below) is the real gate for all callers.
  res.set('Access-Control-Allow-Origin', 'https://mail-brief-gio.web.app');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { key, account, to, subject, body, inReplyTo, references, action, msgid } = req.body || {};
  if (!keyOk(key)) return res.status(401).json({ error: 'bad key' });

  if (action === 'draft') {
    const out = await draftReplies(req.body.kind, req.body.sender, subject, body, req.body.intent);
    return res.status(out.error ? 503 : 200).json(out.error ? out : { ok: true, options: out.options });
  }

  if (action === 'markread' || action === 'markallread') {
    // Set \Seen on one message (markread) or many (markallread) so reading in
    // the app marks them read in Gmail/Yahoo too. Best-effort and idempotent.
    const acct = findAccount(String(account || ''));
    if (!acct) return res.status(404).json({ error: 'account not connected' });
    const ids = (action === 'markallread' ? (req.body.msgids || []) : [msgid])
      .map(m => String(m || '').replace(/[<>]/g, '').trim()).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'msgid(s) required' });
    const isGmail = /gmail/i.test(acct.imapHost);
    const client = new ImapFlow({
      host: acct.imapHost, port: 993, secure: true,
      auth: { user: acct.email, pass: acct.password }, logger: false,
    });
    try {
      await client.connect();
      let marked = 0;
      const lock = await client.getMailboxLock('INBOX');
      try {
        const all = [];
        for (const id of ids) {
          const uids = await findUids(client, isGmail, id);
          if (uids && uids.length) all.push(...uids);
        }
        if (all.length) { await client.messageFlagsAdd(all, ['\\Seen'], { uid: true }); marked = all.length; }
      } finally {
        lock.release();
      }
      await client.logout();
      return res.json({ ok: true, marked });
    } catch (e) {
      try { await client.close(); } catch (_) {}
      return res.status(502).json({ error: 'imap: ' + ((e && e.message) || 'failed') });
    }
  }

  if (action === 'archive') {
    // "Done": mark \Seen and move the message out of the inbox (Gmail All Mail /
    // Yahoo Archive). Reversible — nothing is deleted, just archived.
    const acct = findAccount(String(account || ''));
    if (!acct) return res.status(404).json({ error: 'account not connected' });
    const id = String(msgid || '').replace(/[<>]/g, '').trim();
    if (!id) return res.status(400).json({ error: 'msgid required' });
    const isGmail = /gmail/i.test(acct.imapHost);
    const client = new ImapFlow({
      host: acct.imapHost, port: 993, secure: true,
      auth: { user: acct.email, pass: acct.password }, logger: false,
    });
    try {
      await client.connect();
      // find the archive destination by its special-use flag, with a fallback
      let dest = null;
      try {
        for (const b of await client.list()) {
          if (isGmail && b.specialUse === '\\All') dest = b.path;
          if (!isGmail && b.specialUse === '\\Archive') dest = b.path;
        }
      } catch (_) {}
      if (!dest) dest = isGmail ? '[Gmail]/All Mail' : 'Archive';
      let archived = false;
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await findUids(client, isGmail, id);
        if (uids && uids.length) {
          await client.messageFlagsAdd(uids, ['\\Seen'], { uid: true });
          await client.messageMove(uids, dest, { uid: true });
          archived = true;
        }
      } finally {
        lock.release();
      }
      await client.logout();
      return res.json({ ok: true, archived });
    } catch (e) {
      try { await client.close(); } catch (_) {}
      return res.status(502).json({ error: 'imap: ' + ((e && e.message) || 'failed') });
    }
  }

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
