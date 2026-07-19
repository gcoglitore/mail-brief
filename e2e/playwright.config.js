const { defineConfig } = require("@playwright/test");

// Serves the real public/ shell on a local port and runs Chromium against it.
// Every backend call (Firebase RTDB + the send API) is mocked per-test in
// fixtures.js, so these tests are fully hermetic and never touch the live account.
module.exports = defineConfig({
  testDir: ".",
  timeout: 20000,
  expect: { timeout: 6000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL: "http://localhost:8799",
    serviceWorkers: "block",   // keep the SW out of the way so reloads are deterministic
    trace: "on-first-retry",
  },
  webServer: {
    command: "python3 -m http.server 8799 --directory ../public",
    url: "http://localhost:8799",
    reuseExistingServer: !process.env.CI,
    timeout: 30000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
