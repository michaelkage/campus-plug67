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

  test('marketplace discovery and listing form journey works', async ({ page }) => {
    await page.goto('/marketplace')
    await expect(page).toHaveURL(/\/marketplace$/)
    await expect(page.getByRole('heading', { name: 'Marketplace', exact: true })).toBeVisible()

    const search = page.getByPlaceholder('Search listings...')
    await search.fill('__campus_plug_no_match__')
    await expect(page.getByText('No listings found')).toBeVisible()
    await search.fill('')

    await expect(page.getByText(/All Categories|Textbooks/).first()).toBeVisible()
    const firstListing = page.locator('a[href^="/marketplace/"]').first()
    if (await firstListing.count()) {
      await firstListing.click()
      await expect(page).toHaveURL(/\/marketplace\/[^/]+$/)
      await expect(page.locator('h1')).toBeVisible()
      await expect(page.getByText(/PlugPay Escrow/i)).toBeVisible()
      await page.goto('/marketplace')
    }

    await page.getByRole('button', { name: 'List Item', exact: true }).click()
    await expect(page.getByText('List an Item', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Title', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Category', { exact: true })).toBeVisible()
    await expect(page.getByLabel('Price (₦)', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Publish Listing', exact: true })).toBeVisible()
    await page.getByRole('button').filter({ hasText: '×' }).last().click()
  })

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
