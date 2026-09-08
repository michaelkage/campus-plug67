import { expect, test } from '@playwright/test'

test('app shell loads and unauthenticated users reach sign in', async ({ page }) => {
  await page.goto('/')
  await expect(page).toHaveTitle(/Campus Plug/i)
  await expect(page.getByRole('heading', { name: /CampusPlug/i })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('form').getByRole('button', { name: 'Sign In', exact: true })).toBeVisible()
  await expect(page.getByLabel('University Email')).toBeVisible()
})

test('SPA routes survive a hard navigation', async ({ page }) => {
  await page.goto('/privacy')
  await expect(page).toHaveTitle(/Campus Plug/i)
  await expect(page.locator('body')).not.toContainText('404')
})
