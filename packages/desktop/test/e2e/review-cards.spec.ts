import * as fs from 'node:fs'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { launchWithMarkdown, clickCardAction } from './helpers'

// Two prose hunks plus a code hunk that shares a region with the paragraph
// above it (only a blank line and the fence-open line separate them, which is
// not a splittable boundary).
const FIXTURE = [
  '# Cards fixture',
  '',
  'The priting industry has a long history in London.',
  '',
  'Keep this intro then everything here is completely different wording.',
  '',
  '```js',
  'const answer = 42',
  '```',
  ''
].join('\n')

const MODIFIED = FIXTURE.replace('The priting industry', 'The printing industry')
  .replace(
    'everything here is completely different wording.',
    'a totally fresh sentence appears instead.'
  )
  .replace('const answer = 42', 'const answer = 43')

const enterReview = async(page: Page, filePath: string): Promise<void> => {
  await page.waitForTimeout(1500)
  fs.writeFileSync(filePath, MODIFIED, 'utf-8')
  const reviewButton = page.locator('.editor-notifications .inline-button.labeled', {
    hasText: 'Review'
  })
  await expect(reviewButton).toBeVisible({ timeout: 15000 })
  await reviewButton.click()
  await expect(page.locator('.review-overlay.wide')).toBeVisible({ timeout: 5000 })
}

test.describe('review margin cards', () => {
  let app: ElectronApplication
  let page: Page
  let filePath: string

  test.beforeAll(async() => {
    const launched = await launchWithMarkdown(FIXTURE)
    app = launched.app
    page = launched.page
    filePath = launched.filePath
    await enterReview(page, filePath)
  })

  test.afterAll(async() => {
    await app.close()
  })

  test('pairs every document cell with a card cell', async() => {
    await expect(page.locator('.review-document.two-column')).toHaveCount(1)
    const docCells = await page.locator('.doc-cell').count()
    const cardCells = await page.locator('.card-cell').count()
    expect(cardCells).toBe(docCells)
  })

  test('the document column holds no buttons', async() => {
    // The single strongest statement of the variant-6 thesis: every action for
    // a change lives on its card, never over the prose.
    await expect(page.locator('.doc-cell button')).toHaveCount(0)
    await expect(page.locator('.review-hunk-controls')).toHaveCount(0)
  })

  test('each card names its change and summarizes the edit', async() => {
    // Scoped by the delta text: the code hunk is also a one-token swap, so its
    // kind line reads the same. describeHunk only sees the hunk's own lines,
    // and a fenced hunk's delimiters live in the region's fence context rather
    // than in those lines, so it cannot tell code from prose here.
    const typoCard = page.locator('.sug-card', { hasText: 'priting' })
    await expect(typoCard).toHaveCount(1)
    await expect(typoCard.locator('.kind')).toHaveText('1 word fixed')
    await expect(typoCard.locator('.delta .old')).toHaveText('priting')
    await expect(typoCard.locator('.delta .new')).toHaveText('printing')
  })

  test('a region holding several hunks gets one card per hunk', async() => {
    // The rewritten paragraph and the code change share a region, so their
    // cards stack in a single card cell and carry ordinals.
    const shared = page.locator('.card-cell').filter({ has: page.locator('.sug-card:nth-child(2)') })
    await expect(shared.first()).toBeVisible()

    const hunkIds = await page
      .locator('.card-cell .sug-card')
      .evaluateAll((cards) => cards.map((card) => card.getAttribute('data-hunk')))
    expect(new Set(hunkIds).size).toBe(hunkIds.length)
  })

  test('clicking a card spotlights its text and clicking again clears it', async() => {
    // Click the kind line, not the card box: a click on the box lands on its
    // centre, which for a short card can be a button.
    const card = page.locator('.sug-card', { hasText: 'priting' })
    await card.locator('.kind').click()
    await expect(card).toHaveClass(/active/)
    await expect(page.locator('.spot')).toHaveCount(1)

    await card.locator('.kind').click()
    await expect(card).not.toHaveClass(/active/)
    await expect(page.locator('.spot')).toHaveCount(0)
  })

  test('spotlighting never scrolls the document', async() => {
    // The card is already beside its paragraph; scrolling would displace what
    // the user just clicked.
    const card = page.locator('.sug-card').last()
    const scrollBefore = await page.locator('.review-overlay').evaluate((el) => el.scrollTop)
    await card.locator('.kind').click()
    await page.waitForTimeout(400)
    const scrollAfter = await page.locator('.review-overlay').evaluate((el) => el.scrollTop)
    expect(scrollAfter).toBe(scrollBefore)
    await card.locator('.kind').click()
  })

  test('the view toggle flips a hunk and relabels itself', async() => {
    const merged = page.locator('.review-part.review-merged', { hasText: 'printing' })
    await expect(merged).toHaveCount(1)

    await clickCardAction(page, 'printing', 'toggle-view')
    const stacked = page.locator('.hunk-card', { hasText: 'priting' })
    await expect(stacked).toHaveCount(1)
    await expect(stacked.locator('.side.before .cap')).toHaveText(/Before/)
    await expect(stacked.locator('.side.after .cap')).toHaveText(/After/)

    await clickCardAction(page, 'printing', 'toggle-view')
    await expect(page.locator('.review-part.review-merged', { hasText: 'printing' })).toHaveCount(1)
  })

  test('the progress track advances as changes are decided', async() => {
    const widthOf = async(): Promise<number> =>
      page.locator('.review-bar .track > i').evaluate((el) => (el as HTMLElement).offsetWidth)

    await expect(page.locator('.review-bar .review-count')).toHaveText('0 of 3 changes reviewed')
    const before = await widthOf()

    await clickCardAction(page, 'printing', 'accept')
    await expect(page.locator('.review-bar .review-count')).toHaveText('1 of 3 changes reviewed')
    expect(await widthOf()).toBeGreaterThan(before)
  })

  test('undo last change puts a decided hunk back up for review', async() => {
    const undoLast = page.locator('.review-bar .undo-last')
    await expect(undoLast).toBeVisible()
    await undoLast.click()

    await expect(page.locator('.review-bar .review-count')).toHaveText('0 of 3 changes reviewed')
    await expect(page.locator('.sug-card', { hasText: 'priting' })).toHaveCount(1)

    // The file keeps the proposed text: an undecided hunk is written as
    // proposed, the same as an accepted one, so undoing an accept restores the
    // change to review without rewriting the document. Undoing a reject is
    // what moves text on disk.
    expect(fs.readFileSync(filePath, 'utf-8')).toContain('The printing industry')
  })

  test('undoing a reject restores the proposed text on disk', async() => {
    await clickCardAction(page, 'printing', 'reject')
    await expect
      .poll(() => fs.readFileSync(filePath, 'utf-8'), { timeout: 10000 })
      .toContain('The priting industry')

    await page.locator('.review-bar .undo-last').click()
    await expect
      .poll(() => fs.readFileSync(filePath, 'utf-8'), { timeout: 10000 })
      .toContain('The printing industry')
  })
})
