// THE HANDBOOK'S BUILD STEP: docs/handbook/<locale>/**/*.md to the data the
// client shows (src/ui/handbook/handbookTypes.ts). Run at build time by the
// `virtual:handbook` plugin in vite.config.ts, so the client carries the
// handbook and needs no server for it.
//
// The Markdown is plain GitHub Markdown with one addition: a heading may end
// in `{#anchor}`, which becomes its id. Concepts use their catalog key there
// (docs/handbook/README.md), which is what lets a help card find its section.
// Front matter is the flat `key: value` form the rest of docs/ uses.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import type { Handbook, HandbookPage, HandbookSection } from '../src/ui/handbook/handbookTypes'

// Every Markdown file under a directory, depth first.
export function handbookFiles(dir: string): string[] {
  const out: string[] = []
  let names: string[]
  try {
    names = readdirSync(dir).sort()
  } catch {
    return out
  }
  for (const name of names) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...handbookFiles(path))
    else if (name.endsWith('.md')) out.push(path)
  }
  return out
}

function frontMatter(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text)
  if (!match) return { meta: {}, body: text }
  const meta: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const at = line.indexOf(':')
    if (at > 0) meta[line.slice(0, at).trim()] = line.slice(at + 1).trim()
  }
  return { meta, body: text.slice(match[0].length) }
}

type Node = { type: string; value?: string; depth?: number; children?: Node[]; data?: { hProperties?: Record<string, unknown> } }

// Moves a trailing `{#anchor}` off every heading into its id, and lists
// the headings that have one.
function headingAnchors(into: HandbookSection[]) {
  const textOf = (node: Node): string => (node.type === 'text' || node.type === 'inlineCode' ? String(node.value) : (node.children ?? []).map(textOf).join(''))
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

export function renderHandbookPage(text: string, source: string): HandbookPage {
  const { meta, body } = frontMatter(text)
  if (!meta.anchor) throw new Error(`handbook: ${source} has no anchor in its front matter`)
  const sections: HandbookSection[] = []
  const html = String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(() => headingAnchors(sections))
      .use(remarkRehype)
      .use(rehypeStringify)
      .processSync(body),
  )
  return { anchor: meta.anchor, title: meta.title ?? meta.anchor, order: Number(meta.order ?? 99), html, sections }
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
  for (const locale of locales) {
    const pages = handbookFiles(join(dir, locale)).map((path) => renderHandbookPage(readFileSync(path, 'utf8'), relative(dir, path)))
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
