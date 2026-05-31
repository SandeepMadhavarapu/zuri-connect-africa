/**
 * Integration test config — live-infrastructure tests only.
 *
 * Picks up ONLY `*.integration.test.js` files under tests/integration/. These
 * hit deployed Edge Functions over real HTTP and require env vars (see each
 * test file's header). They are intentionally excluded from the default
 * `vitest.config.js` / `test:ci` / `prepitch` chain.
 *
 * Run with:  npm run test:integration
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/integration/**/*.integration.test.{js,jsx}'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
});
