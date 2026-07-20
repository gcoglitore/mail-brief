// All email-derived strings (senders, subjects, snippets) are untrusted.
// The UI is therefore built exclusively with createElement/textContent —
// no HTML string assembly anywhere.
const DB = "https://mail-brief-gio-default-rtdb.firebaseio.com";
let BRIEF = null;
let FILTER = "ALL";
let SEARCH = "";
let VIEW = "priority";  // active top-level view: priority | mail | msg | dm
let retryTimer = null;  // single pending offline-retry handle (never compound)
let FLAGS = {};         // per-item pin/snooze state, synced to the DB across devices
let PRIO_SORT = "grouped";   // grouped (by intent) | newest (flat chronological)
let PRIO_FILTER = "active";  // active | snoozed
let AGING_DAYS = 2;          // an item older than this reads as overdue
function isOverdue(ts) { return !!ts && (Date.now() / 1000 - ts) > AGING_DAYS * 86400; }

// ===== Preferences (per-device, in localStorage) =====
const PREF_DEFAULTS = { sort: "grouped", aging: 2, density: "comfortable", inclTexts: true, inclDMs: true, showFyi: true, groupThreads: true };
let PREFS = Object.assign({}, PREF_DEFAULTS);
function loadPrefs() {
  try { PREFS = Object.assign({}, PREF_DEFAULTS, JSON.parse(localStorage.getItem("mailbrief_prefs") || "{}")); }
  catch (_) { PREFS = Object.assign({}, PREF_DEFAULTS); }
  PRIO_SORT = PREFS.sort;
  applyPrefs();
}
function savePrefs() {
  try { localStorage.setItem("mailbrief_prefs", JSON.stringify(PREFS)); } catch (_) {}
  applyPrefs();
}
function applyPrefs() {
  AGING_DAYS = Number(PREFS.aging) || 2;
  document.body.classList.toggle("compact", PREFS.density === "compact");
}

// Thread grouping is enforced server-side (the pipeline reads it), so this one
// setting lives in the DB (account-wide) rather than local device prefs.
async function loadServerSettings() {
  const key = localStorage.getItem("mailbrief_key");
  if (!key) return;
  try {
    const r = await fetch(DB + "/briefs/" + encodeURIComponent(key) + "/settings.json");
    const s = await r.json();
    if (s && typeof s.group_threads === "boolean") PREFS.groupThreads = s.group_threads;
  } catch (_) {}
}
function writeGroupThreads(v) {
  const key = localStorage.getItem("mailbrief_key");
  if (key) fetch(DB + "/briefs/" + encodeURIComponent(key) + "/settings/group_threads.json", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(v),
  }).catch(() => {});
  showToast("Thread grouping " + (v ? "on" : "off") + " — applies on next refresh", { state: "ok", ms: 3500 });
}

// ===== Dialog focus management (a11y) =====
// Trap Tab inside an open sheet; restore focus to the launcher on close.
function focusables(container) {
  return [...container.querySelectorAll(
    'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])')]
    .filter(x => !x.disabled && x.offsetParent !== null);
}
function trapTab(container, e) {
  if (e.key !== "Tab") return;
  const f = focusables(container);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
let _settingsTrigger = null, _composeTrigger = null;

function openSettings(reopen) {
  const sheet = $("settingsSheet");
  // On a re-render (a toggle was flipped) keep the keyboard user's place.
  const prevIdx = reopen ? focusables(sheet).indexOf(document.activeElement) : -1;
  sheet.replaceChildren();
  sheet.appendChild(el("h3", "setTitle", "Preferences"));
  const change = () => { savePrefs(); openSettings(true); reRenderActive(); renderDeskPane(); };
  const seg = (label, opts, cur, set) => {
    const row = el("div", "setRow");
    row.appendChild(el("div", "setLabel", label));
    const s = el("div", "segToggle");
    opts.forEach(([val, lbl]) => {
      const b = el("button", "segBtn" + (cur === val ? " on" : ""), lbl);
      b.addEventListener("click", () => { set(val); change(); });
      s.appendChild(b);
    });
    row.appendChild(s);
    sheet.appendChild(row);
  };
  const toggle = (label, cur, set) => {
    const row = el("div", "setRow");
    row.appendChild(el("div", "setLabel", label));
    const b = el("button", "setSwitch" + (cur ? " on" : ""));
    b.setAttribute("role", "switch"); b.setAttribute("aria-checked", String(cur));
    b.appendChild(el("span", "knob"));
    b.addEventListener("click", () => { set(!cur); change(); });
    row.appendChild(b);
    sheet.appendChild(row);
  };
  seg("Default Priority sort", [["grouped", "Grouped"], ["newest", "Newest"]], PREFS.sort,
    v => { PREFS.sort = v; PRIO_SORT = v; });
  seg("Row density", [["comfortable", "Comfortable"], ["compact", "Compact"]], PREFS.density,
    v => { PREFS.density = v; });
  seg("Overdue after", [["1", "1d"], ["2", "2d"], ["3", "3d"], ["5", "5d"], ["7", "1wk"]], String(PREFS.aging),
    v => { PREFS.aging = Number(v); });
  sheet.appendChild(el("div", "setGroup", "IN PRIORITY"));
  toggle("Include Texts (iMessage / SMS)", PREFS.inclTexts, v => { PREFS.inclTexts = v; });
  toggle("Include DMs (Signal / Slack…)", PREFS.inclDMs, v => { PREFS.inclDMs = v; });
  sheet.appendChild(el("div", "setGroup", "ALL MAIL"));
  toggle("Show FYI section", PREFS.showFyi, v => { PREFS.showFyi = v; });
  sheet.appendChild(el("div", "setGroup", "EMAIL"));
  toggle("Group into conversations", PREFS.groupThreads, v => { PREFS.groupThreads = v; writeGroupThreads(v); });
  // Firebase Auth (Stage 1: additive — signing in does NOT yet change how your
  // mail loads; your access key stays in charge. This just proves sign-in works.)
  sheet.appendChild(el("div", "setGroup", "ACCOUNT (BETA)"));
  const authRow = el("div", "setRow"); authRow.id = "authRow";
  fillAuthRow(authRow);
  sheet.appendChild(authRow);
  const done = el("button", "setClose", "Done");
  done.addEventListener("click", closeSettings);
  sheet.appendChild(done);
  $("settingsWrap").style.display = "flex";
  sheet.onkeydown = ev => {
    if (ev.key === "Escape") { ev.preventDefault(); closeSettings(); }
    else trapTab(sheet, ev);
  };
  if (!reopen) {
    _settingsTrigger = $("prefsBtn");
    const f = focusables(sheet); if (f.length) f[0].focus();
  } else if (prevIdx >= 0) {
    const f = focusables(sheet); (f[prevIdx] || f[0] || sheet).focus();
  }
}
function closeSettings() {
  $("settingsWrap").style.display = "none";
  $("settingsSheet").onkeydown = null;
  if (_settingsTrigger) { _settingsTrigger.focus(); _settingsTrigger = null; }
}

// Case-insensitive: does the (already-lowercased) query appear in any field?
function matchText(q) {
  for (let n = 1; n < arguments.length; n++) {
    const f = arguments[n];
    if (f && String(f).toLowerCase().indexOf(q) !== -1) return true;
  }
  return false;
}

const $ = id => document.getElementById(id);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Consistent SVG icon set (replaces stray emoji in the polished dark/gold UI).
const IC_MORE = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>';
const IC_PIN = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 3h6l-1 5 3 3v2H7v-2l3-3-1-5z"/></svg>';
// Build an SVG node from a trusted static markup string (no innerHTML).
function svgEl(markup) {
  return document.importNode(new DOMParser().parseFromString(markup, "image/svg+xml").documentElement, true);
}

// Turn a plain string into a DocumentFragment where http(s)/www links become
// clickable <a> elements. Stays XSS-safe: anchors are created with
// createElement and only http/https URLs get an href (never javascript:), so no
// HTML from the email/message is ever parsed. Plain text (incl. newlines) is
// preserved as text nodes.
function linkify(text) {
  const frag = document.createDocumentFragment();
  const s = (text == null ? "" : String(text));
  // A URL, minus any trailing sentence punctuation so "see http://x.com." works.
  const re = /\b(https?:\/\/|www\.)[^\s<>()]+[^\s<>().,;:!?'"]/gi;
  let last = 0, m;
  while ((m = re.exec(s))) {
    if (m.index > last) frag.appendChild(document.createTextNode(s.slice(last, m.index)));
    const url = m[0];
    const a = document.createElement("a");
    a.href = /^www\./i.test(url) ? "https://" + url : url;
    a.textContent = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.className = "inlineLink";
    frag.appendChild(a);
    last = m.index + url.length;
  }
  if (last < s.length) frag.appendChild(document.createTextNode(s.slice(last)));
  return frag;
}

function ago(ts) {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}

function safeLink(url) {
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

function card(i, cls) {
  const link = safeLink(i.link);
  const hasBody = !!i.body;
  // Cards with full text are tap-to-expand containers; others link straight out.
  const node = el(hasBody || !link ? "div" : "a", "card" + (cls ? " " + cls : ""));
  if (!hasBody && link) {
    node.href = link; node.target = "_blank"; node.rel = "noopener";
    // Opening it in Gmail/Yahoo counts as reading it — sync the read state.
    node.addEventListener("click", () => markRead(i));
  }

  const id = entryId(i);
  if (isPinned(id)) node.classList.add("pinned");

  // Meta line — sender · source · time (quiet)
  const meta = el("div", "cMeta");
  if (i.unread) meta.appendChild(el("span", "unread"));
  if (isPinned(id)) { const p = el("span", "pinMark"); p.appendChild(svgEl(IC_PIN)); meta.appendChild(p); }
  meta.appendChild(el("span", "cWho", i.from_name || i.from_email || "?"));
  meta.appendChild(el("span", "cSep", "·"));
  meta.appendChild(el("span", "cSrc", i.account));
  meta.appendChild(el("span", "cSep", "·"));
  meta.appendChild(el("span", "cTime", ago(i.ts)));
  if (i.bucket !== "junk" && isOverdue(i.ts)) { const o = el("span", "overduePill", "OVERDUE"); o.title = "Older than " + AGING_DAYS + " days"; meta.appendChild(o); }
  if (i.stale) { const s = el("span", "stalePill", "STALE"); s.title = "This account didn't refresh last time — showing your last known mail."; meta.appendChild(s); }
  node.appendChild(meta);

  // Primary line — the requested action, dominant (gold when AI-summarized)
  node.appendChild(el("div", "cPrimary" + (i.action_summary ? " act" : ""), i.action_summary || i.subject || "(no subject)"));
  // Secondary line — quieter context (subject, or snippet when no summary)
  const secondary = i.action_summary ? (i.subject || "") : (i.snippet || "");
  if (secondary) node.appendChild(el("div", "cSecondary", secondary));

  if (hasBody) {
    node.style.cursor = "pointer";
    node.addEventListener("click", e => {
      if (e.target.closest("a") || e.target.closest("button")) return;
      openReader(i);
    });
  }

  if (i.bucket !== "junk") {
    const foot = el("div", "cardFoot");
    if (i.reply_to && i.msgid) {
      const rb = el("button", "rowBtn", "Reply");
      rb.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); openCompose(i); });
      foot.appendChild(rb);
    }
    if (i.msgid) {
      const db = el("button", "rowBtn", "Archive");
      db.title = "Files this email out of your inbox (reversible)";
      db.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); archiveItem(i); });
      foot.appendChild(db);
    }
    const more = moreBtn(i);
    if (more) foot.appendChild(more);
    node.appendChild(foot);
  }
  return node;
}

