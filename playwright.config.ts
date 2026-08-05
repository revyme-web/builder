import { defineConfig, devices } from '@playwright/test';

// E2E config. Runs the editor for real: real browser, real pointer events,
// real renderer, real ProjectFS commits.
//
// DEDICATED PORT (4333, not the dev server's 3333). The daily dev stack runs
// in CLOUD mode, where `/` redirects to /auth and every spec dies at
// waitForCanvasReady — and killing it to run tests is not an option. So
// Playwright boots its OWN parent in LOCAL mode on 4333 (process env beats
// .env in Vite's loadEnv, and local mode also skips the cloud-only
// hmr:{port:3333} override + the '/builder/' base). Run the suite any time,
// dev stack up or down, without touching it.
//
// The SANDBOX (canvas iframe) is pinned to 5174 by SANDBOX_ORIGIN in
// canvas-sandbox/protocol.ts, so both stacks necessarily share it. That's
// fine — the sandbox is stateless per iframe and serves from the same disk —
// so we reuse a running one and only boot our own when nothing is there.
//
// Any `e2e/` folder anywhere under src/ is picked up (testDir + testMatch),
// so a new area only needs its own folder — no config edit, and no suite
// silently not running because someone forgot to register it.

const PORT = Number(process.env.E2E_PORT ?? 4333);
const SANDBOX_PORT = Number(process.env.E2E_SANDBOX_PORT ?? 5174);

export default defineConfig({
  testDir: './src',
  testMatch: '**/e2e/**/*.spec.ts',
  // Drag specs drive one shared dev server with real pointer streams.
  // Serial by default; `E2E_WORKERS=3 npm run e2e` to try parallel locally
  // (each test gets its own browser context, so seeds don't collide — the
  // shared resources are CPU and the one Vite server).
  fullyParallel: false,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 1,
  forbidOnly: !!process.env.CI,
  // Individually these tests are stable (verified 4–5 consecutive passes
  // each); under full-suite load a different one or two go red per run as
  // the shared dev server and CPU get contended. One retry converts that
  // noise into a "flaky" line in the report instead of a red suite — the
  // count stays VISIBLE, so a test that starts needing its retry every run
  // is still a signal, not a silent pass.
  retries: process.env.CI ? 2 : 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
    viewport: { width: 1600, height: 1000 },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      // LOCAL mode explicitly — never inherit the dev stack's cloud flag.
      command: `npx vite --port ${PORT} --strictPort`,
      env: { VITE_REVYME_CLOUD: 'false' },
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      // Reused when the dev stack already serves it (the common case).
      command: 'npx vite --config vite.sandbox.config.ts',
      url: `http://localhost:${SANDBOX_PORT}`,
      reuseExistingServer: true,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
