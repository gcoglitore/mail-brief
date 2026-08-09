// Shared test fixtures + a mock backend for the Mail Brief client.
//
// The client talks to two hosts: the Firebase RTDB (GETs brief/messages/settings/
// flags, PUT/POSTs flags/subs/outbox) and the send API (mail-brief-gio.web.app/
// api/send). We intercept both so tests are deterministic and never hit the real
// account. The page itself is served from localhost and is NOT intercepted.

const NOW = Math.floor(Date.now() / 1000);
function pacificDateKey() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const get = t => parts.find(p => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function makeBrief() {
  return {
    generated_at: NOW - 300,
    accounts: [{ account: "QLAD", ok: true, count: 2 }],
    calendar: [
      { title: "Board call", start: NOW + 3600, end: NOW + 5400, location: "Zoom", all_day: false },
      { title: "Standup", start: NOW - 600, end: NOW + 600, location: "", all_day: false }, // in progress
      { title: "Design review", start: NOW + 90000, end: NOW + 93600, location: "Room 2", all_day: false },
    ],
    daily_brief: {
      date: pacificDateKey(),
      timezone: "America/Los_Angeles",
      generated_at: NOW - 120,
      headline: "3 replies and 2 events shape today",
      summary: "Start with Sign term sheet, page 4. Your calendar has 2 events.",
      counts: { mail: 2, replies: 3, conversations: 2, events: 2, overdue: 1, important_unread: 2, attention: 2 },
      focus: [
        { kind: "mail", id: "mail:m1@x", title: "Sign term sheet, page 4", source: "Dana Investor", channel: "QLAD", reason: "Reply needed", ts: NOW - 3 * 86400 },
        { kind: "message", id: "msg:c1", title: "see you at 6", source: "Sarah", channel: "imessage", reason: "2 unread", ts: NOW - 1200 },
      ],
      important_unread: [
        { kind: "mail", id: "mail:m1@x", title: "Term sheet — sign by Friday?", source: "Dana Investor", channel: "QLAD", reason: "Reply needed", ts: NOW - 3 * 86400 },
        { kind: "mail", id: "mail:m2@x", title: "Nightly report", source: "Bob Ops", channel: "QLAD", reason: "Unread priority", ts: NOW - 3600 },
      ],
      schedule: [
        { title: "Standup", start: NOW - 600, end: NOW + 600, location: "", all_day: false },
        { title: "Board call", start: NOW + 3600, end: NOW + 5400, location: "Zoom", all_day: false },
      ],
      news: {
        generated_at: NOW - 120,
        national: [
          { title: "Congress advances a major infrastructure package", source: "AP News", url: "https://news.google.com/articles/us-1", published_at: NOW - 900 },
          { title: "States prepare for a new round of severe weather", source: "NPR", url: "https://news.google.com/articles/us-2", published_at: NOW - 1800 },
        ],
        international: [
          { title: "Global leaders meet for renewed ceasefire talks", source: "BBC", url: "https://news.google.com/articles/world-1", published_at: NOW - 1200 },
          { title: "Markets react to the latest central-bank decision", source: "Reuters", url: "https://news.google.com/articles/world-2", published_at: NOW - 2400 },
        ],
      },
    },
    items: [
      {
        account: "QLAD",
        from_name: "Dana Investor",
        from_email: "dana@vc.com",
        subject: "Term sheet — sign by Friday?",
        snippet: "Can you review and sign page 4 before the call?",
        body: "Hi Gio,\n\nPlease review and sign page 4 here: https://example.com/termsheet before our call.\n\nThanks,\nDana",
        ts: NOW - 3 * 86400,
        unread: true,
        bucket: "attention",
        msgid: "m1@x",
        reply_to: "dana@vc.com",
        references: "",
        link: "https://mail.google.com/mail/u/0/#x",
        action_summary: "Sign term sheet, page 4",
        signals: { reply: true, doc: true, meeting: false },
        attachments: [{ name: "term-sheet.pdf", size: 2411724 }],
        thread: [{ from: "Dana Investor", ts: NOW - 5 * 86400, snippet: "Sending the term sheet over for review." }],
        thread_count: 2,
      },
      {
        account: "QLAD",
        from_name: "Bob Ops",
        from_email: "bob@ops.com",
        subject: "Nightly report",
        snippet: "All systems green.",
        body: "All systems green overnight.",
        ts: NOW - 3600,
        unread: true,
        bucket: "attention",
        msgid: "m2@x",
        reply_to: "bob@ops.com",
        references: "",
        signals: { reply: false, doc: false, meeting: false },
      },
    ],
  };
}

function makeNews() {
  return [{
    id: "ai-regulation-approved",
    category: "Technology",
    headline: "Major AI regulation approved",
    summary: "New compliance rules could affect how businesses use customer data.",
    details: "The regulation introduces new disclosure, risk-assessment, and data-governance requirements. Businesses should identify affected AI systems and review how customer data is collected, processed, and retained.",
    source: "Reuters",
    other_sources: 3,
    published_at: NOW - 8 * 60,
    url: "https://www.reuters.com/technology/",
  }];
}

function makeMsgs() {
  return {
    chats: [
      {
        id: "c1",
        network: "imessage",
        title: "Sarah",
        preview: "see you at 6",
        ts: NOW - 1200,
        unread: 2,
        sendable: true,
        messages: [
          { text: "running late?", ts: NOW - 1300, is_me: false },
          { text: "map here www.example.com/spot see you at 6", ts: NOW - 1200, is_me: false },
        ],
      },
      {
        id: "c2",
        network: "signal",
        title: "Ops channel",
        preview: "deploy done",
        ts: NOW - 4000,
        unread: 1,
        group: true,
        sendable: true,
        messages: [{ text: "deploy done", ts: NOW - 4000, is_me: false, sender: "Priya" }],
      },
      {
        id: "c3",
        network: "linkedin",
        title: "Morgan Lee",
        preview: "Could you send the deck?",
        ts: NOW - 1800,
        unread: 1,
        sendable: true,
        messages: [{ text: "Could you send the deck?", ts: NOW - 1800, is_me: false, sender: "Morgan Lee" }],
      },
    ],
  };
}

async function mockBackend(page, state) {
  // Keep tests hermetic: the Firebase Auth SDK (loaded from gstatic) never loads,
  // so the Account row just shows "Sign in" and no auth network happens.
  await page.route(/gstatic\.com\/firebasejs/, (route) => route.abort());
  await page.route(/firebaseio\.com/, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const m = req.method();
    if (m === "GET" && p.endsWith("/brief.json")) return route.fulfill({ json: state.brief });
    if (m === "GET" && p.endsWith("/messages.json")) return route.fulfill({ json: state.msgs });
    if (m === "GET" && p.endsWith("/settings.json")) return route.fulfill({ json: state.settings });
    if (m === "GET" && p.endsWith("/flags.json")) return route.fulfill({ json: state.flags });
    if (m === "GET" && p.endsWith("/news.json")) return route.fulfill({ json: state.news });
    if (m === "PUT" && p.includes("/msg_outbox/") && state.msgQueueOffline) return route.abort("failed");
    // Any write (flags PUT, subs POST, msg_outbox POST, settings PUT) just succeeds.
    return route.fulfill({ json: { ok: true, name: "k1" } });
  });
  await page.route(/mail-brief-gio\.web\.app\/api\/send/, async (route) => {
    if (state.apiOffline) return route.abort("failed"); // simulate no connection
    const body = route.request().postDataJSON() || {};
    const map = {
      archive: { ok: true, archived: true },
      archiveall: { ok: true, archived: 1 },
      markread: { ok: true },
      markallread: { ok: true },
      refresh: { ok: true },
      draft: { ok: true, options: ["Tuesday 10am works — see you then."] },
    };
    const resp = body.action ? map[body.action] || { ok: true } : { ok: true }; // no action = send
    return route.fulfill({ json: resp });
  });
}

// Sign in with a mocked backend and wait until the app has painted.
async function signIn(page, overrides) {
  const state = Object.assign(
    { brief: makeBrief(), news: makeNews(), msgs: makeMsgs(), settings: { group_threads: true }, flags: {}, apiOffline: false, msgQueueOffline: false },
    overrides
  );
  await mockBackend(page, state);
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("mailbrief_skip_test_key")) localStorage.setItem("mailbrief_key", "testkey");
  });
  await page.goto("/");
  await page.waitForSelector("body.signed-in");
  return state; // mutate state.apiOffline mid-test to toggle connectivity
}

module.exports = { NOW, makeBrief, makeNews, makeMsgs, mockBackend, signIn };