const API = "https://mail-brief-gio.web.app/api/send";
let composeItem = null;
let readerItem = null;

// Mark an item read: update it locally (drops the blue dot, persists in the
// device cache) and tell the server to set it read on Gmail/Yahoo too.
function markRead(i) {
  if (!i || !i.unread) return;
  i.unread = false;
  try { if (BRIEF) localStorage.setItem("mailbrief_cache", JSON.stringify(BRIEF)); } catch (e) {}
  render();
  if (!i.msgid) return; // no message id (e.g. demo data) — nothing to sync
  const key = localStorage.getItem("mailbrief_key");
  fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, action: "markread", account: i.account, msgid: i.msgid }),
  }).catch(() => {}); // best-effort; the next refresh reconciles anyway
}

function fmtSize(n) {
  return n > 1048576 ? (n / 1048576).toFixed(1) + " MB" : n > 1024 ? Math.round(n / 1024) + " KB" : n + " B";
}
// File type from an attachment name, for the honest attachment chips.
function fileType(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || "");
  return m ? m[1].toUpperCase() : "FILE";
}
// Plain-language reasons an item is in Priority (not mechanical signal names).
function whyPriority(i) {
  const s = i.signals || {}, out = [];
  const text = (i.subject || "") + " " + (i.snippet || "");
  if (s.reply) out.push(/\?/.test(text) ? "Has a direct question" : "Needs your reply");
  if (s.meeting) out.push("About a meeting or time");
  if (s.doc) out.push("Document to review or sign");
  if (isOverdue(i.ts)) {
    const days = Math.floor((Date.now() / 1000 - (i.ts || 0)) / 86400);
    out.push(days >= 1 ? "Waiting " + days + " day" + (days === 1 ? "" : "s") : "Overdue");
  }
  return out;
}
// Light date/time detection for a "when" chip — best-effort, not a parser.
function detectWhen(text) {
  if (!text) return null;
  const m = text.match(/\b(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b|\b(?:today|tomorrow)\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/i);
  return m ? m[0] : null;
}

function openReader(i) {
  readerItem = i;
  markRead(i);
  $("readerAcct").textContent = i.account;
  $("readerFrom").textContent = i.from_name || i.from_email || "?";
  $("readerAgo").textContent = ago(i.ts);
  $("readerSubject").textContent = i.subject || "(no subject)";
  $("readerBody").replaceChildren(linkify(i.body || ""));

  // Why this is priority + a detected date, as chips
  const why = $("readerWhy"); why.replaceChildren();
  if (i.action_summary) why.appendChild(el("span", "whyChip act", "➜ " + i.action_summary));
  whyPriority(i).forEach(r => why.appendChild(el("span", "whyChip", r)));
  const when = detectWhen(i.body || i.action_summary || "");
  if (when) why.appendChild(el("span", "whyChip whenChip", "📅 " + when));
  why.style.display = why.children.length ? "flex" : "none";

  // Attachments — informational only (not openable here); typed + sized.
  const at = $("readerAttach"); at.replaceChildren();
  (i.attachments || []).forEach(a => {
    const chip = el("span", "attChip");
    chip.title = "Attachment — open this email in your mailbox to view it";
    chip.appendChild(el("span", "attType", fileType(a.name)));
    chip.appendChild(el("span", "attName", a.name || "attachment"));
    if (a.size) chip.appendChild(el("span", "attSize", "· " + fmtSize(a.size)));
    at.appendChild(chip);
  });
  at.style.display = at.children.length ? "flex" : "none";

  // Earlier in this thread
  const th = $("readerThread"); th.replaceChildren();
  if (i.thread && i.thread.length) {
    th.appendChild(el("div", "threadHdr", "EARLIER IN THIS THREAD"));
    i.thread.forEach(m => {
      const row = el("div", "threadPrev");
      const head = el("div", "threadPrevHead");
      head.appendChild(el("span", "threadPrevFrom", m.from || "?"));
      head.appendChild(el("span", "threadPrevAgo", m.ts ? ago(m.ts) : ""));
      row.appendChild(head);
      row.appendChild(el("div", "threadPrevSnip", m.snippet || ""));
      th.appendChild(row);
    });
    th.style.display = "block";
  } else { th.style.display = "none"; }

  const link = safeLink(i.link);
  const repliable = !!(i.reply_to && i.msgid);
  $("readerOpen").style.display = link ? "inline" : "none";
  if (link) $("readerOpen").href = link;
  $("readerReply").style.display = repliable ? "inline-block" : "none";
  $("readerDraft").style.display = repliable ? "inline-block" : "none";
  const id = entryId(i);
  $("readerPin").textContent = isPinned(id) ? "📌 Unpin" : "📌 Pin";
  $("readerPin").style.display = id ? "inline-block" : "none";
  $("readerSnooze").style.display = id ? "inline-block" : "none";
  // Narrow-screen "More" holds Draft/Pin/Snooze/Open — show it only when it
  // would carry at least one action (CSS keeps it hidden on wide screens).
  $("readerMore").style.display = (repliable || id || link) ? "" : "none";
  $("reader").style.display = "block";
  $("reader").scrollTop = 0;
}

function closeReader() {
  $("reader").style.display = "none";
  readerItem = null;
  renderDeskPane();
}

// ===== Undo / sync-state toast =====
let toastTimer = null, toastExpireFn = null;
function hideToast(runExpire) {
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  const fn = toastExpireFn; toastExpireFn = null;
  $("toast").classList.remove("show");
  if (runExpire && fn) fn();
}
// showToast(msg, { undo, onExpire, ms, state }) — state: ok|send|fail|offline
function showToast(msg, opts) {
  opts = opts || {};
  hideToast(true); // commit any pending action before replacing the toast
  const t = $("toast");
  t.replaceChildren();
  t.className = "state-" + (opts.state || "ok");
  t.appendChild(el("span", "tState"));
  t.appendChild(el("span", "tMsg", msg));
  if (opts.undo) {
    const b = el("button", "tUndo", "Undo");
    b.addEventListener("click", () => { hideToast(false); opts.undo(); });
    t.appendChild(b);
  }
  t.classList.add("show");
  toastExpireFn = opts.onExpire || null;
  toastTimer = setTimeout(() => hideToast(true), opts.ms || (opts.undo ? 6000 : 2400));
}
function cacheBrief() { try { localStorage.setItem("mailbrief_cache", JSON.stringify(BRIEF)); } catch (e) {} }

// "Done": remove immediately and show "Archived — Undo". The real archive on the
// mail server is deferred until the undo window closes, so Undo needs no server
// round-trip. Sync state is shown live; a server failure rolls the item back.
function archiveItem(i) {
  if (!i || !BRIEF || !BRIEF.items) return;
  const idx = BRIEF.items.indexOf(i);
  if (idx < 0) return;
  BRIEF.items.splice(idx, 1);
  RECENT_DONE.unshift(i.action_summary || i.subject || i.from_name || "email");
  cacheBrief();
  closeReader();
  render();
  // Teach the mailbox consequence the first time; keep it terse afterwards.
  const doneMsg = localStorage.getItem("mailbrief_done_taught")
    ? "Archived" : "Archived — filed out of your inbox";
  try { localStorage.setItem("mailbrief_done_taught", "1"); } catch (_) {}
  // Each archive owns an independent commit timer, so archiving another item
  // (or a background success/failure toast) can never trigger or cancel this
  // one's commit. Undo just cancels this timer.
  let cancelled = false;
  const timer = setTimeout(() => { if (!cancelled) commitArchive(i, idx); }, 6000);
  showToast(doneMsg, {
    state: "ok", ms: 6000,
    undo: () => {                       // nothing sent yet — just restore it
      cancelled = true; clearTimeout(timer);
      BRIEF.items.splice(Math.min(idx, BRIEF.items.length), 0, i);
      RECENT_DONE.shift();
      cacheBrief(); render();
    },
  });
}

async function commitArchive(i, idx) {
  if (!i.msgid) return;                  // demo/no-id items can't sync
  const key = localStorage.getItem("mailbrief_key");
  let ok = false;
  try {
    const r = await fetch(API, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, action: "archive", account: i.account, msgid: i.msgid }),
    });
    const d = await r.json().catch(() => ({}));
    ok = r.ok && d.archived;
  } catch (e) { /* offline */ }
  // Success is silent (the item's already gone); only surface a failure so a
  // status toast never clobbers another item's live Undo.
  if (!ok) {
    if (BRIEF && BRIEF.items && BRIEF.items.indexOf(i) < 0) {
      BRIEF.items.splice(Math.min(idx, BRIEF.items.length), 0, i);
      cacheBrief(); render();
    }
    showToast("Couldn't archive — back in your inbox", { state: "fail", ms: 4500 });
  }
}

