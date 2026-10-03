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

// What a page is about, from the directory it lives in
// (docs/handbook/<locale>/<kind>s/): a step of the generator, a concept that
// steps share and include, or a map layer. The panel's bookmarks are these.
export type HandbookKind = 'step' | 'concept' | 'overlay'

export interface HandbookPage {
  kind: HandbookKind
  // The page's anchor (front matter), e.g. `generator.step.world`. A
  // layer's page is `overlay.<id>`, its catalog base.
  anchor: string
  title: string
  // Sort order within its area.
  order: number
  // The rendered body, headings with their anchors as ids. A concept a
  // step includes is in it as a card carrying `data-page` with the
  // concept's anchor.
  html: string
  sections: HandbookSection[]
}

// Per locale, the pages that locale has. A page missing in one locale is
// read from English, the catalog's fallback.
export type Handbook = Record<string, HandbookPage[]>
