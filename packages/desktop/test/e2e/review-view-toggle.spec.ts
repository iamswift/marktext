import * as fs from 'node:fs'
import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { launchWithMarkdown, clickCardAction } from './helpers'

// Three hunks, each its own region, each flanked by unchanged anchor
// paragraphs so the line-level diff (diffArrays) anchors correctly instead
// of merging adjacent changes into one hunk:
//   1. a paragraph the modification deletes entirely (pure delete hunk) —
//      anchor "gribblewocket".
//   2. a prose paragraph with a single-word typo the modification fixes
//      (replace hunk that merges inline) — anchor "kestrel".
//   3. a fenced js code block whose one line changes (replace hunk that can
//      never merge — a <pre> is never a single paragraph) — anchor
//      "gearRatio".
const FIXTURE = [
  '# Toggle fixture',
  '',
  'Anchor alpha stays exactly the same throughout the whole review.',
  '',
  'The gribblewocket paragraph will disappear when the review lands.',
  '',
  'Anchor beta stays exactly the same throughout the whole review.',
  '',
  'The kestrel practiced diligence while circling the quiet valey.',
  '',
  'Anchor gamma stays exactly the same throughout the whole review.',
  '',
  '```js',
  'const gearRatio = 12',
  '```',
  ''
].join('\n')

const MODIFIED = FIXTURE.replace(
  'The gribblewocket paragraph will disappear when the review lands.\n\n',
  ''
)
  .replace('valey', 'valley')
  .replace('const gearRatio = 12', 'const gearRatio = 240719')

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

// Cards display only the changed words, not the surrounding paragraph, so a
// card can't be located by prose that only appears in the document (e.g.
// 'kestrel', 'gearRatio' never appear inside their own card). Resolve the
// card via the doc-side hunk id instead, mirroring `clickCardAction` in
// ./helpers.ts.
const cardFor = async(page: Page, docText: string) => {
  const part = page.locator('.doc-cell [data-hunk-id]', { hasText: docText }).first()
  const hunkId = await part.getAttribute('data-hunk-id')
  return page.locator(`.sug-card[data-hunk="${hunkId}"]`)
}

test.describe('review view toggle', () => {
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

  test('a pure deletion renders flat by default', async() => {
    // The fenced-code replace hunk cannot render merged (a <pre> is never a
    // single paragraph), so it is the one that defaults to a stacked
    // .hunk-card — the deletion defaults flat.
    await expect(page.locator('.hunk-card')).toHaveCount(1)
    await expect(page.locator('.hunk-card', { hasText: 'gribblewocket' })).toHaveCount(0)
    await expect(page.locator('.review-part.review-deleted', { hasText: 'gribblewocket' })).toHaveCount(1)
  })

  test('toggling a deletion produces a Before/After card and back', async() => {
    const deletionCard = await cardFor(page, 'gribblewocket')
    await expect(deletionCard.locator('.toggle-view')).toHaveText(/Before\/After/)

    await clickCardAction(page, 'gribblewocket', 'toggle-view')

    const stacked = page.locator('.hunk-card', { hasText: 'gribblewocket' })
    await expect(stacked).toHaveCount(1)
    await expect(stacked.locator('.side.after')).toContainText('nothing — this text would be removed')
    await expect(deletionCard.locator('.toggle-view')).toHaveText(/In place/)

    await clickCardAction(page, 'gribblewocket', 'toggle-view')

    await expect(page.locator('.hunk-card', { hasText: 'gribblewocket' })).toHaveCount(0)
    await expect(page.locator('.review-part.review-deleted', { hasText: 'gribblewocket' })).toHaveCount(1)
  })

  test('a non-mergeable hunk offers no view toggle', async() => {
    const codeCard = await cardFor(page, 'gearRatio')
    const deletionCard = await cardFor(page, 'gribblewocket')
    const typoCard = await cardFor(page, 'kestrel')

    await expect(codeCard.locator('.sug-actions.view-row')).toHaveCount(0)
    await expect(deletionCard.locator('.sug-actions.view-row')).toHaveCount(1)
    await expect(typoCard.locator('.sug-actions.view-row')).toHaveCount(1)
  })

  test('a mergeable replace still toggles', async() => {
    const merged = page.locator('.review-part.review-merged', { hasText: 'kestrel' })
    await expect(merged).toHaveCount(1)

    await clickCardAction(page, 'kestrel', 'toggle-view')
    const stacked = page.locator('.hunk-card', { hasText: 'valey' })
    await expect(stacked).toHaveCount(1)

    await clickCardAction(page, 'kestrel', 'toggle-view')
    await expect(page.locator('.review-part.review-merged', { hasText: 'kestrel' })).toHaveCount(1)
  })
})