// "Archive all": file every email currently shown in Needs Attention (respects
// the account filter) to Archive/All Mail — reversible, not deleted. Optimistic
// with a 6s Undo; the actual bulk call (one request per account) is deferred so
// Undo needs no round-trip.
function archiveAllAttention() {
  if (!BRIEF || !BRIEF.items) return;
  const targets = BRIEF.items.filter(i =>
    i.bucket === "attention" && !isSnoozed(entryId(i)) && (FILTER === "ALL" || i.account === FILTER));
  if (!targets.length) return;
  const scope = FILTER === "ALL" ? "" : " in " + FILTER;
  if (!confirm("Archive " + targets.length + " attention email" + (targets.length === 1 ? "" : "s") + scope + "?")) return;

  const removed = targets.slice();
  const positions = removed.map(i => BRIEF.items.indexOf(i));
  removed.forEach(i => { const idx = BRIEF.items.indexOf(i); if (idx >= 0) BRIEF.items.splice(idx, 1); });
  cacheBrief();
  closeReader();
  render();
  let cancelled = false;
  const timer = setTimeout(() => { if (!cancelled) commitArchiveAll(removed, positions); }, 6000);
  showToast("Archived " + removed.length, {
    state: "ok", ms: 6000,
    undo: () => {
      cancelled = true; clearTimeout(timer);
      removed.forEach((i, n) => BRIEF.items.splice(Math.min(positions[n], BRIEF.items.length), 0, i));
      cacheBrief(); render();
    },
  });
}

async function commitArchiveAll(removed, positions) {
  const key = localStorage.getItem("mailbrief_key");
  const byAccount = {};
  removed.forEach(i => { if (i.msgid) (byAccount[i.account] = byAccount[i.account] || []).push(i.msgid); });
  const failed = [];
  for (const account of Object.keys(byAccount)) {
    try {
      const r = await fetch(API, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, action: "archiveall", account, msgids: byAccount[account] }),
      });
      const d = await r.json().catch(() => ({}));
      if (!(r.ok && typeof d.archived === "number")) failed.push(...removed.filter(i => i.account === account && i.msgid));
    } catch (e) { failed.push(...removed.filter(i => i.account === account && i.msgid)); }
  }
  if (failed.length) {
    // Restore failures at their original positions (not appended to the end).
    failed.forEach(i => {
      if (BRIEF && BRIEF.items && BRIEF.items.indexOf(i) < 0) {
        const n = removed.indexOf(i);
        const pos = n >= 0 && positions ? Math.min(positions[n], BRIEF.items.length) : BRIEF.items.length;
        BRIEF.items.splice(pos, 0, i);
      }
    });
    cacheBrief(); render();
    showToast(failed.length + " couldn't be archived — back in your inbox", { state: "fail", ms: 5000 });
  }
}

// Mark every shown unread email read — locally and on Gmail/Yahoo.
async function markAllRead() {
  if (!BRIEF || !BRIEF.items) return;
  const byAccount = {};
  let any = false;
  BRIEF.items.forEach(i => {
    if (!i.unread) return;
    if (FILTER !== "ALL" && i.account !== FILTER) return;  // only the account you're viewing
    if (i.msgid) (byAccount[i.account] = byAccount[i.account] || []).push(i.msgid);
    i.unread = false; any = true;
  });
  if (!any) { updateNetBar(undefined, "Nothing unread"); setTimeout(() => updateNetBar(), 3000); return; }
  try { localStorage.setItem("mailbrief_cache", JSON.stringify(BRIEF)); } catch (e) {}
  render();
  const key = localStorage.getItem("mailbrief_key");
  Object.keys(byAccount).forEach(acct => {
    fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, action: "markallread", account: acct, msgids: byAccount[acct] }),
    }).catch(() => {});
  });
  updateNetBar(undefined, "✓ Marked all read");
  setTimeout(() => updateNetBar(), 4000);
}

function openCompose(i) {
  if (!i || !i.reply_to) return;  // non-repliable (FYI/junk) — no address to reply to
  composeItem = i;
  if (!_composeTrigger) _composeTrigger = document.activeElement;
  $("composeTitle").textContent = "REPLY FROM " + i.account;
  $("composeTo").value = i.reply_to;
  $("composeSubj").value = /^re:/i.test(i.subject || "") ? i.subject : "Re: " + (i.subject || "");
  $("composeBody").value = "";
  $("composeErr").textContent = "";
  $("composeWarn").style.display = "none";
  $("composeSuggest").replaceChildren();  // never carry another email's AI tone chips over
  $("composeSend").disabled = false;
  $("composeSend").textContent = "Send";
  $("composeWrap").style.display = "block";
  const sheet = $("composeSheet");
  sheet.onkeydown = ev => {
    if (ev.key === "Escape") { ev.preventDefault(); closeCompose(); }
    else trapTab(sheet, ev);
  };
  $("composeBody").focus();
}

function closeCompose() {
  $("composeWrap").style.display = "none";
  $("composeSheet").onkeydown = null;
  composeItem = null;
  if (_composeTrigger) { try { _composeTrigger.focus(); } catch (_) {} _composeTrigger = null; }
}

async function sendReply() {
  if (!composeItem) return;
  const body = $("composeBody").value.trim();
  if (!body) { $("composeErr").textContent = "Write something first."; return; }
  const ph = currentPlaceholders();
  if (ph.length && !confirm("This reply still has placeholders: " + ph.join(", ") + "\n\nSend anyway?")) return;
  const btn = $("composeSend");
  btn.disabled = true;
  btn.textContent = "Sending…";
  $("composeErr").textContent = "";
  const payload = {
    key: localStorage.getItem("mailbrief_key"),
    account: composeItem.account,
    to: $("composeTo").value.trim(),
    subject: $("composeSubj").value.trim(),
    body: body,
    inReplyTo: composeItem.msgid,
    references: composeItem.references || "",
  };
  let r = null;
  try {
    r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    // No connection — park it in the outbox; it sends on reconnect.
    const q = outbox();
    q.push({ payload, queuedAt: Date.now() });
    setOutbox(q);
    btn.textContent = "Saved to outbox ✓";
    setTimeout(closeCompose, 1200);
    return;
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) {
    btn.disabled = false;
    btn.textContent = "Send";
    $("composeErr").textContent = data.error || "Couldn't send — try again.";
    return;
  }
  btn.textContent = "Sent ✓";
  setTimeout(closeCompose, 900);
}

/* ===== offline: outbox + status bar ===== */
function outbox() {
  try { return JSON.parse(localStorage.getItem("mailbrief_outbox") || "[]"); }
  catch (e) { return []; }
}
function setOutbox(q) {
  localStorage.setItem("mailbrief_outbox", JSON.stringify(q));
  updateNetBar();
}

let isOffline = false;
function updateNetBar(offline, note) {
  if (offline !== undefined) isOffline = offline;
  const q = outbox();
  const parts = [];
  if (note) parts.push(note);
  if (isOffline) {
    const at = (BRIEF && BRIEF.generated_at) || 0;
    parts.push("Offline — showing mail from " + (at ? ago(at) + " ago" : "your last visit"));
  }
  if (q.length) {
    parts.push(q.length + (q.length === 1 ? " reply" : " replies") + " in outbox — sends when online" +
      (q[0].error ? " (last try: " + q[0].error + ")" : ""));
  }
  const bar = $("netBar");
  bar.textContent = parts.join("  ·  ");
  bar.style.display = parts.length ? "block" : "none";
}

let flushing = false;
async function flushOutbox() {
  if (flushing) return;
  const q = outbox();
  if (!q.length) return;
  flushing = true;
  const remaining = [];
  const dropped = [];   // permanently rejected (4xx) — removed, not retried
  let sentCount = 0;
  for (let n = 0; n < q.length; n++) {
    const entry = q[n];
    let r = null;
    try {
      r = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(entry.payload),
      });
    } catch (e) {
      remaining.push(...q.slice(n)); // still offline — keep the rest queued
      break;
    }
    const data = await r.json().catch(() => ({}));
    if (r.ok && data.ok) { sentCount++; }
    else if (r.status >= 400 && r.status < 500) {
      // Permanent rejection (bad recipient, removed account). Retrying can never
      // succeed, so drop it from the outbox and surface it instead of looping.
      dropped.push(data.error || ("rejected (" + r.status + ")"));
    } else {
      entry.error = data.error || "rejected"; remaining.push(entry);  // transient (5xx) — keep
    }
  }
  setOutbox(remaining);
  flushing = false;
  if (sentCount) {
    updateNetBar(undefined, "✓ " + sentCount + (sentCount === 1 ? " queued reply" : " queued replies") + " sent");
    setTimeout(() => updateNetBar(), 5000);
  }
  if (dropped.length) {
    const n = dropped.length;
    showToast(n + (n === 1 ? " reply couldn't be delivered" : " replies couldn't be delivered")
      + " — " + dropped[0], { state: "fail", ms: 7000 });
  }
}

function section(parent, label, color, items, cls, emptyText, onClearAll) {
  const head = el("div", "secHead");
  const dot = el("span", "dot");
  dot.style.background = color;
  head.appendChild(dot);
  head.appendChild(document.createTextNode(label + " "));
  head.appendChild(el("span", "count", "(" + items.length + ")"));
  if (onClearAll && items.length) {
    const btn = el("button", "clearAllBtn", "Archive all (" + items.length + ")");
    btn.addEventListener("click", onClearAll);
    head.appendChild(btn);
  }
  parent.appendChild(head);
  if (!items.length) {
    parent.appendChild(el("div", "empty", emptyText));
  } else {
    items.forEach(i => parent.appendChild(card(i, cls)));
  }
}

