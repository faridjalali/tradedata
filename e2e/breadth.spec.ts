import { test, expect, Page } from '@playwright/test';

async function unlockSite(page: Page) {
  if (await page.locator('#site-lock-overlay:not(.hidden)').isVisible()) {
    await page.locator('.lock-key-btn[data-lock-digit="1"]').click();
    await page.locator('.lock-key-btn[data-lock-digit="2"]').click();
    await page.locator('.lock-key-btn[data-lock-digit="3"]').click();
    await page.locator('.lock-key-btn[data-lock-digit="4"]').click();
    await expect(page.locator('#site-lock-overlay')).toHaveClass(/hidden/);
  }
}

test.describe('Breadth View', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/auth/check', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"authenticated": true}' });
    });

    await page.route('**/api/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/api/breadth?ticker=')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            intraday: false,
            points: [
              { date: '2026-02-10', spy: 100, comparison: 100 },
              { date: '2026-02-11', spy: 102, comparison: 103 },
              { date: '2026-02-12', spy: 101, comparison: 104 },
              { date: '2026-02-13', spy: 103, comparison: 105 },
              { date: '2026-02-14', spy: 104, comparison: 106 },
            ],
          }),
        });
        return;
      }

      if (url.includes('/api/breadth/ma?')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            snapshots: [
              { index: 'SPY', date: '2026-02-14', ma21: 62.1, ma50: 58.2, ma100: 52.9, ma200: 49.4, total: 500 },
              { index: 'QQQ', date: '2026-02-14', ma21: 66.2, ma50: 61.1, ma100: 55.8, ma200: 50.3, total: 100 },
            ],
            history: {
              SPY: [
                { date: '2026-02-10', ma21: 56.0, ma50: 53.0, ma100: 50.0, ma200: 48.0, close: 580.1 },
                { date: '2026-02-11', ma21: 58.0, ma50: 54.0, ma100: 51.0, ma200: 48.5, close: 582.8 },
                { date: '2026-02-12', ma21: 59.0, ma50: 56.0, ma100: 51.4, ma200: 48.7, close: 584.2 },
                { date: '2026-02-13', ma21: 60.0, ma50: 57.1, ma100: 52.0, ma200: 49.0, close: 586.4 },
                { date: '2026-02-14', ma21: 62.1, ma50: 58.2, ma100: 52.9, ma200: 49.4, close: 589.0 },
              ],
              QQQ: [
                { date: '2026-02-10', ma21: 61.0, ma50: 57.0, ma100: 53.0, ma200: 49.0, close: 510.0 },
                { date: '2026-02-11', ma21: 62.0, ma50: 58.0, ma100: 53.6, ma200: 49.2, close: 512.5 },
                { date: '2026-02-12', ma21: 63.0, ma50: 59.0, ma100: 54.0, ma200: 49.5, close: 514.9 },
                { date: '2026-02-13', ma21: 64.5, ma50: 60.0, ma100: 54.8, ma200: 50.0, close: 517.2 },
                { date: '2026-02-14', ma21: 66.2, ma50: 61.1, ma100: 55.8, ma200: 50.3, close: 520.4 },
              ],
            },
          }),
        });
        return;
      }

      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/#/breadth');
    await unlockSite(page);
    await page.waitForFunction(() => window.location.hash === '#/breadth');
    await expect(page.locator('#view-breadth')).toBeVisible({ timeout: 15000 });
  });

  test('renders breadth charts and allows control toggles', async ({ page }) => {
    await expect(page.locator('#breadth-chart')).toBeVisible();
    await expect(page.locator('#breadth-ma-chart')).toBeVisible();
    await expect(page.locator('#breadth-compare-chart')).toBeVisible();
    await expect(page.locator('#breadth-bars-chart')).toBeVisible();

    const tf10 = page.locator('#breadth-tf-btns .pane-btn[data-days="10"]');
    await tf10.click();
    await expect(tf10).toHaveClass(/active/);

    const metricRsp = page.locator('#breadth-metric-btns .pane-btn[data-metric="RSP"]');
    await metricRsp.click();
    await expect(metricRsp).toHaveClass(/active/);

    const bars50 = page.locator('#breadth-bars-ma-btns .pane-btn[data-ma="50"]');
    await bars50.click();
    await expect(bars50).toHaveClass(/active/);

    const compareToggle = page.locator('#breadth-compare-toggle');
    await compareToggle.click();
    await expect(compareToggle).toHaveClass(/active/);

    const compareQqq = page.locator('#breadth-compare-index-btns .pane-btn[data-index="QQQ"]');
    await compareQqq.click();
    await expect(page.locator('#breadth-compare-gauges')).toBeVisible();
  });
});
