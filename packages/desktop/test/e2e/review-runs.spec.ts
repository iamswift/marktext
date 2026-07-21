import * as fs from 'node:fs'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { launchWithMarkdown } from './helpers'

const FIXTURE = [
  '# Review runs fixture',
  '',
  'An unchanged intro paragraph that stays exactly the same throughout this test.',
  '',
  'The priting industry has a long history and severall experts beleive it will grow for centuries.',
  '',
  '## Rewrite section',
  '',
  'Keep this intro then everything here is completely different wording that will be swapped out for good.',
  ''
].join('\n')

// Three isolated one-word typo fixes, each surrounded by enough unchanged
// words to stay its own edit run (see editRuns.ts: a run only survives an
// equal part with no real word), plus a wholesale rewrite that shares no
// multi-word span with its replacement and so classifies stacked (US-004).
const MODIFIED = FIXTURE.replace('priting', 'printing')
  .replace('severall', 'several')
  .replace('beleive', 'believe')
  .replace(
    'everything here is completely different wording that will be swapped out for good.',
    'a totally fresh sentence appears here instead with brand new phrasing altogether.'
  )

const externallyModify = (filePath: string, content: string): void => {
  fs.writeFileSync(filePath, content, 'utf-8')
}

/**
 * Clicks a decidable run's popover action. wrapDecidableRuns's markup shows
 * the popover only via CSS (:focus-within), so the wrapper must be focused
 * first — clicking it does that even though the click lands on a non-focusable
 * del/span descendant, because the browser walks up to the nearest focusable
 * ancestor (the wrapper itself, via its tabindex).
 */
const clickRunAction = async(
  page: Page,
  matchText: string,
  action: 'keep' | 'undo' | 'edit'
): Promise<void> => {
  const wrapper = page
    .locator('.review-edit:not(.review-edit-settled)', { hasText: matchText })
    .first()
  await wrapper.click()
  await wrapper.locator(`button.review-edit-action.${action}`).click()
}

test.describe('per-change run decisions', () => {
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

  test('mixed keep/undo on typo fixes writes exactly that mix; the stacked rewrite gets no per-change UI', async() => {
    await page.waitForTimeout(1500)
    externallyModify(filePath, MODIFIED)

    const reviewButton = page.locator('.editor-notifications .inline-button.labeled', {
      hasText: 'Review'
    })
    await expect(reviewButton).toBeVisible({ timeout: 15000 })
    await reviewButton.click()
    await expect(page.locator('.review-overlay')).toBeVisible({ timeout: 5000 })

    // All three well-separated typo fixes correlate to their own wrapper.
    const runWrappers = page.locator('.review-edit[data-run-key]')
    await expect(runWrappers).toHaveCount(3)

    const typoHunkId = await runWrappers.first().getAttribute('data-hunk-id')
    if (!typoHunkId) {
      throw new Error('typo hunk id missing from .review-edit wrapper')
    }

    // The stacked rewrite is a different hunk entirely and must carry no
    // per-change affordance at all — the classifier routed it to the
    // whole-hunk Before/After card instead.
    const stackedDeleted = page.locator('.review-part.review-deleted', {
      hasText: 'completely different wording'
    })
    await expect(stackedDeleted).toHaveCount(1)
    const stackedHunkId = await stackedDeleted.getAttribute('data-hunk-id')
    expect(stackedHunkId).not.toBe(typoHunkId)
    await expect(page.locator(`.review-edit[data-hunk-id="${stackedHunkId}"]`)).toHaveCount(0)

    // The card's bulk-fill label starts at the full pending count.
    const typoCardAccept = page.locator(`.sug-card[data-hunk="${typoHunkId}"] .accept`)
    await expect(typoCardAccept).toContainText('Keep all (3)')

    // Keep the "printing" fix: it settles in place with no popover left.
    await clickRunAction(page, 'printing', 'keep')
    await expect(typoCardAccept).toContainText('Keep all (2)')

    const printingSettled = page.locator('.review-edit.review-edit-settled', {
      hasText: 'printing'
    })
    await expect(printingSettled).toHaveCount(1)
    await expect(printingSettled).toHaveAttribute('role', 'button')
    await expect(printingSettled).toHaveAttribute('aria-label', /.+/)
    await expect(printingSettled).toHaveAttribute('data-run-key', /.+/)
    // No tint, no strikethrough marks survive settling — just the winning word.
    await expect(printingSettled.locator('del, .review-word-del, .review-word-add')).toHaveCount(0)
    await expect(printingSettled).toContainText('printing')

    // Keep the "several" fix too: only one run is left pending, so the bulk
    // label drops out (showBulkActions requires >= 2) — the count keeps
    // decrementing rather than sitting stuck at a stale "(N)".
    await clickRunAction(page, 'several', 'keep')
    await expect(typoCardAccept).not.toContainText('Keep all')
    await expect(typoCardAccept).toHaveText(/Keep$/)

    const severalSettled = page.locator('.review-edit.review-edit-settled', {
      hasText: 'several'
    })
    await expect(severalSettled).toHaveCount(1)
    await expect(severalSettled.locator('del, .review-word-del, .review-word-add')).toHaveCount(0)
    // Settling "several" must not disturb its already-settled sibling.
    await expect(printingSettled).toHaveCount(1)

    // Undo the "believe" fix — the last of the three decidable runs, so the
    // hunk becomes fully decided and melts into plain context.
    await clickRunAction(page, 'believe', 'undo')
    await expect(page.locator(`.sug-card[data-hunk="${typoHunkId}"]`)).toHaveCount(0, {
      timeout: 10000
    })

    // The whole point of per-change decisions: one hunk, three runs, two
    // different verdicts, and the file reflects exactly that mix.
    await expect
      .poll(() => fs.readFileSync(filePath, 'utf-8'), { timeout: 10000 })
      .toContain(
        'The printing industry has a long history and several experts beleive it will grow for centuries.'
      )
    const final = fs.readFileSync(filePath, 'utf-8')
    expect(final).not.toContain('priting industry')
    expect(final).not.toContain('severall experts')
    expect(final).not.toContain('experts believe')

    // The stacked rewrite is untouched: still its own undecided Before/After
    // card, never offered a per-change decision.
    await expect(page.locator(`.hunk-card[data-hunk-id="${stackedHunkId}"]`)).toHaveCount(1)
  })
})
