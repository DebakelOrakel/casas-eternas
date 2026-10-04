// THE HANDBOOK'S BUILD STEP: docs/handbook/<locale>/**/*.md to the data the
// client shows (src/ui/handbook/handbookTypes.ts). Run at build time by the
// `virtual:handbook` plugin in vite.config.ts, so the client carries the
// handbook and needs no server for it.
//
// A page's kind is its directory: `steps/`, `concepts/`, `overlays/`.
// The Markdown is plain GitHub Markdown with two additions
// (docs/handbook/README.md):
// - a heading may end in `{#anchor}`, which becomes its id;
// - a paragraph that is only `{{concept <file>}}` includes that concept
//   page as a card. A concept is written once and stands both on its own
//   page and in every step that needs it.
// Front matter is the flat `key: value` form the rest of docs/ uses.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import type { Handbook, HandbookDoc, HandbookKind, HandbookPage, HandbookSection } from '../src/ui/handbook/handbookTypes'
import { frontMatter, frontMatterList } from './frontMatter'

const KIND_DIRS: Record<string, HandbookKind> = { steps: 'step', concepts: 'concept', overlays: 'overlay' }

// Every Markdown file directly in a directory, sorted.
function markdownIn(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.md')).sort().map((name) => join(dir, name))
  } catch {
    return []
  }
}

type Node = { type: string; value?: string; depth?: number; children?: Node[]; data?: { hProperties?: Record<string, unknown> } }

const textOf = (node: Node): string => (node.type === 'text' || node.type === 'inlineCode' ? String(node.value) : (node.children ?? []).map(textOf).join(''))

// Moves a trailing `{#anchor}` off every heading into its id, and lists
// the headings that have one.
function headingAnchors(into: HandbookSection[]) {
  const walk = (node: Node): void => {
    for (const child of node.children ?? []) walk(child)
    if (node.type !== 'heading') return
    const last = node.children?.[node.children.length - 1]
    if (!last || last.type !== 'text') return
    const match = /\s*\{#([^}\s]+)\}\s*$/.exec(String(last.value))
    if (!match) return
    last.value = String(last.value).slice(0, match.index)
    node.data = { ...(node.data ?? {}), hProperties: { id: match[1] } }
    into.push({ anchor: match[1], title: textOf(node).trim() })
  }
  return (tree: Node) => walk(tree)
}

const escapeHtml = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Replaces each `{{concept <file>}}` paragraph with the concept as a card.
// The card's heading is the way to the concept's own page (`data-page`).
// `uses` collects the anchors of the concepts included.
function conceptIncludes(concepts: Map<string, HandbookPage>, source: string, uses: string[]) {
  const walk = (node: Node): void => {
    const children = node.children ?? []
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      const match = child.type === 'paragraph' ? /^\{\{concept\s+([\w-]+)\}\}$/.exec(textOf(child).trim()) : null
      if (!match) {
        walk(child)
        continue
      }
      const concept = concepts.get(match[1])
      if (!concept) throw new Error(`handbook: ${source} includes concept ${match[1]}, which does not exist`)
      uses.push(concept.anchor)
      const anchor = escapeHtml(concept.anchor)
      children[i] = {
        type: 'html',
        value: `<section class="handbook__card handbook__card--concept" data-page="${anchor}"><h3><button type="button" class="handbook__link" data-page="${anchor}">${escapeHtml(concept.title)}</button></h3>${concept.html}</section>`,
      }
    }
  }
  return (tree: Node) => walk(tree)
}

export function renderHandbookPage(text: string, source: string, kind: HandbookKind, concepts: Map<string, HandbookPage> = new Map()): HandbookPage {
  const { meta, body } = frontMatter(text)
  if (!meta.anchor) throw new Error(`handbook: ${source} has no anchor in its front matter`)
  const sections: HandbookSection[] = []
  const uses: string[] = []
  const html = String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(() => headingAnchors(sections))
      .use(() => conceptIncludes(concepts, source, uses))
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeStringify, { allowDangerousHtml: true })
      .processSync(body),
  )
  return { kind, anchor: meta.anchor, title: meta.title ?? meta.anchor, order: Number(meta.order ?? 99), html, sections, ...(uses.length ? { uses } : {}) }
}

