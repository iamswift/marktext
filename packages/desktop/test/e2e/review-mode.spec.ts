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
})