// Push the unread email count to the iPhone home-screen badge (the red number
// on the app icon). Works on installed PWAs once notifications are allowed.
function updateAppBadge() {
  const n = (BRIEF && BRIEF.items) ? BRIEF.items.filter(i => i.unread).length : 0;
  setBadge("mailBadge", n);   // red count on the Mail tab
  if (!("setAppBadge" in navigator)) return;
  (n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
}

// Command-center daily brief: the derivable at-a-glance stats. (Meeting-change
// and document-action counts arrive with the AI action-summary phase.)
function renderBriefStrip(attn) {
  const strip = $("briefStrip");
  strip.replaceChildren();
  if (!attn.length) { strip.classList.add("hidden"); return; }
  strip.classList.remove("hidden");
  const repliable = attn.filter(i => i.reply_to).length;
  const unread = attn.filter(i => i.unread).length;
  const oldest = attn.reduce((m, i) => Math.min(m, i.ts || Infinity), Infinity);
  const overdue = oldest !== Infinity && (Date.now() / 1000 - oldest) > AGING_DAYS * 86400;
  const meetings = attn.filter(i => i.signals && i.signals.meeting).length;
  const docs = attn.filter(i => i.signals && i.signals.doc).length;
  const cells = [
    { n: attn.length, label: "need attention", tone: "gold" },
    { n: repliable, label: "to reply", tone: "gold" },
  ];
  // Meeting/document counts appear once the AI has tagged items; otherwise fall
  // back to the always-available "unread" stat so the strip is never sparse.
  if (meetings) cells.push({ n: meetings, label: meetings === 1 ? "meeting change" : "meeting changes", tone: "gold" });
  if (docs) cells.push({ n: docs, label: docs === 1 ? "doc to action" : "docs to action", tone: "gold" });
  if (!meetings && !docs) cells.push({ n: unread, label: "unread", tone: "blue" });
  if (oldest !== Infinity) cells.push({ n: ago(oldest), label: "oldest waiting", tone: overdue ? "red" : "gray" });
  // One-line summary (shown on mobile instead of the stat cells).
  strip.appendChild(el("div", "briefLine", cells.map(c => c.n + " " + c.label).join("  ·  ")));
  cells.forEach(c => {
    const cell = el("div", "statCell tone-" + c.tone);
    cell.appendChild(el("div", "statN", String(c.n)));
    cell.appendChild(el("div", "statL", c.label));
    strip.appendChild(cell);
  });
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}
let RECENT_DONE = [];  // subjects/titles archived this session, newest first

// Productive content for the desktop right pane when nothing is open (#10).
function renderDeskPane() {
  const dp = $("deskPane");
  if (!dp) return;
  dp.replaceChildren();
  const inner = el("div", "dpInner");
  const attn = ((BRIEF && BRIEF.items) || []).filter(i => i.bucket === "attention" && !isSnoozed(entryId(i)));
  const unreadMsgs = ((MSGS && MSGS.chats) || []).filter(c => c.unread > 0 && !isSnoozed(entryId(c))).length;
  const totalActive = attn.length + unreadMsgs;

  if (totalActive === 0) {
    inner.appendChild(el("div", "dpCheck", "✓"));
    inner.appendChild(el("div", "dpClear", "You're clear"));
    inner.appendChild(el("div", "dpSub", "Nothing needs your attention right now."));
  } else {
    const repliable = attn.filter(i => i.reply_to).length;
    const oldest = attn.reduce((m, i) => Math.min(m, i.ts || Infinity), Infinity);
    inner.appendChild(el("div", "dpHi", greeting()));
    const parts = [totalActive + " item" + (totalActive === 1 ? "" : "s") + " need attention"];
    if (repliable) parts.push(repliable + " to reply");
    if (oldest !== Infinity) parts.push("oldest " + ago(oldest));
    inner.appendChild(el("div", "dpOverview", parts.join("  ·  ")));
    inner.appendChild(el("div", "dpSub", "Select an item on the left to read and act on it."));
  }

  if (RECENT_DONE.length) {
    const rd = el("div", "dpBlock");
    rd.appendChild(el("div", "dpBlockTitle", "RECENTLY DONE"));
    RECENT_DONE.slice(0, 4).forEach(t => rd.appendChild(el("div", "dpDone", "✓ " + t)));
    inner.appendChild(rd);
  }

  const sc = el("div", "dpBlock");
  sc.appendChild(el("div", "dpBlockTitle", "SHORTCUTS"));
  [["/", "Search"], ["1–4", "Switch tabs"], ["R", "Refresh"], ["Esc", "Close"]].forEach(([k, d]) => {
    const r = el("div", "dpSh");
    r.appendChild(el("kbd", "dpKey", k));
    r.appendChild(el("span", "dpDesc", d));
    sc.appendChild(r);
  });
  inner.appendChild(sc);
  dp.appendChild(inner);
}

// ===== Pin / Snooze (synced to the DB so they carry across devices) =====
function entryId(e) {
  const raw = e && e.msgid ? "mail:" + e.msgid : (e && e.id ? "msg:" + e.id : "");
  return raw ? raw.replace(/[.#$\[\]\/]/g, "_") : null; // sanitize for a DB key
}
function flagOf(id) { return (id && FLAGS[id]) || {}; }
function isPinned(id) { return !!flagOf(id).pin; }
function isSnoozed(id) { const s = flagOf(id).snooze; return !!s && s > Date.now() / 1000; }

async function loadFlags() {
  const key = localStorage.getItem("mailbrief_key");
  if (!key) return;
  try {
    const r = await fetch(DB + "/briefs/" + encodeURIComponent(key) + "/flags.json");
    const d = await r.json();
    FLAGS = d && typeof d === "object" ? d : {};
    localStorage.setItem("mailbrief_flags", JSON.stringify(FLAGS));
  } catch (e) {
    try { FLAGS = JSON.parse(localStorage.getItem("mailbrief_flags") || "{}"); } catch (_) { FLAGS = {}; }
  }
}
function writeFlag(id, patch) {
  if (!id) return;
  const next = Object.assign({}, FLAGS[id], patch);
  if (!next.pin) delete next.pin;
  if (!next.snooze) delete next.snooze;
  if (Object.keys(next).length) FLAGS[id] = next; else delete FLAGS[id];
  try { localStorage.setItem("mailbrief_flags", JSON.stringify(FLAGS)); } catch (_) {}
  const key = localStorage.getItem("mailbrief_key");
  if (!key) return;
  fetch(DB + "/briefs/" + encodeURIComponent(key) + "/flags/" + encodeURIComponent(id) + ".json", {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(FLAGS[id] || null),
  }).catch(() => {});
}
function reRenderActive() {
  if (VIEW === "priority") renderPriority();
  else if (VIEW === "mail") { if (BRIEF) render(); }
  else renderMessages();
}
function togglePin(id) {
  const pin = !isPinned(id);
  writeFlag(id, { pin });
  reRenderActive();
  showToast(pin ? "Pinned to top" : "Unpinned", { state: "ok", ms: 1500 });
}
function atHour(h, addDays) {
  const d = new Date();
  d.setDate(d.getDate() + (addDays || 0));
  d.setHours(h, 0, 0, 0);
  if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1);
  return Math.floor(d.getTime() / 1000);
}
const SNOOZE_PRESETS = [
  { label: "1 hour", at: () => Math.floor(Date.now() / 1000) + 3600 },
  { label: "This evening", at: () => atHour(18) },
  { label: "Tomorrow morning", at: () => atHour(9, 1) },
  { label: "Next week", at: () => atHour(9, 7) },
];
function snoozeTo(id, p) {
  writeFlag(id, { snooze: p.at() });
  reRenderActive();
  showToast("Snoozed — " + p.label.toLowerCase(), {
    state: "ok", ms: 4000,
    undo: () => { writeFlag(id, { snooze: undefined }); reRenderActive(); },
  });
}
// Overflow (⋯) menu holding the low-frequency row actions: pin + snooze.
// Accessible: role=menu/menuitem, arrow-key navigation, Escape-to-close, and
// focus is restored to the ⋯ trigger on close.
let _menuTrigger = null;
function closeRowMenu(restoreFocus) {
  const menu = $("snoozeMenu");
  menu.style.display = "none";
  menu.onkeydown = null;
  if (restoreFocus && _menuTrigger) _menuTrigger.focus();
  _menuTrigger = null;
}
// Generic popup menu anchored to a button. entries: {label, fn} action rows,
// or {title} section labels. Handles role=menu, arrow keys, Escape, focus.
function showMenu(anchorBtn, entries) {
  const menu = $("snoozeMenu");
  menu.replaceChildren();
  menu.setAttribute("role", "menu");
  _menuTrigger = anchorBtn;
  const items = [];
  entries.forEach(en => {
    if (en.title) { menu.appendChild(el("div", "snzTitle", en.title)); return; }
    const b = el("button", "snzOpt", en.label);
    b.setAttribute("role", "menuitem");
    b.tabIndex = -1;
    b.addEventListener("click", () => { closeRowMenu(true); en.fn(); });
    menu.appendChild(b);
    items.push(b);
  });
  if (!items.length) return;
  menu.style.display = "block";
  const r = anchorBtn.getBoundingClientRect();
  menu.style.top = Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 10) + "px";
  menu.style.left = Math.max(8, Math.min(r.right - 190, window.innerWidth - 200)) + "px";
  menu.onkeydown = ev => {
    const i = items.indexOf(document.activeElement);
    if (ev.key === "Escape") { ev.preventDefault(); closeRowMenu(true); }
    else if (ev.key === "ArrowDown") { ev.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
  };
  items[0].focus();
}

function openRowMenu(e, anchorBtn) {
  const id = entryId(e);
  if (!id) return;
  showMenu(anchorBtn, [
    { label: isPinned(id) ? "Unpin" : "Pin to top", fn: () => togglePin(id) },
    { title: "Snooze until…" },
    ...SNOOZE_PRESETS.map(p => ({ label: p.label, fn: () => snoozeTo(id, p) })),
  ]);
}

// Reader overflow menu (narrow screens): the actions collapsed out of the bar.
function openReaderMenu(anchorBtn) {
  const i = readerItem;
  if (!i) return;
  const id = entryId(i);
  const link = safeLink(i.link);
  const entries = [];
  if (i.reply_to && i.msgid) entries.push({ label: "✨ Draft a reply", fn: () => draftReply(i) });
  if (id) entries.push({ label: isPinned(id) ? "Unpin" : "Pin to top", fn: () => togglePin(id) });
  if (id) entries.push({ label: "⏰ Snooze…", fn: () => openRowMenu(i, anchorBtn) });
  if (link) entries.push({ label: "Open in mailbox ↗", fn: () => window.open(link, "_blank", "noopener") });
  showMenu(anchorBtn, entries);
}
document.addEventListener("click", e => {
  const m = $("snoozeMenu");
  if (m && m.style.display === "block" && !m.contains(e.target) && !(e.target.closest && e.target.closest(".rowMore")))
    closeRowMenu(false);
});
// A ⋯ overflow button for a row (e = mail item or chat).
function moreBtn(e) {
  if (!entryId(e)) return null;
  const b = el("button", "rowMore");
  b.appendChild(svgEl(IC_MORE));
  b.title = "More"; b.setAttribute("aria-label", "More actions");
  b.addEventListener("click", ev => { ev.preventDefault(); ev.stopPropagation(); openRowMenu(e, b); });
  return b;
}

// Which intent group a priority entry belongs to.
const PRIO_GROUPS = [
  { key: "pinned",        label: "PINNED",             color: "var(--gold)" },
  { key: "reply",         label: "REPLY NEEDED",       color: "var(--red)" },
  { key: "meeting",       label: "MEETING / DEADLINE", color: "var(--gold)" },
  { key: "review",        label: "REVIEW / SIGN",      color: "var(--blue)" },
  { key: "conversations", label: "CONVERSATIONS",      color: "var(--blue)" },
  { key: "other",         label: "OTHER",              color: "var(--faint)" },
];
function entryGroup(e) {
  if (isPinned(e.id)) return "pinned";
  if (e.kind === "msg") return "conversations";
  const s = e.item.signals;
  if (s) {
    if (s.doc) return "review";
    if (s.meeting) return "meeting";
    if (s.reply) return "reply";
    return "other";                              // AI ran but flagged no specific action
  }
  return e.item.reply_to ? "reply" : "other";    // no AI yet: repliable → reply, else other
}
function entryMatchesSearch(e) {
  return e.kind === "mail"
    ? matchText(SEARCH, e.item.from_name, e.item.from_email, e.item.subject, e.item.snippet, e.item.action_summary)
    : matchText(SEARCH, e.chat.title, e.chat.preview);
}
function rowFor(e) { return e.kind === "mail" ? card(e.item, "attn") : priorityMsgRow(e.chat); }
function groupHead(label, color, n) {
  const h = el("div", "secHead");
  const dot = el("span", "dot"); dot.style.background = color; h.appendChild(dot);
  h.appendChild(document.createTextNode(label + " "));
  h.appendChild(el("span", "count", "(" + n + ")"));
  return h;
}
function snoozeLabel(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000), now = new Date();
  const tmr = new Date(now); tmr.setDate(now.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return "today " + time;
  if (d.toDateString() === tmr.toDateString()) return "tomorrow " + time;
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }) + " " + time;
}
function snoozedRow(e) {
  const isMail = e.kind === "mail", o = isMail ? e.item : e.chat;
  const row = el("div", "card");
  const meta = el("div", "cMeta");
  meta.appendChild(el("span", "cWho", isMail ? (o.from_name || o.from_email || "?") : (o.title || "?")));
  meta.appendChild(el("span", "cSep", "·"));
  meta.appendChild(el("span", "cSrc", isMail ? o.account : netLabel(o.network)));
  row.appendChild(meta);
  row.appendChild(el("div", "cPrimary", isMail ? (o.action_summary || o.subject || "(no subject)") : (o.preview || o.title || "")));
  const foot = el("div", "cardFoot");
  foot.appendChild(el("span", "snzUntil", "Snoozed until " + snoozeLabel(flagOf(e.id).snooze)));
  const restore = el("button", "rowBtn", "Restore");
  restore.addEventListener("click", ev => {
    ev.stopPropagation(); writeFlag(e.id, { snooze: undefined }); reRenderActive();
    showToast("Restored to Priority", { state: "ok", ms: 1600 });
  });
  foot.appendChild(restore);
  row.appendChild(foot);
  return row;
}

