import { defineConfig, devices } from "@playwright/test";

import { execFileSync } from "node:child_process";

const PORT = 3200;

/** Local Supabase connection for the auth specs; absent when the stack isn't running. */
function localSupabase(): { url: string; key: string; secret: string } | null {
  const url = process.env.TEST_API_URL;
  const key = process.env.TEST_PUBLISHABLE_KEY;
  const secret = process.env.TEST_SECRET_KEY;
  if (url && key && secret) return { url, key, secret };
  try {
    const out = execFileSync("supabase", ["status", "-o", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
    const json = JSON.parse(out.slice(out.indexOf("{"))) as {
      API_URL?: string;
      PUBLISHABLE_KEY?: string;
      SECRET_KEY?: string;
    };
    return json.API_URL && json.PUBLISHABLE_KEY && json.SECRET_KEY
      ? { url: json.API_URL, key: json.PUBLISHABLE_KEY, secret: json.SECRET_KEY }
      : null;
  } catch {
    return null;
  }
}
const supabase = localSupabase();

// Firefox's Playwright build does not launch on the current macOS dev machine
// (profile-folder error), so it runs in CI and on request locally (E2E_FIREFOX=1).
const firefoxProject =
  process.env.CI || process.env.E2E_FIREFOX
    ? [
        {
          name: "firefox",
          testMatch: /smoke\.spec\.ts/,
          use: { ...devices["Desktop Firefox"] },
        },
      ]
    : [];

export default defineConfig({
  testDir: "./tests/e2e",
  // Locally the default (half the cores) plus the app server and the database stack overloads the
  // machine; the timeouts that follow were load, not bugs. Override with E2E_WORKERS.
  ...(process.env.E2E_WORKERS
    ? { workers: Number(process.env.E2E_WORKERS) }
    : process.env.CI
      ? {}
      : { workers: 3 }),
  // Slower local machines need more room for the long axe sweeps than CI's clean runners.
  timeout: process.env.CI ? 30_000 : 60_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Traces are many small files; locally they cost scan and disk time on every test.
    trace: process.env.CI ? "retain-on-failure" : "off",
  },
  // Chromium runs everything; Firefox and WebKit run only the shallow smoke spec.
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "webkit",
      testMatch: /smoke\.spec\.ts/,
      use: { ...devices["Desktop Safari"] },
    },
    ...firefoxProject,
  ],
  webServer: {
    // Rebuilds only when source changed (CI always builds); see scripts/e2e-serve.sh.
    command: `sh scripts/e2e-serve.sh ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      NEXT_PUBLIC_APP_URL: `http://localhost:${PORT}`,
      NEXT_PUBLIC_SUPABASE_URL: supabase?.url ?? "",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: supabase?.key ?? "",
      // Local stack only: uploads need the service role; no scanner exists, so downloads are opted in.
      SUPABASE_SECRET_KEY: supabase?.secret ?? "",
      DOCUMENTS_ALLOW_UNSCANNED_DOWNLOADS: "true",
      // UX-11 is off by default; the suite runs with it on so the builder and questions are covered.
      RSVP_FORM_BUILDER: "on",
      // UX-15: `next start` is a production build, which turns public RSVP links off without a
      // trusted client-address header. Next's own server appends the socket address to this one.
      CLIENT_IP_HEADER: "x-forwarded-for",
      // UX-16 is off by default; the suite turns the guest email outbox on with the labelled
      // local sink, which reaches no one (production builds need the explicit allow).
      GUEST_EMAIL: "on",
      MAIL_PROVIDER: "dev-sink",
      MAIL_ALLOW_DEV_SINK: "true",
      // UX-17 is off by default; the suite turns guest shuttles on.
      GUEST_SHUTTLES: "on",
      GUEST_LODGING: "on",
      DAY_OF_CHECKIN: "on",
    },
  },
});
