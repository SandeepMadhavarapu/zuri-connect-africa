import { test, expect } from './fixtures.js';

test.describe('smoke', () => {
  test('shell renders without crash', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#root')).toBeAttached();
  });

  test('auth route responds', async ({ page }) => {
    const res = await page.goto('/auth');
    expect(res?.ok()).toBeTruthy();
    await expect(page).toHaveURL(/\/auth/);
    await expect(page.locator('#root')).toBeAttached();
  });
});
