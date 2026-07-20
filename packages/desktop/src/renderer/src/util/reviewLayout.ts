/**
 * Width thresholds for the review overlay's two-column (margin card) layout.
 *
 * Keyed to a prose floor rather than --editorAreaWidth: the document column is
 * `minmax(0, …)` and is allowed to shrink below the editor width before the
 * cards are worth dropping. Below WIDE_MIN there is no room for a readable
 * measure alongside a card, so the overlay falls back to single column with
 * the floating hunk controls.
 *
 * Exported so e2e drives the same numbers instead of hardcoding its own.
 */
const DOC_MIN = 520
const CARD_COL = 280
const CARD_GAP = 28
const DOC_PADDING = 40

export const WIDE_MIN = DOC_MIN + CARD_GAP + CARD_COL + DOC_PADDING

/** Kept out of the flip so a drag that lands near the threshold cannot thrash. */
export const WIDE_HYSTERESIS = 40

/** Whether the overlay should show margin cards at this content-box width. */
export const shouldGoWide = (width: number, currentlyWide: boolean): boolean =>
  currentlyWide ? width >= WIDE_MIN : width >= WIDE_MIN + WIDE_HYSTERESIS
