import { expect, test } from '@playwright/test'

const protectedRoutes = [
  '/',
  '/marketplace',
  '/study-pools',
  '/lost-found',
  '/profile',
  '/notifications',
  '/safe-swap',
  '/wallet',
  '/campus-hub',
  '/chat',
]

test('public auth shell loads', async ({ page }) => {
  await page.goto('/auth')
  await expect(page).toHaveTitle(/Campus Plug/i)
  await expect(page.getByRole('heading', { name: /Campus Plug/i })).toBeVisible({ timeout: 15_000 })
  await expect(page.locator('form').getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()
  await expect(page.getByLabel('University email')).toBeVisible()
})

test('protected app routes redirect unauthenticated users to auth', async ({ page }) => {
  for (const route of protectedRoutes) {
    await page.goto(route)
    await expect(page).toHaveURL(/\/auth(?:\?|$)/, { timeout: 15_000 })
    await expect(page.getByLabel('University email')).toBeVisible()
  }
})

test('public legal routes survive a hard navigation', async ({ page }) => {
  for (const route of ['/privacy', '/terms']) {
    await page.goto(route)
    await expect(page).toHaveTitle(/Campus Plug/i)
    await expect(page.locator('body')).not.toContainText('404')
  }
})
