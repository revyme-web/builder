import { defineConfig, devices } from '@playwright/test';

// Drag/drop E2E config. The dev server is `npm run dev` (Vite + sandbox
// + preview, ports 3333 / 5174 / 5175). We boot Vite ourselves and let
// Playwright reuse the running server when re-running locally.
export default defineConfig({
  testDir: './src/canvas/drag/e2e',
  // Drag tests are heavy (real pointer events, real renderer); keep
  // them serial so they don't fight over the same dev server pages.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3333',
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
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3333',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
