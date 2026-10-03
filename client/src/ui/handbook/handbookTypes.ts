// The handbook as the client receives it: docs/handbook/ rendered at build
// time (scripts/handbook.ts, served as `virtual:handbook` by vite.config.ts).
// The shape is here, on the client's side, because the client is what reads
// it; the build script imports it from here.

export interface HandbookSection {
  // The heading's anchor. For a concept, its catalog key (`{#…}` in the
  // Markdown, docs/handbook/README.md): the same string the help card's
  // `data-help` carries, so a control finds its section without a table.
  anchor: string
  title: string
}

export interface HandbookPage {
  // The page's anchor (front matter), e.g. `generator.step.world`.
  anchor: string
  title: string
  // Sort order within its area.
  order: number
  // The rendered body, headings with their anchors as ids.
  html: string
  sections: HandbookSection[]
}

// Per locale, the pages that locale has. A page missing in one locale is
// read from English, the catalog's fallback.
export type Handbook = Record<string, HandbookPage[]>
