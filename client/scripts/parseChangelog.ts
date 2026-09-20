// A tiny parser for our own changelog format (see docs/changelog/README.md) —
// no Markdown dependency, since the shape is strict and known:
//   ## YYYY-MM-DD
//   - **kind** Label: text with `key` / **bold** / *italic*
// The file's H1 + intro paragraph (everything before the first `##`) is skipped.

// It lives beside the doc site, its only caller, and not under `ui/` where it
// started: it has no DOM, and `ui/` is for widgets. The in-app changelog it was
// written for was removed on 2026-09-20 with the rest of the old chrome. The
// OTHER half of this format — the inline markup inside an entry's text — is in
// docsite.ts's `inlineHtml`, deliberately left there rather than merged in, so
// the part that needs no HTML stays checkable without one.

export type EntryKind = 'new' | 'changed' | 'dropped' | 'fixed'

export interface ChangelogEntry {
  kind: EntryKind | null // null when a bullet doesn't lead with a **kind**
  text: string // the remaining inline markup (rendered by renderChangelog)
}

export interface ChangelogSection {
  date: string
  entries: ChangelogEntry[]
}

const KINDS = new Set<string>(['new', 'changed', 'dropped', 'fixed'])

export function parseChangelog(md: string): ChangelogSection[] {
  const sections: ChangelogSection[] = []
  let current: ChangelogSection | null = null

  for (const raw of md.split('\n')) {
    const line = raw.trimEnd()

    const dateMatch = /^##\s+(.+)$/.exec(line)
    if (dateMatch) {
      current = { date: dateMatch[1].trim(), entries: [] }
      sections.push(current)
      continue
    }
    if (!current) continue // skip the H1/intro before the first date section

    const bulletMatch = /^-\s+(.*)$/.exec(line)
    if (!bulletMatch) continue

    let text = bulletMatch[1]
    let kind: EntryKind | null = null
    const kindMatch = /^\*\*(\w+)\*\*\s+(.*)$/.exec(text)
    if (kindMatch && KINDS.has(kindMatch[1])) {
      kind = kindMatch[1] as EntryKind
      text = kindMatch[2]
    }
    current.entries.push({ kind, text })
  }

  return sections
}
