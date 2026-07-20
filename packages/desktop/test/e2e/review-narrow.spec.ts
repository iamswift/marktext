import * as fs from 'node:fs'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { launchWithMarkdown, resizeWindow } from './helpers'

// Two hunks so deciding one does not finalize and exit the review.
const FIXTURE = [
  '# Narrow fixture',
  '',
  'The priting industry has a long history.',
  '',
  'A second paragraph with anthr typo in it.',
  ''
].join('\n')
const MODIFIED = FIXTURE.replace('The priting industry', 'The printing industry').replace(
  'anthr typo',
  'another typo'
)

test.describe('review layout below the card threshold', () => {
  let app: ElectronApplication
  let page: Page
  let filePath: string

  test.beforeAll(async() => {
    const launched = await launchWithMarkdown(FIXTURE)
    app = launched.app
    page = launched.page
    filePath = launched.filePath
  })

  test.afterAll(async() => {
    await app.close()
  })

  test('falls back to in-document controls when there is no room for cards', async() => {
    await page.waitForTimeout(1500)
    fs.writeFileSync(filePath, MODIFIED, 'utf-8')
    const reviewButton = page.locator('.editor-notifications .inline-button.labeled', {
      hasText: 'Review'
    })
    await expect(reviewButton).toBeVisible({ timeout: 15000 })
    await reviewButton.click()
    await expect(page.locator('.review-overlay.wide')).toBeVisible({ timeout: 5000 })

    // Well under WIDE_MIN (868) once the window chrome is accounted for.
    await resizeWindow(app, 700, 800)
    await expect(page.locator('.review-overlay.narrow')).toBeVisible({ timeout: 5000 })

    // Asserting counts rather than visibility is the payoff for rendering the
    // two modes with v-if: only one control set exists in the DOM at a time.
    await expect(page.locator('.card-cell')).toHaveCount(0)
    await expect(page.locator('.sug-card')).toHaveCount(0)
    await expect(page.locator('.review-document.two-column')).toHaveCount(0)
    await expect(page.locator('.review-hunk-controls')).not.toHaveCount(0)

    // The pre-card hover flow still decides a hunk.
    const part = page.locator('.review-part.review-merged', { hasText: 'printing' })
    await part.hover()
    await part.locator('.review-hunk-controls .accept').click()
    await expect
      .poll(() => fs.readFileSync(filePath, 'utf-8'), { timeout: 10000 })
      .toContain('The printing industry')
  })

  test('restores the cards when the window grows again', async() => {
    await resizeWindow(app, 1400, 900)
    await expect(page.locator('.review-overlay.wide')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.review-hunk-controls')).toHaveCount(0)
  })
})
