import { test as base, expect } from '@playwright/test';

function isBenignNetworkConsole(text) {
  return /net::ERR_|Failed to fetch|ChunkLoadError|Loading chunk \d+ failed|favicon/i.test(text);
}

function isBenignCspConsole(text) {
  return (
    /frame-ancestors.*meta element/i.test(text) ||
    /Content Security Policy directive 'frame-ancestors'/i.test(text) ||
    /generate_204.*Content Security Policy/i.test(text) ||
    /google\.com\/generate_204.*Refused to connect/i.test(text)
  );
}

export const test = base.extend({
  page: async ({ page }, use) => {
    const pageErrors = [];
    const consoleErrors = [];

    page.on('pageerror', (err) => {
      pageErrors.push(err?.message || String(err));
    });
    page.on('console', (msg) => {
      const t = msg.text();
      if (
        msg.type() === 'error' &&
        !isBenignNetworkConsole(t) &&
        !isBenignCspConsole(t)
      ) {
        consoleErrors.push(t);
      }
    });

    await use(page);

    expect(
      pageErrors,
      `Uncaught page errors: ${pageErrors.join(' | ')}`
    ).toHaveLength(0);
    expect(
      consoleErrors,
      `Console errors: ${consoleErrors.join(' | ')}`
    ).toHaveLength(0);
  },
});

export { expect } from '@playwright/test';
