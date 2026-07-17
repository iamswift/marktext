import * as fs from 'node:fs'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { launchWithMarkdown } from './helpers'

const FIXTURE = [
  '# Review fixture',
  '',
  'An **unchanged** intro paragraph.',
  '',
  '## Section',
  '',
  '- item one',
  '- item two',
  '',
  'A paragraph that will change slightly over time.',
  '',
  '```js',
  'const answer = 42',
  '```',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  ''
].join('\n')

// The same document after an "external tool" edit: one paragraph reworded,
// one list item added, the code constant changed.
const MODIFIED = FIXTURE.replace(
  'A paragraph that will change slightly over time.',
  'A paragraph that was rewritten by an external tool.'
)
  .replace('- item two', '- item two\n- item three')
  .replace('const answer = 42', 'const answer = 43')

// The external write happens >1s after open so the watcher's awaitWriteFinish
// window (1000ms) has settled and the change is unambiguously external.
const externallyModify = (filePath: string, content: string): void => {
  fs.writeFileSync(filePath, content, 'utf-8')
}

test.describe('inline diff review mode', () => {
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

  test('external change offers Review and entering shows the inline diff', async() => {
    await page.waitForTimeout(1500)
    externallyModify(filePath, MODIFIED)

    // The tab notification (fileChangeAction default: ask) with the Review button.
    const reviewButton = page.locator('.editor-notifications .inline-button.labeled', {
      hasText: 'Review'
    })
    await expect(reviewButton).toBeVisible({ timeout: 15000 })
    await reviewButton.click()

    // Overlay is up, editor is neutralized.
    await expect(page.locator('.review-overlay')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.editor-wrapper.review')).toHaveCount(1)

    // Added and deleted parts render inline, in document order.
    const deleted = page.locator('.review-part.review-deleted')
    const added = page.locator('.review-part.review-added')
    await expect(deleted.first()).toBeVisible()
    await expect(added.first()).toBeVisible()

    // The reworded paragraph appears on both sides with word-level marks.
    await expect(
      page.locator('.review-deleted', { hasText: 'change slightly over time' }).first()
    ).toBeVisible()
    await expect(
      page.locator('.review-added', { hasText: 'rewritten by an external tool' }).first()
    ).toBeVisible()
    await expect(page.locator('.review-word-del').first()).toBeVisible()
    await expect(page.locator('.review-word-add').first()).toBeVisible()

    // Unchanged rich content still renders as rich content (heading + table).
    await expect(page.locator('.review-overlay h1')).toHaveText('Review fixture')
    await expect(page.locator('.review-overlay table').first()).toBeVisible()

    // The changed code block stays inside a review region as a real code block.
    await expect(
      page.locator('.review-region pre code', { hasText: 'answer = 43' }).first()
    ).toBeVisible()
  })

  test('review mode is read-only against direct typing', async() => {
    const before = await page.locator('.review-overlay').innerText()
    await page.keyboard.type('SHOULD NOT APPEAR')
    await page.waitForTimeout(300)
    const after = await page.locator('.review-overlay').innerText()
    expect(after).toBe(before)
    // The underlying file must not have been touched by typing either.
    expect(fs.readFileSync(filePath, 'utf-8')).toBe(MODIFIED)
  })

  test('editing a hunk: cancel leaves it undecided, confirm writes the edited text', async() => {
    // Cancel first: type into the paragraph hunk's editor, discard it, and
    // confirm nothing was written and the hunk is still undecided (its plain
    // deleted/added parts are back, not the editor).
    const paragraphPart = page.locator('.review-part.review-deleted', {
      hasText: 'change slightly over time'
    })
    await paragraphPart.hover()
    await paragraphPart.locator('.review-hunk-controls .edit').click()

    const paragraphEditor = page.locator('.review-hunk-editor')
    await expect(paragraphEditor.locator('textarea')).toHaveValue(
      'A paragraph that was rewritten by an external tool.'
    )
    await paragraphEditor.locator('textarea').fill('DISCARDED EDIT')
    await paragraphEditor.locator('.cancel').click()

    await expect(page.locator('.review-hunk-editor')).toHaveCount(0)
    await expect(
      page.locator('.review-part.review-deleted', { hasText: 'change slightly over time' })
    ).toBeVisible()
    expect(fs.readFileSync(filePath, 'utf-8')).not.toContain('DISCARDED EDIT')

    // Confirm: edit the isolated list hunk (its own region) and save it —
    // the edited text, not the external tool's original proposal, lands on
    // disk, and the hunk melts back to plain content (it has no sibling
    // hunk in its region, so the region itself also disappears).
    const listRegionsBefore = await page.locator('.review-region').count()
    const listPart = page.locator('.review-part.review-added', { hasText: 'item three' })
    await listPart.hover()
    await listPart.locator('.review-hunk-controls .edit').click()

    const listEditor = page.locator('.review-hunk-editor')
    await expect(listEditor.locator('textarea')).toHaveValue('- item three')
    await listEditor.locator('textarea').fill('- item three (edited)')
    await listEditor.locator('.confirm').click()

    await expect
      .poll(() => fs.readFileSync(filePath, 'utf-8'), { timeout: 10000 })
      .toContain('item three (edited)')
    await expect(page.locator('.review-hunk-editor')).toHaveCount(0)
    await expect(page.locator('.review-region')).toHaveCount(listRegionsBefore - 1)
  })

  test('per-hunk decisions write the file and the last one exits review', async() => {
    // Hunk-to-region grouping depends on how jsdiff aligns blank lines, and
    // the previous test already decided (and melted away) the list hunk's
    // own region, so assert structure dynamically rather than a hardcoded
    // count.
    const initialRegions = await page.locator('.review-region').count()
    expect(initialRegions).toBeGreaterThanOrEqual(1)

    // Reject the code change: disk loses `43`, keeps the still-undecided
    // paragraph rewrite (FR-10 — rejecting is what removes a change).
    // The paragraph hunk and the code hunk share one region (only a blank
    // line + fence-open line separate them, a non-splittable boundary), so
    // scope to the code hunk's own deleted part rather than the region.
    const codePart = page.locator('.review-part.review-deleted', { hasText: 'answer = 42' })
    await codePart.hover()
    await codePart.locator('.review-hunk-controls .reject').click()

    await expect
      .poll(() => fs.readFileSync(filePath, 'utf-8'), { timeout: 10000 })
      .toContain('const answer = 42')
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('rewritten by an external tool')

    // The decided hunk's own deleted/added parts melt back into plain
    // content. The region count itself may not drop yet: this fixture's
    // paragraph hunk and code hunk share one region (only a blank line +
    // fence between them, a non-splittable boundary), so the region persists
    // until the still-undecided paragraph hunk is also resolved.
    await expect(
      page.locator('.review-part.review-deleted', { hasText: 'answer = 42' })
    ).toHaveCount(0)
    await expect(
      page.locator('.review-part.review-added', { hasText: 'answer = 43' })
    ).toHaveCount(0)
    await expect(page.locator('.review-region')).toHaveCount(initialRegions)

    // Accept every remaining hunk; the last decision finalizes the review.
    for (let guard = 0; guard < 6; guard++) {
      if ((await page.locator('.review-region').count()) === 0) {
        break
      }
      const region = page.locator('.review-region').first()
      await region.hover()
      await region.locator('.review-hunk-controls .accept').first().click()
      await page.waitForTimeout(300)
    }

    await expect(page.locator('.review-overlay')).toHaveCount(0, { timeout: 10000 })
    await expect(page.locator('.editor-wrapper.review')).toHaveCount(0)

    const final = fs.readFileSync(filePath, 'utf-8')
    expect(final).toContain('const answer = 42')
    expect(final).toContain('rewritten by an external tool')
    expect(final).toContain('- item three')
  })
})
