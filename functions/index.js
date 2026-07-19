// Mail Brief reply sender.
// POST { key, account, to, subject, body, inReplyTo, references }
// Auth = the same access key that unlocks the brief. Accounts and their app
// passwords arrive as MAIL_ACCOUNT_N env vars set at deploy time from the
// repo's GitHub secrets — the single place credentials are managed.
const functions = require('@google-cloud/functions-framework');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const crypto = require('crypto');

const sentLog = []; // in-memory fallback send log (resets on cold start / per instance)
let lastDispatch = 0; // in-memory fallback cooldown for update-now requests

// ---- Durable server-side state (rate limits + send idempotency) ----
// Stored under /_server in the Realtime Database, which the security rules deny
// to every client; only this function — authenticated with its runtime service
// account — can read/write it. This survives cold starts and is shared across
// instances (unlike the in-memory fallbacks above). EVERY call here is
// best-effort: any failure falls back to in-memory behaviour so a transient DB
// problem never blocks a legitimate reply.
const DB_URL = 'https://mail-brief-gio-default-rtdb.firebaseio.com';
const SEND_LIMIT_PER_HOUR = 20;
const DRAFT_LIMIT_PER_HOUR = 40;  // AI drafting hits a paid LLM — cap it too
let _tok = { value: '', exp: 0 };
let _sa = null;
try { if (process.env.FIREBASE_SERVICE_ACCOUNT) _sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT); } catch (_) {}

