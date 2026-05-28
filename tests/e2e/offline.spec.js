import { test, expect } from './fixtures.js';

test.describe('offline resilience', () => {
  test('app shell survives offline toggle on home', async ({ page, context }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#root')).toBeAttached();
    await context.setOffline(true);
    await expect(page.locator('#root')).toBeAttached();
    await context.setOffline(false);
    await page.waitForTimeout(300);
    await expect(page.locator('#root')).toBeAttached();
  });

  test('auth route remains reachable offline', async ({ page, context }) => {
    await page.goto('/auth', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#root')).toBeAttached();
    await context.setOffline(true);
    await expect(page.locator('#root')).toBeAttached();
    await context.setOffline(false);
  });
});
