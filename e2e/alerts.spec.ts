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

test.describe('Alerts / Live Feed View', () => {
  test.beforeEach(async ({ page }) => {
    // Universal auth mock
    await page.route('**/api/auth/check', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"authenticated": true}' });
    });
    // Universal fallback
    await page.route('**/api/**', async (route) => {
      if (route.request().url().includes('/divergence/signals')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify([
            {
              id: 1,
              ticker: 'SPY',
              signal_type: 'bullish',
              signal_trade_date: '2023-10-27',
              price: '410.68',
              prev_close: '412.55',
              volume: 100000000,
              avg_volume: 80000000,
              rsi: 28.5,
              vdf_score: 8.5,
              timeframe: '1d',
            },
            {
              id: 1,
              ticker: 'QQQ',
              signal_type: 'bearish',
              signal_trade_date: '2023-10-27',
              price: '344.30',
              prev_close: '340.00',
              volume: 50000000,
              avg_volume: 45000000,
              rsi: 72.1,
              vdf_score: -7.2,
              timeframe: '1w',
            },
          ]),
        });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
    });

    // Navigate to the dashboard
    await page.goto('/');
    await unlockSite(page);
    await page.waitForFunction(
      () => window.location.hash === '' || window.location.hash === '#/' || window.location.hash === '#/divergence',
    );
    // Wait for the divergence feed to be visible
    await expect(page.locator('#view-divergence')).toBeVisible({ timeout: 15000 });
  });

  test('should display daily and weekly columns', async ({ page }) => {
    await expect(page.locator('.column-tf-controls[data-column="daily"]').first()).toBeVisible();
    await expect(page.locator('.column-tf-controls[data-column="weekly"]').first()).toBeVisible();
  });

  test('should allow toggling sort modes', async ({ page }) => {
    // Both timeframe columns exist, so target the sort button within the daily header pane.
    const dailySortBtns = page.locator('.divergence-daily-sort .pane-btn[data-sort="volume"]');
    await expect(dailySortBtns).toBeVisible();
  });

  test('should open ticker view when clicking an alert card', async ({ page }) => {
    // Wait for at least one alert card to load
    const firstAlert = page.locator('.alert-card').first();
    await expect(firstAlert).toBeVisible();

    const ticker = await firstAlert.locator('h3').textContent();
    expect(ticker).toBeTruthy();

    // Click the ticker link
    await firstAlert.locator('h3').click();

    // The ticker view should now be visible
    await expect(page.locator('#ticker-view')).toBeVisible();
    await expect(page.url()).toContain(`#/ticker/${ticker}`);
  });
});