function _b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Mint a Google OAuth token from the service-account key (same identity the
// pipeline uses to write RTDB) — deterministic, independent of runtime SA scopes.
async function dbToken() {
  if (!_sa || !_sa.private_key) throw new Error('no service account');
  const now = Math.floor(Date.now() / 1000);
  if (_tok.value && _tok.exp - 60 > now) return _tok.value;
  const header = _b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = _b64url(JSON.stringify({
    iss: _sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now, exp: now + 3600,
  }));
  const sig = _b64url(crypto.sign('RSA-SHA256', Buffer.from(header + '.' + claim), _sa.private_key));
  const jwt = header + '.' + claim + '.' + sig;
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + encodeURIComponent(jwt),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('token exchange: ' + JSON.stringify(d).slice(0, 160));
  _tok = { value: d.access_token, exp: now + (d.expires_in || 3600) };
  return _tok.value;
}

async function dbReq(path, method, val) {
  const tok = await dbToken();
  const opts = { method, headers: {} };
  if (val !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(val); }
  const r = await fetch(DB_URL + path + '?access_token=' + tok, opts);
  if (!r.ok) throw new Error('db ' + r.status);
  return r.json();
}

// Count sends in the rolling one-hour window (read-only; prunes expired entries
// opportunistically). Throws on any DB problem so the caller can fall back to
// the in-memory limiter. Records are appended (recordSend) rather than rewritten,
// so this only READS — the quota is consumed only after a send actually succeeds.
async function durableCount(path) {
  const now = Date.now();
  const cur = (await dbReq(path, 'GET')) || {};
  const base = path.replace(/\.json$/, '');
  let count = 0;
  for (const [k, t] of Object.entries(cur)) {
    const ts = (t && typeof t === 'object') ? t.ts : t;  // tolerate {ts} or bare number
    if (now - ts < 3600000) count += 1;
    else dbReq(base + '/' + k + '.json', 'DELETE').catch(() => {}); // prune, best-effort
  }
  return count;
}
// Append one use with a push key so concurrent writers never clobber each other.
async function recordUse(path) {
  await dbReq(path, 'POST', { ts: Date.now() });
}
const durableSendCount = () => durableCount('/_server/sends.json');
const recordSend = () => recordUse('/_server/sends.json');

// Idempotency: a stable id for a specific reply, so a client retry (e.g. the
// offline outbox re-flushing) can't send the same email twice. Hashes the FULL
// body so two long replies that share a prefix aren't wrongly deduped.
function idemId(account, to, inReplyTo, body) {
  return crypto.createHash('sha256')
    .update([account, to, inReplyTo || '', String(body)].join('|'))
    .digest('hex').slice(0, 40);
}
async function alreadySent(id) {
  const rec = await dbReq('/_server/idem/' + id + '.json', 'GET');
  return !!(rec && Date.now() - rec.at < 24 * 3600000);
}
async function recordSent(id) {
  await dbReq('/_server/idem/' + id + '.json', 'PUT', { at: Date.now() });
}

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

// Sanitize + cap client-supplied Message-IDs before they reach IMAP/Gmail search,
// so whitespace/operators can't broaden the match (e.g. 'x OR in:inbox').
function cleanMsgids(list) {
  const ok = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~@-]+$/;
  return (Array.isArray(list) ? list : [list])
    .map(m => String(m || '').replace(/[<>]/g, '').trim())
    .filter(id => id && ok.test(id))
    .slice(0, 200);
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

const TONE_GOAL = {
  quick_yes: 'Accept and agree — affirmative and brief.',
  question: 'Ask the single most useful clarifying question.',
  decline: 'Politely decline or defer — warm but clear.',
  schedule: 'Propose a specific time to meet or talk.',
};

async function draftReplies(kind, sender, subject, bodyText, intent, tone) {
  const orKey = process.env.OPENROUTER_API_KEY;   // preferred — one key, easy signup
  const anthKey = process.env.ANTHROPIC_API_KEY;  // fallback — direct Anthropic
  if (!orKey && !anthKey) {
    return { error: 'AI drafting not set up — add an OPENROUTER_API_KEY (or ANTHROPIC_API_KEY) secret and redeploy' };
  }
  const context =
    `Incoming ${kind === 'message' ? 'chat message' : 'email'}:\n` +
    `From: ${sender || '?'}\n` + (subject ? `Subject: ${subject}\n` : '') +
    `Message:\n${(bodyText || '').slice(0, 4000)}\n\n`;
  const goal = tone && TONE_GOAL[tone];
  const user = goal
    ? context +
      `Write ONE ready-to-send reply in Gio's voice. Goal: ${goal} ` +
      `For any specific detail you do NOT have (a date, time, number, name, or link), ` +
      `insert a clear [placeholder in square brackets] instead of inventing it. ` +
      `${kind === 'message' ? 'Short and casual, no sign-off.' : 'Email style; sign as "Gio".'} ` +
      `Reply with ONLY JSON: {"draft":"...","missing":["short phrase per missing detail"]}`
    : context +
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
        body: JSON.stringify({ model: 'anthropic/claude-haiku-4.5', max_tokens: 600,
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
    const parsed = m ? JSON.parse(m[0]) : null;
    if (!parsed) return { error: 'could not parse draft' };
    if (goal) {
      const draft = parsed.draft ? String(parsed.draft).slice(0, 2000) : '';
      if (!draft) return { error: 'could not parse draft' };
      const missing = Array.isArray(parsed.missing)
        ? parsed.missing.slice(0, 6).map(x => String(x).slice(0, 60)) : [];
      return { options: [draft], missing };
    }
    const opts = parsed.options;
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
    try { if ((await durableCount('/_server/drafts.json')) >= DRAFT_LIMIT_PER_HOUR)
      return res.status(429).json({ error: 'too many AI drafts this hour' }); } catch (_) { /* best-effort */ }
    const out = await draftReplies(req.body.kind, req.body.sender, subject, body, req.body.intent, req.body.tone);
    if (!out.error) { try { await recordUse('/_server/drafts.json'); } catch (_) {} }
    return res.status(out.error ? 503 : 200).json(out.error ? out : { ok: true, options: out.options, missing: out.missing || [] });
  }

  if (action === 'markread' || action === 'markallread') {
    // Set \Seen on one message (markread) or many (markallread) so reading in
    // the app marks them read in Gmail/Yahoo too. Best-effort and idempotent.
    const acct = findAccount(String(account || ''));
    if (!acct) return res.status(404).json({ error: 'account not connected' });
    const ids = cleanMsgids(action === 'markallread' ? (req.body.msgids || []) : [msgid]);
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

  if (action === 'archive' || action === 'archiveall') {
    // "Done" (archive, one) / "Clear all" (archiveall, many for one account):
    // mark \Seen and move the message(s) out of the inbox (Gmail All Mail /
    // Yahoo Archive) in a single connection. Reversible — nothing is deleted.
    const acct = findAccount(String(account || ''));
    if (!acct) return res.status(404).json({ error: 'account not connected' });
    const ids = cleanMsgids(action === 'archiveall' ? (req.body.msgids || []) : [msgid]);
    if (!ids.length) return res.status(400).json({ error: 'msgid(s) required' });
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
      let archived = 0;
      const lock = await client.getMailboxLock('INBOX');
      try {
        const all = [];
        for (const id of ids) {
          const uids = await findUids(client, isGmail, id);
          if (uids && uids.length) all.push(...uids);
        }
        if (all.length) {
          await client.messageFlagsAdd(all, ['\\Seen'], { uid: true });
          await client.messageMove(all, dest, { uid: true });
          archived = all.length;
        }
      } finally {
        lock.release();
      }
      await client.logout();
      // single archive keeps its boolean shape; bulk returns a count
      return res.json({ ok: true, archived: action === 'archive' ? archived > 0 : archived });
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
    let lastRefresh = lastDispatch;
    try { const rec = await dbReq('/_server/refresh_at.json', 'GET'); if (rec) lastRefresh = Math.max(lastRefresh, rec); } catch (_) {}
    if (Date.now() - lastRefresh < 120000) {
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
      try { await dbReq('/_server/refresh_at.json', 'PUT', Date.now()); } catch (_) {}
      return res.json({ ok: true });
    }
    return res.status(502).json({ error: 'GitHub answered ' + r.status });
  }

  const now = Date.now();
  // Validate BEFORE touching the quota, so malformed/duplicate requests can't
  // consume the hourly send budget and lock out real replies.
  const toStr = String(to || '');
  if (/[\r\n]/.test(toStr) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toStr)) {
    return res.status(400).json({ error: 'bad recipient address' });
  }
  if (!body || String(body).length > 20000) {
    return res.status(400).json({ error: 'message body missing or too long' });
  }
  const acct = findAccount(String(account || ''));
  if (!acct) {
    return res.status(404).json({ error: 'account not connected — add its app password secret first' });
  }

  // Idempotency: if this exact reply was already accepted (e.g. a retry), don't
  // send it a second time — and don't spend a quota slot on it.
  const idem = idemId(String(account || ''), toStr, inReplyTo, body);
  try { if (await alreadySent(idem)) return res.json({ ok: true, deduped: true }); } catch (_) { /* best-effort */ }

  // Rate check is COUNT-ONLY here; the slot is recorded only after a real send.
  while (sentLog.length && now - sentLog[0] > 3600000) sentLog.shift();
  let overCap;
  try { overCap = (await durableSendCount()) >= SEND_LIMIT_PER_HOUR; }
  catch (_) { overCap = sentLog.length >= SEND_LIMIT_PER_HOUR; } // DB unavailable — in-memory fallback
  if (overCap) return res.status(429).json({ error: 'too many sends this hour' });

  const transporter = nodemailer.createTransport({
    host: acct.smtpHost,
    port: 465,
    secure: true,
    auth: { user: acct.email, pass: acct.password },
  });

  const msg = {
    from: acct.email,
    to: toStr,
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
    try { await recordSend(); await recordSent(idem); } catch (_) { /* best-effort */ }
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: 'send failed: ' + ((e && e.message) || 'unknown') });
  }
});
