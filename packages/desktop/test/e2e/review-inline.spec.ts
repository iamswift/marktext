import * as fs from 'node:fs'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { launchWithMarkdown, clickCardAction } from './helpers'

const FIXTURE = [
  '# Inline hybrid fixture',
  '',
  'The priting industry has a long history in London.',
  '',
  'Keep this intro then everything here is completely different wording.',
  ''
].join('\n')

// A one-word typo fix (largest run: 2 words -> merged) and a contiguous rewrite
// sharing no words with its replacement (6 struck + 6 replacement -> stacked).
const MODIFIED = FIXTURE.replace('The priting industry', 'The printing industry').replace(
  'everything here is completely different wording.',
  'a totally fresh sentence appears instead.'
)

const externallyModify = (filePath: string, content: string): void => {
  fs.writeFileSync(filePath, content, 'utf-8')
}

test.describe('inline hybrid review rendering', () => {
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

  test('small hunks merge inline, large hunks stay stacked, and the toggle flips one', async() => {
    // >1s after open so the watcher's awaitWriteFinish window has settled.
    await page.waitForTimeout(1500)
    externallyModify(filePath, MODIFIED)

    const reviewButton = page.locator('.editor-notifications .inline-button.labeled', {
      hasText: 'Review'
    })
    await expect(reviewButton).toBeVisible({ timeout: 15000 })
    await reviewButton.click()
    await expect(page.locator('.review-overlay')).toBeVisible({ timeout: 5000 })

    // The typo hunk renders as ONE merged part carrying both marks, and no
    // stacked counterpart survives for it.
    const merged = page.locator('.review-part.review-merged', { hasText: 'printing' })
    await expect(merged).toHaveCount(1)
    await expect(merged.locator('del.review-word-del')).toHaveText(/priting/)
    await expect(merged.locator('.review-word-add')).toHaveText(/printing/)
    await expect(
      page.locator('.review-part.review-deleted', { hasText: 'priting' })
    ).toHaveCount(0)

    // The rewrite keeps the before/after pair.
    const stackedDeleted = page.locator('.review-part.review-deleted', {
      hasText: 'completely different wording'
    })
    await expect(stackedDeleted).toHaveCount(1)
    await expect(
      page.locator('.review-part.review-added', { hasText: 'totally fresh sentence' })
    ).toHaveCount(1)

    // Toggling that hunk flips it to the merged view. Only the unchanged lead-in
    // survives contiguously: jsdiff emits this rewrite as word-by-word
    // alternating runs, so the merged text interleaves both sentences — which is
    // precisely why the classifier stacks a hunk this size by default.
    await clickCardAction(page, 'completely different wording', 'toggle-view')

    const mergedRewrite = page.locator('.review-part.review-merged', {
      hasText: 'Keep this intro'
    })
    await expect(mergedRewrite).toHaveCount(1)
    await expect(mergedRewrite.locator('del.review-word-del').first()).toBeVisible()
    await expect(mergedRewrite.locator('.review-word-add').first()).toBeVisible()
    await expect(
      page.locator('.review-part.review-deleted', { hasText: 'completely different wording' })
    ).toHaveCount(0)

    // Toggling back restores the pair.
    await clickCardAction(page, 'Keep this intro', 'toggle-view')
    await expect(
      page.locator('.review-part.review-deleted', { hasText: 'completely different wording' })
    ).toHaveCount(1)
    await expect(
      page.locator('.review-part.review-added', { hasText: 'totally fresh sentence' })
    ).toHaveCount(1)
  })

  test('accepting a merged hunk resolves it and writes the proposed text', async() => {
    await clickCardAction(page, 'printing', 'accept')

    // The hunk melts back: no merged part left for it, and the marks are gone.
    await expect(page.locator('.review-part.review-merged', { hasText: 'printing' })).toHaveCount(
      0
    )
    await expect.poll(() => fs.readFileSync(filePath, 'utf-8')).toContain('The printing industry')
  })
})