// ===== Google Calendar agenda (read-only, from BRIEF.calendar) =====
function eventTimeLabel(e) {
  if (e.all_day) return "All day";
  return new Date(e.start * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
function eventDayLabel(ts) {
  const d = new Date(ts * 1000), now = new Date();
  const tmr = new Date(now); tmr.setDate(now.getDate() + 1);
  if (d.toDateString() === now.toDateString()) return "Today";
  if (d.toDateString() === tmr.toDateString()) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}
// A compact "what's on" agenda grouped by day, with the in-progress event marked.
function renderAgenda(parent) {
  const events = (BRIEF && Array.isArray(BRIEF.calendar) ? BRIEF.calendar : [])
    .filter(e => e && e.start);
  if (!events.length) return;
  const now = Date.now() / 1000;
  const wrap = el("div", "agenda");
  wrap.appendChild(el("div", "agendaHdr", "AGENDA"));
  let lastDay = null;
  events.slice(0, 8).forEach(e => {
    const dl = eventDayLabel(e.start);
    if (dl !== lastDay) { wrap.appendChild(el("div", "agendaDay", dl)); lastDay = dl; }
    const live = e.start <= now && (e.end || e.start) > now;
    const row = el("div", "agendaRow" + (live ? " now" : ""));
    row.appendChild(el("span", "agendaTime", eventTimeLabel(e)));
    row.appendChild(el("span", "agendaTitle", e.title || "(busy)"));
    if (e.location) row.appendChild(el("span", "agendaLoc", e.location));
    wrap.appendChild(row);
  });
  parent.appendChild(wrap);
}

// Unified priority rail: attention email + unread conversations, grouped by
// intent (or flat by "Newest"), plus a Snoozed view. The home screen.
function renderPriority() {
  const v = $("priorityView");
  v.replaceChildren();
  const attnAll = ((BRIEF && BRIEF.items) || []).filter(i => i.bucket === "attention");
  const base = [];
  attnAll.forEach(i => base.push({ kind: "mail", ts: i.ts || 0, item: i, id: entryId(i) }));
  ((MSGS && MSGS.chats) || []).forEach(c => {
    if (c.unread <= 0) return;
    const cat = msgCategory(c.network);          // "msg" (Texts) or "dm"
    if (cat === "msg" && !PREFS.inclTexts) return;
    if (cat === "dm" && !PREFS.inclDMs) return;
    base.push({ kind: "msg", ts: c.ts || 0, chat: c, id: entryId(c) });
  });
  const active = base.filter(e => !isSnoozed(e.id));
  const snoozed = base.filter(e => isSnoozed(e.id));
  renderBriefStrip(SEARCH ? [] : active.filter(e => e.kind === "mail").map(e => e.item));
  setBadge("prioBadge", active.length);

  // Toolbar: sort toggle (active view) + Snoozed filter.
  const tools = el("div", "prioTools");
  if (PRIO_FILTER === "active") {
    const seg = el("div", "segToggle");
    [["grouped", "Grouped"], ["newest", "Newest"]].forEach(([m, lbl]) => {
      const b = el("button", "segBtn" + (PRIO_SORT === m ? " on" : ""), lbl);
      b.addEventListener("click", () => { PRIO_SORT = m; PREFS.sort = m; savePrefs(); renderPriority(); });
      seg.appendChild(b);
    });
    tools.appendChild(seg);
  }
  const filt = el("button", "prioFilterBtn" + (PRIO_FILTER === "snoozed" ? " on" : ""),
    PRIO_FILTER === "snoozed" ? "‹ Back to Priority" : ("Snoozed" + (snoozed.length ? " (" + snoozed.length + ")" : "")));
  filt.addEventListener("click", () => { PRIO_FILTER = PRIO_FILTER === "snoozed" ? "active" : "snoozed"; renderPriority(); });
  tools.appendChild(filt);
  v.appendChild(tools);

  if (PRIO_FILTER === "snoozed") {
    if (!snoozed.length) { v.appendChild(el("div", "empty", "Nothing snoozed.")); return; }
    snoozed.sort((a, b) => (flagOf(a.id).snooze || 0) - (flagOf(b.id).snooze || 0));
    snoozed.forEach(e => v.appendChild(snoozedRow(e)));
    return;
  }

  if (!SEARCH) renderAgenda(v);   // Google Calendar agenda sits atop the rail

  let entries = SEARCH ? active.filter(entryMatchesSearch) : active;
  if (!entries.length) {
    v.appendChild(el("div", "empty", SEARCH ? "No matching priority items."
      : "You're all caught up — nothing needs your attention."));
    return;
  }
  if (PRIO_SORT === "newest") {
    entries = entries.slice().sort((a, b) => {
      const pa = isPinned(a.id), pb = isPinned(b.id);
      if (pa !== pb) return pa ? -1 : 1;
      return b.ts - a.ts;
    });
    entries.forEach(e => v.appendChild(rowFor(e)));
  } else {
    // Grouped by intent; within each group, oldest (most overdue) first.
    PRIO_GROUPS.forEach(g => {
      const inG = entries.filter(e => entryGroup(e) === g.key).sort((a, b) => a.ts - b.ts);
      if (!inG.length) return;
      v.appendChild(groupHead(g.label, g.color, inG.length));
      inG.forEach(e => v.appendChild(rowFor(e)));
    });
  }
}

function priorityMsgRow(c) {
  const id = entryId(c);
  const row = el("div", "chat" + (isPinned(id) ? " pinned" : ""));
  row.appendChild(el("span", "net " + netClass(c.network), netLabel(c.network)));
  const mid = el("div", "chatMid");
  const title = el("div", "chatTitle", c.title || "(no title)");
  if (isPinned(id)) { const p = el("span", "pinMark"); p.appendChild(svgEl(IC_PIN)); title.prepend(p); }
  mid.appendChild(title);
  mid.appendChild(el("div", "chatPrev", c.preview || ""));
  row.appendChild(mid);
  const right = el("div", "chatRight");
  right.appendChild(el("div", "chatAgo", c.ts ? ago(c.ts) : ""));
  if (isOverdue(c.ts)) right.appendChild(el("div", "overduePill", "OVERDUE"));
  if (c.unread > 0) right.appendChild(el("div", "chatUnread", String(c.unread)));
  const more = moreBtn(c);
  if (more) right.appendChild(more);
  row.appendChild(right);
  row.addEventListener("click", () => openThread(c));
  return row;
}

function render() {
  if (!BRIEF) return;
  updateAppBadge();
  const all = BRIEF.items || [];
  const items = all.filter(i => FILTER === "ALL" || i.account === FILTER);
  const attn = items.filter(i => i.bucket === "attention" && !isSnoozed(entryId(i)));
  const fyi  = items.filter(i => i.bucket === "fyi" && !isSnoozed(entryId(i)));
  const junk = items.filter(i => i.bucket === "junk");

  if (VIEW === "priority") renderPriority();
  else renderBriefStrip(SEARCH ? [] : attn);
  renderDeskPane();

  const chips = $("chips");
  chips.replaceChildren();
  ["ALL", ...new Set(all.map(i => i.account))].forEach(a => {
    const b = el("button", "chip" + (FILTER === a ? " on" : ""), a);
    b.addEventListener("click", () => { FILTER = a; render(); });
    chips.appendChild(b);
  });

  const content = $("content");
  content.replaceChildren();

  if (SEARCH) {
    const matches = items.filter(i => matchText(SEARCH, i.from_name, i.from_email, i.subject, i.snippet, i.body));
    section(content, "RESULTS", "var(--gold)", matches, "", "No matching email.");
  } else {
    section(content, "NEEDS ATTENTION", "var(--red)", attn, "attn", "Nothing needs your attention.", archiveAllAttention);
    if (PREFS.showFyi) section(content, "FYI", "var(--blue)", fyi, "fyi", "Nothing here.");

    const junkHead = el("div", "secHead");
    const jdot = el("span", "dot"); jdot.style.background = "var(--faint)";
    junkHead.appendChild(jdot);
    junkHead.appendChild(document.createTextNode("JUNK "));
    junkHead.appendChild(el("span", "count", "(" + junk.length + ")"));
    content.appendChild(junkHead);

    const senders = [...new Set(junk.map(j => j.from_name))].slice(0, 6).join(", ");
    const junkBar = el("div", null,
      junk.length + " junk emails kept out of your way" + (senders ? " — " + senders : "") + " (tap to view)");
    junkBar.id = "junkBar";
    const junkList = el("div");
    junkList.id = "junkList";
    junk.forEach(i => junkList.appendChild(card(i, "")));
    junkBar.appendChild(junkList);
    junkBar.addEventListener("click", e => {
      if (e.target.closest("a")) return;
      junkList.style.display = junkList.style.display === "block" ? "none" : "block";
    });
    content.appendChild(junkBar);
  }

  const gen = BRIEF.generated_at || 0;
  const mins = Math.floor(Date.now() / 1000 - gen) / 60;
  $("updated").textContent = "updated " + ago(gen) + " ago";
  $("updated").className = mins > 90 ? "stale" : "";

  const st = $("accStatus");
  st.replaceChildren();
  (BRIEF.accounts || []).forEach(a => {
    const span = el("span", a.ok ? null : "bad",
      a.ok ? "✓ " + a.account + " (" + a.count + ")"
           : "✗ " + a.account + " — check its app password");
    st.appendChild(span);
    st.appendChild(document.createTextNode("   "));
  });

  updateAppBadge();
}

async function load(key, fromButton) {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }  // supersede any pending retry
  let gotResponse = false, data = null;
  try {
    const r = await fetch(DB + "/briefs/" + encodeURIComponent(key) + "/brief.json");
    gotResponse = true;
    data = await r.json();
  } catch (e) { /* network failure — handled below */ }

  if (data) {
    BRIEF = data;
    localStorage.setItem("mailbrief_key", key);
    localStorage.setItem("mailbrief_cache", JSON.stringify(data));
    $("keyScreen").style.display = "none";
    $("app").style.display = "block";
    document.body.classList.add("signed-in");
    loadPrefs();         // device preferences (sort/aging/density/channels/fyi)
    loadServerSettings();// account-wide settings (thread grouping)
    await loadFlags();   // pins/snoozes before first paint
    render();
    updateNetBar(false);
    flushOutbox();
    loadMessages();
    return;
  }

  // No data this attempt. Fall back to the last brief we cached on this device.
  const haveSavedKey = !!localStorage.getItem("mailbrief_key");
  const cached = localStorage.getItem("mailbrief_cache");
  if (cached && haveSavedKey) {
    try {
      BRIEF = JSON.parse(cached);
      $("keyScreen").style.display = "none";
      $("app").style.display = "block";
      document.body.classList.add("signed-in");
      loadPrefs();          // restore device prefs (sort/aging/density/channels) offline
      loadServerSettings(); // best-effort (no-ops offline)
      await loadFlags();    // restore pins/snoozes from cache so they aren't lost offline
      render();
      updateNetBar(true);
      loadMessages();       // restore cached Texts/DMs offline
      return;
    } catch (e2) { /* corrupt cache — fall through */ }
  }

  if (fromButton) {
    $("keyErr").textContent = gotResponse
      ? "That key didn't open anything. Check it and try again."
      : "No connection — try again when you're online.";
    return;
  }

  // Auto-load with a saved key but nothing to show yet: NEVER nag for the code.
  // Stay in the app, show a quiet "connecting", and retry shortly.
  if (haveSavedKey) {
    $("keyScreen").style.display = "none";
    $("app").style.display = "block";
    document.body.classList.add("signed-in");
    updateNetBar(undefined, "Connecting…");
    retryTimer = setTimeout(() => load(key, false), 4000);
    return;
  }

  showKeyScreen();
}

function showKeyScreen() {
  $("app").style.display = "none";
  $("keyScreen").style.display = "block";
  document.body.classList.remove("signed-in");
}

async function updateNow() {
  const btn = $("updateBtn");
  const key = localStorage.getItem("mailbrief_key");
  if (!key || btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("spin");
  const before = BRIEF && BRIEF.generated_at;
  load(key, false); // instant display refresh while the robot spins up
  const done = note => {
    btn.disabled = false;
    btn.classList.remove("spin");
    if (note) { updateNetBar(undefined, note); setTimeout(() => updateNetBar(), 6000); }
  };
  let resp = null;
  try {
    resp = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, action: "refresh" }),
    });
  } catch (e) {
    return done("↻ Offline — pull again when you have a connection");
  }
  const d = await resp.json().catch(() => ({}));
  if (!resp.ok || !d.ok) return done("↻ " + (d.error || "couldn't start the check"));
  updateNetBar(undefined, "↻ Checking your mailboxes — takes about a minute");
  const t0 = Date.now();
  const poll = setInterval(async () => {
    await load(key, false);
    if (BRIEF && BRIEF.generated_at !== before) {
      clearInterval(poll);
      done("✓ Updated just now");
    } else if (Date.now() - t0 > 180000) {
      clearInterval(poll);
      done("Checked — nothing new arrived");
    }
  }, 12000);
}
$("updateBtn").addEventListener("click", updateNow);
$("searchToggle").addEventListener("click", () => {
  const open = $("app").classList.toggle("search-open");
  if (open) $("searchBox").focus();
  else { $("searchBox").value = ""; SEARCH = ""; reRenderActive(); }
});
$("prefsBtn").addEventListener("click", () => openSettings());
$("settingsWrap").addEventListener("click", e => { if (e.target === $("settingsWrap")) closeSettings(); });

