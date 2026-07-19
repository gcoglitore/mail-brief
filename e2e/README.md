# Mail Brief — UI tests

Hermetic browser tests for the client (`public/index.html`). Every backend call
(Firebase RTDB + the send API) is mocked in `fixtures.js`, so the suite is
deterministic and never touches the live account.

## Run locally

```bash
cd e2e
npm install
npx playwright install chromium   # one-time browser download
npm test                          # runs all specs against a local static server
npm run test:headed               # watch it drive the browser
```

The static server (`python3 -m http.server`) is started automatically by
`playwright.config.js` and serves `../public`.

## Coverage

| Spec | Scenario |
|------|----------|
| `layout.spec.js` | Locked vs signed-in; desktop two-pane |
| `navigation.spec.js` | Mobile bottom nav + icons; arrow-key tab nav |
| `archive.spec.js` | Archive + Undo; commit after the undo window |
| `snooze.spec.js` | Snooze → Snoozed list → Restore |
| `preferences.spec.js` | Density preference persists across reload |
| `reader.spec.js` | Attachments / thread / why-priority; non-repliable hides Reply+Draft |
| `focus.spec.js` | Focus restoration for the dialog and the row menu |
| `offline-outbox.spec.js` | Reply queued offline, flushed when back online |

CI runs this suite on any push touching `public/**` or `e2e/**`
(`.github/workflows/ui-tests.yml`).
