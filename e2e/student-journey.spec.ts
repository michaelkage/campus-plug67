import { expect, test } from '@playwright/test'

const email = process.env.E2E_TEST_EMAIL
const password = process.env.E2E_TEST_PASSWORD

const journeyRoutes = [
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

test.describe('authenticated student journey', () => {
  test.skip(!email || !password, 'Set E2E_TEST_EMAIL and E2E_TEST_PASSWORD GitHub secrets to enable authenticated journey tests.')

  test('sign in, traverse core student surfaces, sign out, and return to auth', async ({ page }) => {
    await page.goto('/auth')
    await page.getByLabel('University email').fill(email!)
    await page.getByLabel('Password').fill(password!)
    await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click()

    await expect(page).toHaveURL(/\/$/)

    for (const route of journeyRoutes) {
      await page.goto(route)
      await expect(page).not.toHaveURL(/\/auth(?:\?|$)/)
      await expect(page.locator('body')).not.toContainText('404')
      await expect(page.locator('body')).not.toContainText('Application error')
    }

    await page.goto('/')
    await page.getByRole('button', { name: /account|profile/i }).click()
    await page.getByRole('button', { name: 'Sign Out', exact: true }).click()
    await expect(page).toHaveURL(/\/auth(?:\?|$)/, { timeout: 15_000 })
    await expect(page.getByLabel('University email')).toBeVisible()

    await page.goto('/marketplace')
    await expect(page).toHaveURL(/\/auth(?:\?|$)/, { timeout: 15_000 })
  })
})
