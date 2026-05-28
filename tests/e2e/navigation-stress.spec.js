import { test, expect } from './fixtures.js';

const ROUTES = ['/', '/history', '/budget', '/profile', '/send', '/network', '/notifications', '/security', '/auth'];

test.describe('navigation stress', () => {
  test('rapid sequential navigations keep root mounted', async ({ page }) => {
    for (let round = 0; round < 3; round++) {
      for (const path of ROUTES) {
        try {
          await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 30000 });
        } catch (err) {
          const msg = String(err?.message || err);
          if (!/ERR_ABORTED|interrupted by another navigation/i.test(msg)) throw err;
        }
        await expect(page.locator('#root')).toBeAttached({ timeout: 15000 });
      }
    }
  });

  test('viewport resize does not detach shell', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#root')).toBeAttached();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('#root')).toBeAttached();
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(page.locator('#root')).toBeAttached();
  });
});