$("readerBack").addEventListener("click", closeReader);

// Swipe horizontally (either direction) to go back from the reader — no tap needed.
(function () {
  const r = $("reader");
  let sx = 0, sy = 0, tracking = false;
  r.addEventListener("touchstart", e => {
    if (e.touches.length !== 1) { tracking = false; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true });
  r.addEventListener("touchend", e => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - sx, dy = t.clientY - sy;
    // a clear sideways flick (not a vertical scroll) returns to the list
    if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.5) closeReader();
  }, { passive: true });
})();
$("readerReply").addEventListener("click", () => { if (readerItem) openCompose(readerItem); });
$("readerDraft").addEventListener("click", () => { if (readerItem) draftReply(readerItem); });
$("readerSnooze").addEventListener("click", e => { e.stopPropagation(); if (readerItem) openRowMenu(readerItem, $("readerSnooze")); });
$("readerMore").addEventListener("click", e => { e.stopPropagation(); if (readerItem) openReaderMenu($("readerMore")); });
$("readerPin").addEventListener("click", () => {
  if (!readerItem) return;
  const id = entryId(readerItem);
  togglePin(id);
  $("readerPin").textContent = isPinned(id) ? "📌 Unpin" : "📌 Pin";
});

// AI-drafted replies in Gio's voice: open the compose sheet and fill it with
// tappable suggestions from the function. Each suggestion drops into the body
// (then edit / dictate / send as normal).
const TONE_CHIPS = [
  { key: "quick_yes", label: "Quick yes" },
  { key: "question", label: "Ask a question" },
  { key: "decline", label: "Decline" },
  { key: "schedule", label: "Schedule" },
];

// "✨ Draft": offer tone chips instead of three generic drafts. Picking one
// generates a single reply in that tone, with any unknown detail left as a
// highlighted [placeholder] you must fill before sending.
function draftReply(i) {
  if (!i || !i.reply_to) return;   // nothing to reply to
  openCompose(i);
  const sug = $("composeSuggest");
  sug.replaceChildren();
  sug.appendChild(el("div", "sugNote", "Draft a reply — pick a tone:"));
  const row = el("div", "toneChips");
  TONE_CHIPS.forEach(t => {
    const chip = el("button", "toneChip", t.label);
    chip.addEventListener("click", () => generateDraft(i, t.key, chip));
    row.appendChild(chip);
  });
  const custom = el("button", "toneChip custom", "Custom");
  custom.addEventListener("click", () => { sug.replaceChildren(); $("composeBody").focus(); });
  row.appendChild(custom);
  sug.appendChild(row);
}

async function generateDraft(i, tone, chipEl) {
  const sug = $("composeSuggest");
  [...sug.querySelectorAll(".toneChip")].forEach(c => c.classList.remove("on"));
  if (chipEl) chipEl.classList.add("on");
  // Match either state so a prior error line is reused, not duplicated.
  let note = sug.querySelector(".sugNote, .sugErr");
  if (!note) { note = el("div", "sugNote"); sug.insertBefore(note, sug.firstChild); }
  note.className = "sugNote"; note.textContent = "✨ drafting in your voice…";
  const key = localStorage.getItem("mailbrief_key");
  try {
    const r = await fetch(API, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, action: "draft", kind: "email", tone,
        subject: i.subject, sender: (i.from_name || "") + " <" + (i.from_email || "") + ">",
        body: i.body || i.snippet || "" }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.options || !d.options[0]) { note.className = "sugErr"; note.textContent = d.error || "Couldn't draft right now"; return; }
    $("composeBody").value = d.options[0];
    note.textContent = "Edit or dictate, then send:";
    updatePlaceholderWarning();
    $("composeBody").focus();
  } catch (e) {
    note.className = "sugErr"; note.textContent = "Offline — can't draft right now";
  }
}

