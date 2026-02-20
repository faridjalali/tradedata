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

test.describe('Chart View', () => {
  test.beforeEach(async ({ page }) => {
    // Universal auth mock
    await page.route('**/api/auth/check', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"authenticated": true}' });
    });
    // Universal fallback
    await page.route('**/api/**', async (route) => {
      const url = route.request().url();
      if (url.includes('/chart/data')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ticker: 'SPY',
            interval: '1day',
            bars: [
              {
                time: new Date().getTime() / 1000 - 86400 * 2,
                open: 100,
                high: 105,
                low: 95,
                close: 102,
                volume: 10000,
              },
              { time: new Date().getTime() / 1000 - 86400, open: 102, high: 110, low: 100, close: 108, volume: 15000 },
              { time: new Date().getTime() / 1000, open: 108, high: 112, low: 105, close: 110, volume: 12000 },
            ],
            hasVdfData: true,
            tickerFound: true,
          }),
        });
      } else if (url.includes('/chart/ticker-info')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ symbol: 'SPY', companyName: 'Mock Company', website: 'https://example.com' }),
        });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      }
    });

    // Navigate directly to a ticker via hash routing
    await page.goto('/#/ticker/SPY');
    await unlockSite(page);
    await page.waitForFunction(() => window.location.hash.includes('ticker/SPY'));
    // Wait for the ticker view to mount, increasing timeout to allow data fetching
    await expect(page.locator('#ticker-view')).toBeVisible({ timeout: 15000 });
  });

  test('should render the multi-pane chart containers', async ({ page }) => {
    // Check for the presence of the chart containers
    await expect(page.locator('#price-chart-container')).toBeVisible();
    await expect(page.locator('#rsi-chart-container')).toBeVisible();
    await expect(page.locator('#vd-rsi-chart-container')).toBeVisible();
    await expect(page.locator('#vd-chart-container')).toBeVisible();
  });

  test('should allow switching chart intervals', async ({ page }) => {
    // Click the 4hour interval button
    await page.locator('.pane-btn[data-interval="4hour"]').click();

    // Ensure the button becomes active
    await expect(page.locator('.pane-btn[data-interval="4hour"]')).toHaveClass(/active/);
  });

  test('should display VDF analysis panel button if data is present', async ({ page }) => {
    // Only check if it exists in the DOM, it might be hidden depending on data
    const refreshBtn = page.locator('#vdf-analysis-panel');
    await expect(refreshBtn).toBeAttached();
  });
});
