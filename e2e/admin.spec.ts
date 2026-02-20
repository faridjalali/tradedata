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

test.describe('Admin Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    // Universal auth mock
    await page.route('**/api/auth/check', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"authenticated": true}' });
    });
    // Universal fallback
    await page.route('**/api/**', async (route) => {
      if (route.request().url().includes('/admin/status')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            serverInfo: { version: '1.0.0', uptime: 3600, memoryUsageMB: 50 },
            dbStatus: { primary: { status: 'healthy', activeConnections: 1 } },
            divergenceDbStatus: { status: 'healthy', activeConnections: 1 },
          }),
        });
      } else if (route.request().url().includes('/logs/run-metrics')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ items: [], total: 0, page: 1, totalPages: 1 }),
        });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
    });

    // Navigate to the admin view
    await page.goto('/#/admin');
    await unlockSite(page);
    // Ensure the hash router has time to process
    await page.waitForFunction(() => window.location.hash.includes('admin'));
    await expect(page.locator('#view-admin')).toBeVisible({ timeout: 10000 });
  });

  test('should render system health cards', async ({ page }) => {
    await expect(page.locator('#admin-health-cards')).toBeVisible();
  });

  test('should render operation fetch buttons', async ({ page }) => {
    await expect(page.locator('#divergence-fetch-daily-btn')).toBeVisible();
    await expect(page.locator('#divergence-fetch-weekly-btn')).toBeVisible();
    await expect(page.locator('#divergence-vdf-scan-btn')).toBeVisible();
  });

  test('should render run metrics and history', async ({ page }) => {
    await expect(page.locator('#admin-run-cards')).toBeVisible();
    await expect(page.locator('#admin-history-container')).toBeVisible();
  });
});
