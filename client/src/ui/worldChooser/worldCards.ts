import type { WorldKind } from '../../world/worldRecord'
import type { ProgressStep } from '../../world/worldProgress'

// ONE CARD PER WORLD, wherever its copies are (2026-10-11). The world list
// asks two places — this browser and the server — and a world kept in both
// is one world, by its uid, not two rows. Pure, so the rule can be checked
// without a page: two lists of copies in, cards out.

export type Where = 'browser' | 'server'

// One copy of a world, whatever place it came from. The two sources answer
// the same questions with different field names; WorldChooser normalises them
// to this before the merge.
export interface WorldCopy {
  where: Where
  uid: string
  name: string
  seed: string
  // Null where the place does not know it (a save from before the field).
  kind: WorldKind | null
  progress: ProgressStep | null
  bytes: number
  // ISO 8601.
  savedAt: string
  generator: string
  // SHA-256 of the archive bytes, lowercase hex; empty when not known.
  contentHash: string
  // Whether the copy is a template (docs/decisions/template-worlds.md):
  // a server world offered to everyone to copy. Never true in the browser —
  // the mark is the server's.
  template: boolean
  // The caller's level on the copy as the server states it (`viewer` …
  // `admin`); empty for a browser copy, which is the browser's own.
  callerLevel: string
}

// Whether the caller holds the copy as its own: a browser copy, or a server
// copy the caller owns or administers. The rest are worlds of others.
export const ownsCopy = (copy: WorldCopy): boolean =>
  copy.where === 'browser' || copy.callerLevel === 'owner' || copy.callerLevel === 'admin'

// A template that is someone else's: offered to copy, not to open — opening
// it would offer saves that the server refuses.
export const foreignTemplate = (copy: WorldCopy | null): boolean => copy !== null && copy.template && !ownsCopy(copy)

// `single`: one place holds the world. `same`: both hold byte-identical
// archives. `diverged`: both hold it and the bytes differ — or one side's
// hash is not known, which is the safe reading: the list never says two
// copies are one version without proof.
export type CardState = 'single' | 'same' | 'diverged'

export interface WorldCard {
  uid: string
  browser: WorldCopy | null
  server: WorldCopy | null
  state: CardState
  // Of two diverged copies, the one saved later; null otherwise, and for two
  // copies saved at the same instant.
  newer: Where | null
  // The copy the card describes: the one there is; of two same copies the
  // browser's; of two diverged copies the newer (the browser's on a tie).
  shown: WorldCopy
  // The shape, from whichever copy knows it.
  kind: WorldKind | null
  // Whether the world is a template — the server copy's mark.
  template: boolean
}

export function mergeWorldCopies(browser: readonly WorldCopy[], server: readonly WorldCopy[]): WorldCard[] {
  const byUid = new Map<string, { browser: WorldCopy | null; server: WorldCopy | null }>()
  for (const copy of browser) byUid.set(copy.uid, { browser: copy, server: null })
  for (const copy of server) {
    const held = byUid.get(copy.uid)
    if (held) held.server = copy
    else byUid.set(copy.uid, { browser: null, server: copy })
  }
  const cards: WorldCard[] = []
  for (const [uid, { browser: b, server: s }] of byUid) {
    if (!b || !s) {
      const only = (b ?? s)!
      cards.push({ uid, browser: b, server: s, state: 'single', newer: null, shown: only, kind: only.kind, template: s?.template ?? false })
      continue
    }
    const same = b.contentHash !== '' && b.contentHash === s.contentHash
    const order = Date.parse(b.savedAt) - Date.parse(s.savedAt)
    const newer: Where | null = same || order === 0 || Number.isNaN(order) ? null : order > 0 ? 'browser' : 'server'
    cards.push({
      uid,
      browser: b,
      server: s,
      state: same ? 'same' : 'diverged',
      newer,
      shown: newer === 'server' ? s : b,
      kind: b.kind ?? s.kind,
      template: s.template,
    })
  }
  // Newest first, by the copy each card shows.
  return cards.sort((x, y) => Date.parse(y.shown.savedAt) - Date.parse(x.shown.savedAt))
}

// The copy a click on the card's Open loads, or null for none: the one copy
// there is; of two same copies the browser's, which is the faster read of
// the same bytes; of two diverged copies none — the user picks one in the
// card's panel. `opens` is the screen's own rule (the incubator opens only
// server worlds with a level). Someone else's template is never opened: its
// card offers a copy instead.
export function cardOpenCopy(card: WorldCard, opens: (where: Where, uid: string) => boolean): WorldCopy | null {
  if (card.state === 'diverged') return null
  for (const copy of [card.browser, card.server]) {
    if (copy && !foreignTemplate(copy) && opens(copy.where, copy.uid)) return copy
  }
  return null
}

// The place filter, with templates as a value of its own beside the two
// places (docs/decisions/template-worlds.md, fork 4): a template is always a
// server world, so a separate toggle would only add a combination — browser
// and templates — that is empty by construction.
export type WhereFilter = 'all' | Where | 'template'
export type ShapeFilter = 'anyShape' | 'flat' | 'sphere'

// Whether a card shows under the two filters. A card whose shape no copy
// knows shows under "both shapes" only: guessing one would file it wrongly.
export function cardMatches(card: WorldCard, where: WhereFilter, shape: ShapeFilter): boolean {
  if (where === 'template' ? !card.template : where !== 'all' && !card[where]) return false
  if (shape === 'anyShape') return true
  return card.kind === (shape === 'sphere' ? 'SphereWorld' : 'FlatWorld')
}
