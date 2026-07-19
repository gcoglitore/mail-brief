// Shared test fixtures + a mock backend for the Mail Brief client.
//
// The client talks to two hosts: the Firebase RTDB (GETs brief/messages/settings/
// flags, PUT/POSTs flags/subs/outbox) and the send API (mail-brief-gio.web.app/
// api/send). We intercept both so tests are deterministic and never hit the real
// account. The page itself is served from localhost and is NOT intercepted.

const NOW = Math.floor(Date.now() / 1000);

function makeBrief() {
  return {
    generated_at: NOW - 300,
    accounts: [{ account: "QLAD", ok: true, count: 2 }],
    items: [
      {
        account: "QLAD",
        from_name: "Dana Investor",
        from_email: "dana@vc.com",
        subject: "Term sheet — sign by Friday?",
        snippet: "Can you review and sign page 4 before the call?",
        body: "Hi Gio,\n\nPlease review and sign page 4 of the attached term sheet before our call.\n\nThanks,\nDana",
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
        unread: false,
        bucket: "attention",
        msgid: "m2@x",
        reply_to: "bob@ops.com",
        references: "",
        signals: { reply: false, doc: false, meeting: false },
      },
    ],
  };
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
        messages: [
          { text: "running late?", ts: NOW - 1300, is_me: false },
          { text: "see you at 6", ts: NOW - 1200, is_me: false },
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
        messages: [{ text: "deploy done", ts: NOW - 4000, is_me: false, sender: "Priya" }],
      },
    ],
  };
}

async function mockBackend(page, state) {
  await page.route(/firebaseio\.com/, async (route) => {
    const req = route.request();
    const p = new URL(req.url()).pathname;
    const m = req.method();
    if (m === "GET" && p.endsWith("/brief.json")) return route.fulfill({ json: state.brief });
    if (m === "GET" && p.endsWith("/messages.json")) return route.fulfill({ json: state.msgs });
    if (m === "GET" && p.endsWith("/settings.json")) return route.fulfill({ json: state.settings });
    if (m === "GET" && p.endsWith("/flags.json")) return route.fulfill({ json: state.flags });
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
    { brief: makeBrief(), msgs: makeMsgs(), settings: { group_threads: true }, flags: {}, apiOffline: false },
    overrides
  );
  await mockBackend(page, state);
  await page.addInitScript(() => localStorage.setItem("mailbrief_key", "testkey"));
  await page.goto("/");
  await page.waitForSelector("body.signed-in");
  return state; // mutate state.apiOffline mid-test to toggle connectivity
}

module.exports = { NOW, makeBrief, makeMsgs, mockBackend, signIn };