// Any [bracketed] text the AI left because it lacked a detail. Surfaced as a
// warning and guarded at send-time so a half-filled draft can't go out.
function currentPlaceholders() {
  const m = ($("composeBody").value.match(/\[[^\]\n]{1,40}\]/g)) || [];
  return [...new Set(m)];
}
function updatePlaceholderWarning() {
  const ph = currentPlaceholders();
  const w = $("composeWarn");
  if (ph.length) { w.textContent = "⚠ Fill in before sending: " + ph.join(", "); w.style.display = "block"; }
  else { w.style.display = "none"; w.textContent = ""; }
}
$("readerDone").addEventListener("click", () => { if (readerItem) archiveItem(readerItem); });
$("readAllBtn").addEventListener("click", markAllRead);

$("composeSend").addEventListener("click", sendReply);
$("composeCancel").addEventListener("click", closeCompose);
$("composeBody").addEventListener("input", updatePlaceholderWarning);
$("composeWrap").addEventListener("click", e => { if (e.target === $("composeWrap")) closeCompose(); });

$("keyBtn").addEventListener("click", () => load($("keyInput").value.trim(), true));
$("keyInput").addEventListener("keydown", e => { if (e.key === "Enter") $("keyBtn").click(); });
$("keyReveal").addEventListener("click", () => {
  const inp = $("keyInput"), show = inp.type === "password";
  inp.type = show ? "text" : "password";
  $("keyReveal").textContent = show ? "Hide" : "Show";
  $("keyReveal").setAttribute("aria-pressed", String(show));
  inp.focus();
});
$("lockBtn").addEventListener("click", () => { localStorage.removeItem("mailbrief_key"); location.reload(); });

// ===== Messages (Beeper bridge) =====
var MSGS = null;
let threadChat = null;
const NET_LABELS = [
  ["signal", "SIGNAL"], ["slack", "SLACK"], ["whatsapp", "WHATSAPP"],
  ["telegram", "TELEGRAM"], ["imessage", "iMSG"], ["googlemessages", "SMS"],
  ["sms", "SMS"], ["instagram", "INSTA"], ["twitter", "X"], ["discord", "DISCORD"],
  ["messenger", "MSGR"], ["facebook", "MSGR"],
];
// Which tab a chat belongs to: Apple texts vs internet DMs.
function msgCategory(network) {
  const c = netClass(network);
  return (c === "imessage" || c === "sms") ? "msg" : "dm";
}
var MSGVIEW = "msg";
function netClass(n) {
  const s = (n || "").toLowerCase().replace(/[^a-z]/g, "");
  if (s.indexOf("imessage") !== -1) return "imessage";
  if (s.indexOf("sms") !== -1 || s.indexOf("googlemessages") !== -1) return "sms";
  for (const [k] of NET_LABELS) if (s.indexOf(k) !== -1) return k;
  return "generic";
}
function netLabel(n) {
  const s = (n || "").toLowerCase();
  for (const [k, label] of NET_LABELS) if (s.indexOf(k) !== -1) return label;
  return (n || "CHAT").toUpperCase().slice(0, 8);
}

async function loadMessages() {
  const key = localStorage.getItem("mailbrief_key");
  if (!key) return;
  try {
    const r = await fetch(DB + "/briefs/" + encodeURIComponent(key) + "/messages.json");
    const data = await r.json();
    if (data) { MSGS = data; localStorage.setItem("mailbrief_msgs", JSON.stringify(data)); }
  } catch (e) {
    const c = localStorage.getItem("mailbrief_msgs");
    if (c && !MSGS) { try { MSGS = JSON.parse(c); } catch (_) {} }
  }
  renderMessages();
  updateMsgBadges();
  if (VIEW === "priority") renderPriority();  // messages feed the unified rail
  renderDeskPane();
}

function setBadge(id, n) {
  const b = $(id);
  if (n > 0) { b.textContent = n; b.className = "tabBadge show"; }
  else { b.className = "tabBadge"; b.textContent = ""; }
}
function updateMsgBadges() {
  const chats = (MSGS && MSGS.chats) || [];
  let msgU = 0, dmU = 0;
  chats.forEach(c => {
    if (!c.unread) return;
    if (msgCategory(c.network) === "msg") msgU += c.unread; else dmU += c.unread;
  });
  setBadge("msgBadge", msgU);
  setBadge("dmBadge", dmU);
}

function renderMessages() {
  const v = $("msgView");
  v.replaceChildren();
  // Messages come from the Mac's Beeper bridge (~every 5 min while the Mac is on).
  // If the snapshot goes quiet for more than an hour the connector is likely offline
  // (Mac asleep / traveling), so DMs are stale — say so instead of showing nothing.
  const gen = (MSGS && MSGS.generated_at) || 0;
  const stale = gen && (Math.floor(Date.now() / 1000 - gen) > 3600);
  if (stale) {
    const banner = el("div", "msgStale");
    banner.style.cssText = "margin:8px 0;padding:10px 12px;border-radius:8px;font-size:13px;" +
      "line-height:1.4;text-align:left;background:rgba(212,160,23,.12);" +
      "border:1px solid rgba(212,160,23,.35);color:var(--gold,#d4a017)";
    banner.textContent = "Messages last synced " + ago(gen) + " ago — your Mac connector looks " +
      "offline. DMs (Slack, Signal, WhatsApp) only refresh while your Mac is on.";
    v.appendChild(banner);
  }
  let chats = (MSGS && MSGS.chats) || [];
  chats = chats.filter(c => msgCategory(c.network) === MSGVIEW);
  if (SEARCH) {
    chats = chats.filter(c => matchText(SEARCH, c.title, c.preview) ||
      (c.messages || []).some(m => matchText(SEARCH, m.text)));
  }
  if (!chats.length) {
    const none = !MSGS ? "Connecting to your messages…"
      : SEARCH ? "No matching conversations."
      : MSGVIEW === "dm" ? "No DMs yet. Connect Signal / Slack / WhatsApp / Messenger in Beeper."
      : "No texts yet.";
    v.appendChild(el("div", "empty", none));
    return;
  }
  if (chats.some(c => c.unread > 0)) {
    const tools = el("div", null); tools.id = "msgTools";
    const btn = el("button", null, "✓ Mark all read"); btn.id = "msgReadAllBtn";
    btn.addEventListener("click", markAllMessagesRead);
    tools.appendChild(btn);
    v.appendChild(tools);
  }
  chats.forEach(c => {
    const row = el("div", "chat");
    row.appendChild(el("span", "net " + netClass(c.network), netLabel(c.network)));
    const mid = el("div", "chatMid");
    mid.appendChild(el("div", "chatTitle", c.title || "(no title)"));
    mid.appendChild(el("div", "chatPrev", c.preview || ""));
    row.appendChild(mid);
    const right = el("div", "chatRight");
    right.appendChild(el("div", "chatAgo", c.ts ? ago(c.ts) : ""));
    if (c.unread > 0) right.appendChild(el("div", "chatUnread", String(c.unread)));
    row.appendChild(right);
    row.addEventListener("click", () => openThread(c));
    v.appendChild(row);
  });
}

// Clear a conversation's unread state locally and tell the Mac to mark it
// read in Beeper (so the count stays cleared after the next refresh).
function markChatRead(c) {
  if (!c || !c.unread) return;
  c.unread = 0;
  try { localStorage.setItem("mailbrief_msgs", JSON.stringify(MSGS)); } catch (_) {}
  renderMessages();   // drop the row's unread pill (list stays visible on desktop)
  updateMsgBadges();
  if (VIEW === "priority") renderPriority();  // also clear it from the Priority rail
  const key = localStorage.getItem("mailbrief_key");
  if (!key || !c.id) return;
  fetch(DB + "/briefs/" + encodeURIComponent(key) + "/msg_outbox.json", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatID: c.id, action: "read", at: Date.now() }),
  }).catch(() => {});
}

// Mark every conversation in the current tab (Texts or DMs) read.
function markAllMessagesRead() {
  const chats = (MSGS && MSGS.chats) || [];
  const key = localStorage.getItem("mailbrief_key");
  let changed = false;
  chats.forEach(c => {
    if (msgCategory(c.network) !== MSGVIEW || !c.unread) return;
    c.unread = 0; changed = true;
    if (key && c.id) {
      fetch(DB + "/briefs/" + encodeURIComponent(key) + "/msg_outbox.json", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatID: c.id, action: "read", at: Date.now() }),
      }).catch(() => {});
    }
  });
  if (!changed) return;
  try { localStorage.setItem("mailbrief_msgs", JSON.stringify(MSGS)); } catch (_) {}
  renderMessages();
  updateMsgBadges();
}

function openThread(c) {
  threadChat = c;
  markChatRead(c);
  $("threadNet").textContent = netLabel(c.network);
  $("threadNet").className = "net " + netClass(c.network);
  $("threadTitle").textContent = c.title || "(no title)";
  const body = $("threadBody");
  body.replaceChildren();
  (c.messages || []).forEach(m => {
    const b = el("div", "bub " + (m.is_me ? "me" : "them"));
    if (!m.is_me && c.group) b.appendChild(el("div", "bubName", m.sender || "?"));
    b.appendChild(linkify(m.text || (m.kind && m.kind !== "TEXT" ? "[" + m.kind.toLowerCase() + "]" : "")));
    b.appendChild(el("div", "bubTime", m.ts ? ago(m.ts) + " ago" : ""));
    body.appendChild(b);
  });
  $("thread").classList.add("open");
  setTimeout(() => { body.scrollTop = body.scrollHeight; }, 40);
}

function closeThread() { $("thread").classList.remove("open"); threadChat = null; renderDeskPane(); }

async function sendMessage() {
  if (!threadChat) return;
  const inp = $("threadInput");
  const text = inp.value.trim();
  if (!text) return;
  const key = localStorage.getItem("mailbrief_key");
  const body = $("threadBody");
  const b = el("div", "bub me");
  b.appendChild(document.createTextNode(text));
  const stamp = el("div", "bubTime", "sending…");
  b.appendChild(stamp);
  body.appendChild(b);
  body.scrollTop = body.scrollHeight;
  inp.value = "";
  try {
    const r = await fetch(DB + "/briefs/" + encodeURIComponent(key) + "/msg_outbox.json", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatID: threadChat.id, text: text, at: Date.now() }),
    });
    stamp.textContent = r.ok ? "queued ✓ — sends from your Mac" : "failed";
  } catch (e) {
    stamp.textContent = "offline — will send when connected";
  }
}

