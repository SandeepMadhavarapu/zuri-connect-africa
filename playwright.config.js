import { defineConfig, devices } from '@playwright/test';

/** Overrides any local .env / .env.local that might blank out Supabase during `vite build --mode e2e`. */
const e2eForcedEnv = {
  VITE_APP_ENV: 'development',
  VITE_STRICT_ENV: 'false',
  VITE_SUPABASE_URL: 'https://placeholder.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'placeholder-placeholder-placeholder-placeholder',
};

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
  },
  webServer: process.env.PLAYWRIGHT_SKIP_WEBSERVER
    ? undefined
    : {
        command:
          process.env.CI === 'true'
            ? 'npm run preview -- --host 127.0.0.1 --port 4173'
            : 'npm run build:preview:e2e',
        url: 'http://127.0.0.1:4173',
        env: { ...process.env, ...e2eForcedEnv },
        reuseExistingServer: false,
        timeout: 300000,
      },
});
