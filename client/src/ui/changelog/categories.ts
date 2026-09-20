// Fixed changelog category list. Each pulls the raw Markdown of the matching
// docs/changelog file at build time (Vite ?raw) — the .md stays the source of
// truth. README is intentionally excluded (it's the format doc, not a log).
import generatorMd from '../../../../docs/changelog/generator.md?raw'
import uiMd from '../../../../docs/changelog/ui.md?raw'
import mechanicsMd from '../../../../docs/changelog/mechanics.md?raw'
import conceptsMd from '../../../../docs/changelog/concepts.md?raw'
import platformMd from '../../../../docs/changelog/platform.md?raw'

export interface ChangelogCategory {
  id: string
  label: string
  md: string
}

export const CHANGELOG_CATEGORIES: ChangelogCategory[] = [
  { id: 'generator', label: 'Generator', md: generatorMd },
  { id: 'ui', label: 'UI', md: uiMd },
  { id: 'mechanics', label: 'Mechanics', md: mechanicsMd },
  { id: 'concepts', label: 'Concepts', md: conceptsMd },
  { id: 'platform', label: 'Platform', md: platformMd },
]