function switchView(which) {
  VIEW = which;
  const isPrio = which === "priority", isMail = which === "mail";
  const isMsg = which === "msg" || which === "dm";
  if (isMsg) MSGVIEW = which;
  $("priorityView").style.display = isPrio ? "block" : "none";
  $("mailView").style.display = isMail ? "block" : "none";
  $("msgView").style.display = isMsg ? "block" : "none";
  [["tabPriority", isPrio], ["tabMail", isMail], ["tabMsg", which === "msg"], ["tabDM", which === "dm"]]
    .forEach(([id, on]) => {
      $(id).classList.toggle("on", on);
      $(id).setAttribute("aria-selected", String(on));
      $(id).tabIndex = on ? 0 : -1;   // roving tabindex: only the active tab is in the tab order
    });
  if (isMsg) $("briefStrip").classList.add("hidden"); // brief strip only on priority/mail
  if (isPrio) { renderPriority(); loadMessages(); }  // load msgs so the merge is complete
  else if (isMail) { if (BRIEF) render(); }
  else loadMessages();
}

$("tabPriority").addEventListener("click", () => switchView("priority"));
$("tabMail").addEventListener("click", () => switchView("mail"));
$("tabMsg").addEventListener("click", () => switchView("msg"));
$("tabDM").addEventListener("click", () => switchView("dm"));
// Arrow-key navigation between tabs (WAI-ARIA tablist pattern).
$("viewTabs").addEventListener("keydown", e => {
  const order = ["tabPriority", "tabMail", "tabMsg", "tabDM"];
  const views = { tabPriority: "priority", tabMail: "mail", tabMsg: "msg", tabDM: "dm" };
  const idx = order.indexOf(e.target.id);
  if (idx < 0) return;
  let n = -1;
  if (e.key === "ArrowRight" || e.key === "ArrowDown") n = (idx + 1) % order.length;
  else if (e.key === "ArrowLeft" || e.key === "ArrowUp") n = (idx - 1 + order.length) % order.length;
  else if (e.key === "Home") n = 0;
  else if (e.key === "End") n = order.length - 1;
  else return;
  e.preventDefault();
  switchView(views[order[n]]);
  $(order[n]).focus();
});
$("searchBox").addEventListener("input", e => {
  SEARCH = e.target.value.trim().toLowerCase();
  if (VIEW === "priority") renderPriority();
  else if (VIEW === "mail") { if (BRIEF) render(); }
  else renderMessages();
});

// Global keyboard shortcuts (documented in the empty desktop pane).
document.addEventListener("keydown", e => {
  if (!document.body.classList.contains("signed-in")) return;
  const typing = e.target && e.target.matches && e.target.matches("input, textarea");
  if (e.key === "Escape") {
    if (typing) { e.target.blur(); return; }
    closeSettings(); closeCompose(); closeReader(); closeThread();
    if ($("app").classList.contains("search-open")) {
      // Also clear the query — otherwise the lists stay filtered by a now-hidden search.
      $("app").classList.remove("search-open");
      $("searchBox").value = ""; SEARCH = ""; reRenderActive();
    }
    return;
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "/") { e.preventDefault(); $("app").classList.add("search-open"); $("searchBox").focus(); }
  else if (e.key === "1") switchView("priority");
  else if (e.key === "2") switchView("mail");
  else if (e.key === "3") switchView("msg");
  else if (e.key === "4") switchView("dm");
  else if (e.key === "r" || e.key === "R") { const b = $("updateBtn"); if (b) b.click(); }
});

$("threadBack").addEventListener("click", closeThread);
$("threadSend").addEventListener("click", sendMessage);
$("threadInput").addEventListener("keydown", e => { if (e.key === "Enter") sendMessage(); });
(function () {
  const t = $("thread");
  let sx = 0, sy = 0, tracking = false;
  t.addEventListener("touchstart", e => {
    if (e.target.closest("#threadCompose")) { tracking = false; return; }
    if (e.touches.length !== 1) { tracking = false; return; }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; tracking = true;
  }, { passive: true });
  t.addEventListener("touchend", e => {
    if (!tracking) return;
    tracking = false;
    const c = e.changedTouches[0];
    if (Math.abs(c.clientX - sx) > 65 && Math.abs(c.clientX - sx) > Math.abs(c.clientY - sy) * 1.5) closeThread();
  }, { passive: true });
})();

// Magic-link sign-in: the access key may arrive in the URL fragment (#k=...).
// Fragments never leave the device — they aren't sent to any server.
if (location.hash.startsWith("#k=")) {
  let k = location.hash.slice(3).trim();
  try { k = decodeURIComponent(k); } catch (_) { /* leave raw if malformed */ }
  if (k) localStorage.setItem("mailbrief_key", k);
  history.replaceState(null, "", location.pathname);
}
const saved = localStorage.getItem("mailbrief_key");
if (saved) load(saved, false); else showKeyScreen();
setInterval(() => { const k = localStorage.getItem("mailbrief_key"); if (k && !document.hidden) load(k, false); }, 300000);
document.addEventListener("visibilitychange", () => {
  const k = localStorage.getItem("mailbrief_key");
  if (!document.hidden && k) load(k, false);
});
window.addEventListener("online", () => {
  updateNetBar(false);
  flushOutbox();
  const k = localStorage.getItem("mailbrief_key");
  if (k) load(k, false);
});
window.addEventListener("offline", () => updateNetBar(true));
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

/* ===== buzz notifications for new important mail ===== */
const VAPID_PUB = "BECv8w1dKUbZvlj4X6vhWEV9ukkimpvoG38aURLJElDJKigZv3gqabPus448uHk7N7e6Dg9OGw-yFkFeIbk_LQY";

function b64ToBytes(s) {
  const pad = "=".repeat((4 - s.length % 4) % 4);
  const raw = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

async function setupAlerts() {
  const btn = $("alertBtn");
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  btn.style.display = "inline-block";
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub && Notification.permission === "granted") {
      btn.textContent = "🔔 Alerts on ✓";
      btn.disabled = true;
      return;
    }
  } catch (e) { /* fall through to enable flow */ }
  btn.addEventListener("click", enableAlerts);
}

async function enableAlerts() {
  const btn = $("alertBtn");
  try {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      btn.textContent = "Alerts blocked — allow in Settings";
      return;
    }
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToBytes(VAPID_PUB),
    });
    const key = localStorage.getItem("mailbrief_key");
    const r = await fetch(DB + "/briefs/" + encodeURIComponent(key) + "/subs.json", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sub: sub.toJSON(), ua: navigator.userAgent.slice(0, 80), at: Date.now() }),
    });
    if (!r.ok) throw new Error("could not save subscription");
    btn.textContent = "🔔 Alerts on ✓";
    btn.disabled = true;
  } catch (e) {
    btn.textContent = "Alerts failed — tap to retry";
  }
}
setupAlerts();

/* ===== Firebase Auth — STAGE 1 (additive; does NOT gate data access yet) =====
   Google sign-in runs ALONGSIDE the access key. The key still drives every read
   and write; this only proves sign-in works on each device before we enforce it.
   Everything here is failure-tolerant: if the SDK can't load (offline/CDN), the
   app is completely unaffected. */
const FB_CONFIG = {
  apiKey: "AIzaSyAo8dLtUZ9o2LQwpYxaU5sTUKqPl1xqu9Y",
  // Reverted to the auto-registered handler domain so sign-in never hits a
  // redirect_uri_mismatch. (The same-origin web.app handler needs its redirect
  // URI added to the OAuth client before it can be used — deferred.)
  authDomain: "mail-brief-gio.firebaseapp.com",
  projectId: "mail-brief-gio",
  appId: "1:664051139279:web:b45f827b45805dbb7b6dba",
  messagingSenderId: "664051139279",
};
const AUTH_ALLOWED = ["gcoglitore@gmail.com"];  // authorized sign-in identities
const FB_SDK = "https://www.gstatic.com/firebasejs/11.0.2/";
let _fbMod = null, _fbAuth = null, _fbUser = null;

async function fbLoad() {
  if (_fbAuth) return;
  const [appMod, authMod] = await Promise.all([
    import(FB_SDK + "firebase-app.js"),
    import(FB_SDK + "firebase-auth.js"),
  ]);
  _fbMod = authMod;
  _fbAuth = authMod.getAuth(appMod.initializeApp(FB_CONFIG));
  authMod.onAuthStateChanged(_fbAuth, u => { _fbUser = u; renderAuthRow(); });
  try { await authMod.getRedirectResult(_fbAuth); } catch (_) {}  // returning from Google
}
async function fbSignIn() {
  try {
    await fbLoad();
    const provider = new _fbMod.GoogleAuthProvider();
    provider.setCustomParameters({ login_hint: AUTH_ALLOWED[0], prompt: "select_account" });
    await _fbMod.signInWithRedirect(_fbAuth, provider);  // redirect (works in installed PWAs)
  } catch (e) {
    showToast("Sign-in isn't available right now — your key still works", { state: "fail", ms: 3500 });
  }
}
async function fbSignOut() {
  try { await fbLoad(); await _fbMod.signOut(_fbAuth); } catch (_) {}
}
// Fill the Preferences "Account" row in place (no sheet rebuild, so it can update
// live when auth state resolves without disturbing anything else in the sheet).
function fillAuthRow(row) {
  if (!row) return;
  row.replaceChildren();
  const email = _fbUser && _fbUser.email;
  if (email && AUTH_ALLOWED.includes(email)) {
    row.appendChild(el("div", "setLabel", "✓ Signed in as " + email));
    const out = el("button", "segBtn", "Sign out");
    out.addEventListener("click", fbSignOut);
    row.appendChild(out);
  } else if (email) {
    row.appendChild(el("div", "setLabel", "Signed in as " + email + " — not your authorized account"));
    const out = el("button", "segBtn", "Sign out");
    out.addEventListener("click", fbSignOut);
    row.appendChild(out);
  } else {
    row.appendChild(el("div", "setLabel", "Sign in with Google"));
    const inb = el("button", "segBtn on", "Sign in");
    inb.addEventListener("click", fbSignIn);
    row.appendChild(inb);
  }
}
function renderAuthRow() { fillAuthRow(document.getElementById("authRow")); }
// Kick off auth init after the app has painted so we can catch a returning
// redirect and know the signed-in state — deferred + guarded so it never blocks.
setTimeout(() => { fbLoad().catch(() => {}); }, 1200);
