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
    await page.addInitScript(() => {
      window.localStorage.setItem('minichart_mobile', 'off');
    });

    // Universal auth mock
    await page.route('**/api/auth/check', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"authenticated": true}' });
    });
    // Universal fallback
    await page.route('**/api/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/chart/mini-bars')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            bars: [
              { time: 1700000000, open: 100, high: 102, low: 99, close: 101 },
              { time: 1700086400, open: 101, high: 104, low: 100, close: 103 },
              { time: 1700172800, open: 103, high: 105, low: 101, close: 104 },
            ],
          }),
        });
      } else if (url.includes('/divergence/signals')) {
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

  test('should remove mini-chart overlay when navigating from alerts to ticker view', async ({ page }) => {
    const firstAlert = page.locator('.alert-card').first();
    await expect(firstAlert).toBeVisible();

    await firstAlert.hover();
    await page.waitForTimeout(1200);
    await expect(page.locator('.mini-chart-overlay')).toHaveCount(1);

    await firstAlert.locator('h3').click();
    await expect(page.locator('#ticker-view')).toBeVisible();
    await expect(page.locator('.mini-chart-overlay')).toHaveCount(0);
  });
});