// One locale's pages. Concepts first, so the steps can include them; a
// concept this locale lacks is included from English, as a missing page is
// read from English.
function buildLocale(dir: string, locale: string, english: Map<string, HandbookPage>): { pages: HandbookPage[]; concepts: Map<string, HandbookPage> } {
  const concepts = new Map(english)
  const pages: HandbookPage[] = []
  for (const path of markdownIn(join(dir, locale, 'concepts'))) {
    const page = renderHandbookPage(readFileSync(path, 'utf8'), relative(dir, path), 'concept')
    concepts.set(basename(path, '.md'), page)
    pages.push(page)
  }
  for (const [sub, kind] of Object.entries(KIND_DIRS)) {
    if (kind === 'concept') continue
    for (const path of markdownIn(join(dir, locale, sub))) pages.push(renderHandbookPage(readFileSync(path, 'utf8'), relative(dir, path), kind, concepts))
  }
  return { pages, concepts }
}

// THE DOCUMENTS BEHIND THE CONCEPTS: every design and decision doc beside
// the handbook (docs/decisions/, docs/design/) that names concepts in its
// front matter (docs/README.md), with its titles and summaries per language.
interface ConceptDoc {
  id: string
  route: string
  title: Record<string, string>
  summary: Record<string, string>
  concepts: string[]
}

function conceptDocs(docsDir: string): ConceptDoc[] {
  const out: ConceptDoc[] = []
  for (const genre of ['decisions', 'design']) {
    for (const path of markdownIn(join(docsDir, genre))) {
      if (basename(path) === 'README.md') continue
      const { meta } = frontMatter(readFileSync(path, 'utf8'))
      const concepts = frontMatterList(meta.concepts)
      if (!concepts.length) continue
      out.push({
        id: meta.id,
        route: `${genre}/${basename(path, '.md')}.html`,
        title: { en: meta['title.en'], de: meta['title.de'] },
        summary: { en: meta['summary.en'], de: meta['summary.de'] },
        concepts,
      })
    }
  }
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

// The whole handbook: one entry per locale directory. Fails on a page's
// anchor or a catalog-key anchor (one with a dot) used twice in one locale:
// those are the handbook's addresses. A plain section id (`does`) is local
// to its page and may repeat.
export function buildHandbook(dir: string): Handbook {
  const handbook: Handbook = {}
  let locales: string[]
  try {
    locales = readdirSync(dir).filter((name) => statSync(join(dir, name)).isDirectory())
  } catch {
    return handbook
  }
  // English first: the others include its concepts where they have none.
  locales.sort((a, b) => (a === 'en' ? -1 : b === 'en' ? 1 : a.localeCompare(b)))
  let english = new Map<string, HandbookPage>()
  const docs = conceptDocs(join(dir, '..'))
  for (const locale of locales) {
    const { pages, concepts } = buildLocale(dir, locale, english)
    if (locale === 'en') {
      english = concepts
      // A document naming a concept the handbook does not have is a link
      // into nothing: refused, as a concept included twice is.
      const known = new Set([...concepts.values()].map((page) => page.anchor))
      for (const doc of docs) {
        for (const anchor of doc.concepts) if (!known.has(anchor)) throw new Error(`handbook: ${doc.id} names concept ${anchor}, which the handbook does not have`)
      }
    }
    for (const page of pages) {
      if (page.kind !== 'concept') continue
      const background: HandbookDoc[] = docs.filter((doc) => doc.concepts.includes(page.anchor)).map((doc) => ({
        id: doc.id,
        title: doc.title[locale] ?? doc.title.en,
        summary: doc.summary[locale] ?? doc.summary.en,
        route: doc.route,
      }))
      if (background.length) page.background = background
    }
    const seen = new Set<string>()
    for (const page of pages) {
      for (const anchor of [page.anchor, ...page.sections.map((section) => section.anchor).filter((anchor) => anchor.includes('.'))]) {
        if (seen.has(anchor)) throw new Error(`handbook: anchor ${anchor} used twice in ${locale}/`)
        seen.add(anchor)
      }
    }
    handbook[locale] = pages.sort((a, b) => a.order - b.order)
  }
  return handbook
}
