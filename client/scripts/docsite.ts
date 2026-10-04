// The documentation site generator — the homegrown half of the re-decision
// documentation-architecture.md reserved (addendum 2026-08-13).
//
// Renders docs/ (vision, decisions, design, changelog) into a static site:
// navigation by AREA (the changelog's vocabulary), genre and stage as badges
// derived from folder and front matter, per-area index pages with a changelog
// teaser and summary lists. `ideas/` is hard-excluded; `handbook/` is the
// manual's tree and not this script's business. Zero client-side JS — the
// sidebar's disclosure is native <details>/<summary>.
//
// Top levels are AUDIENCES (documentation-architecture.md, addendum 2):
// the sidebar carries `Development` (the tree above) and `Operations`
// (docs/operations/ — per-environment guides, no lifecycle badges) as plain
// section headings in ONE navigation. The CLI and configuration reference
// pages under Operations are never written: they render straight from
// docs/operations/cli-reference.json, which `tools/clidump` generates from
// the cobra tree and `make lint` keeps honest.
//
// Runs bundled (npm run build:docs), writes client/docs-dist/, and FAILS on
// any internal link that does not resolve — the site is verified by its own
// build, not by clicking around.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import { parseChangelog, type ChangelogSection } from './parseChangelog'
import { frontMatter, frontMatterList } from './frontMatter'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOCS = join(REPO, 'docs')
const OUT = join(REPO, 'client', 'docs-dist')

// The five areas — deliberately the changelog's vocabulary, so one nav spine
// carries timeline and documents alike.
const AREAS = [
  { id: 'generator', label: 'Generator' },
  { id: 'ui', label: 'UI' },
  { id: 'mechanics', label: 'Mechanics' },
  { id: 'concepts', label: 'Concepts' },
  { id: 'platform', label: 'Platform' },
]

type Genre = 'decisions' | 'design'
type Stage = 'idea' | 'decided' | 'building' | 'built' | 'superseded'

interface Doc {
  // DEC-0001 for a decision, DES-0001 for a design: a number per folder,
  // given in the order the documents came into the repository.
  id: string
  genre: Genre
  slug: string
  sourcePath: string // absolute, for link resolution
  route: string // site-relative, e.g. "decisions/server-config.html"
  title: string
  area: string
  stage: Stage
  summary: string
  supersededBy?: string // an id
  related: string[] // ids
  date: string
  updated: string
  body: string // markdown without front matter
}

// The title as the site shows it: the number, then the name.
const shownTitle = (doc: Doc): string => `${doc.id} · ${doc.title}`

// The groups under Operations — genre, not topic: orientation, setup per
// environment, topical explanations, generated reference. A group without
// documents is not rendered (`guides` waits for its first one); `reference`
// always exists, its pages are synthetic.
const OPS_GROUPS = [
  { id: 'overview', label: 'Overview' },
  { id: 'installation', label: 'Installation' },
  { id: 'guides', label: 'Guides' },
  { id: 'reference', label: 'Reference' },
]

// An operations page: a manual, not a lifecycle document — summary and date,
// deliberately no stage/status. `group` is the front-matter field that
// places it (data, like Development's `area` — never the filename), `order`
// sorts within the group.
interface OpsDoc {
  slug: string
  sourcePath: string
  route: string
  title: string
  summary: string
  group: string
  order: number
  updated: string
  body: string
}

// The clidump output this script renders — see tools/clidump/main.go for
// the shape's one source.
interface CliFlag {
  name: string
  shorthand?: string
  default?: string
  usage: string
  env?: string
}
interface CliCommand {
  path: string
  use: string
  short: string
  long?: string
  example?: string
  flags?: CliFlag[]
}
interface CliKey {
  key: string
  env: string
  default?: string
  usage?: string
  command?: string
}
interface CliReference {
  binary: string
  commands: CliCommand[]
  keys: CliKey[]
}

// ---------------------------------------------------------------- collection

function firstHeading(body: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(body)
  return match ? match[1].trim() : fallback
}

const ID_PREFIX: Record<Genre, string> = { decisions: 'DEC', design: 'DES' }
const STAGES: Stage[] = ['idea', 'decided', 'building', 'built', 'superseded']

function collectDocs(): Doc[] {
  const docs: Doc[] = []
  const problems: string[] = []
  for (const genre of ['decisions', 'design'] as Genre[]) {
    for (const file of readdirSync(join(DOCS, genre)).sort()) {
      if (!file.endsWith('.md') || file === 'README.md') continue
      const sourcePath = join(DOCS, genre, file)
      const { meta, body } = frontMatter(readFileSync(sourcePath, 'utf8'))
      const slug = file.replace(/\.md$/, '')
      const where = `docs/${genre}/${file}`
      const id = String(meta.id ?? '')
      if (!new RegExp(`^${ID_PREFIX[genre]}-\\d{4}$`).test(id)) problems.push(`${where}: id "${id}" is not ${ID_PREFIX[genre]}-NNNN`)
      for (const key of ['title.en', 'title.de', 'summary.en', 'summary.de', 'area', 'stage', 'createdAt']) {
        if (!meta[key]) problems.push(`${where}: ${key} is missing`)
      }
      if (!AREAS.some((a) => a.id === meta.area)) problems.push(`${where}: area "${meta.area}" is not one of ${AREAS.map((a) => a.id).join(', ')}`)
      if (!STAGES.includes(meta.stage as Stage)) problems.push(`${where}: stage "${meta.stage}" is not one of ${STAGES.join(', ')}`)
      if ((meta.stage === 'superseded') !== Boolean(meta.supersededBy)) problems.push(`${where}: stage superseded and supersededBy go together`)
      if (/^#\s/m.test(body.split('\n').find((l) => l.trim()) ?? '')) problems.push(`${where}: the title is title.en, not a heading in the text`)
      const date = String(meta.createdAt ?? '')
      docs.push({
        id,
        genre,
        slug,
        sourcePath,
        route: `${genre}/${slug}.html`,
        title: String(meta['title.en'] ?? slug),
        area: String(meta.area ?? 'platform'),
        stage: (meta.stage as Stage) ?? 'idea',
        summary: String(meta['summary.en'] ?? ''),
        supersededBy: meta.supersededBy ? String(meta.supersededBy) : undefined,
        related: frontMatterList(meta.related),
        date,
        // Stated in the front matter, not read out of git. git says when the
        // FILE moved, which is a different fact: a rename, a typo, or a change
        // of one front-matter value redates a document nobody rewrote — one
        // such pass redated seventeen at once. A writer who revises a doc says
        // so; a doc that never says it keeps its creation date, which is true
        // of a doc nobody has revised.
        updated: String(meta.updatedAt ?? date),
        body,
      })
    }
  }
  // The references between documents, by id: each must name one.
  const ids = new Set<string>()
  for (const doc of docs) {
    if (ids.has(doc.id)) problems.push(`${doc.id} is given to two documents`)
    ids.add(doc.id)
  }
  for (const doc of docs) {
    for (const ref of [...doc.related, ...(doc.supersededBy ? [doc.supersededBy] : [])]) {
      if (!ids.has(ref)) problems.push(`${doc.id}: ${ref} names no document`)
    }
  }
  // Loud, not lenient: a broken reference is a dead link wearing a working build.
  if (problems.length) throw new Error(`the design and decision documents:\n  ${problems.join('\n  ')}`)
  docs.sort((a, b) => a.id.localeCompare(b.id))
  return docs
}

function collectOps(): OpsDoc[] {
  const docs: OpsDoc[] = []
  for (const file of readdirSync(join(DOCS, 'operations')).sort()) {
    if (!file.endsWith('.md')) continue
    const sourcePath = join(DOCS, 'operations', file)
    const { meta, body } = frontMatter(readFileSync(sourcePath, 'utf8'))
    const slug = file.replace(/\.md$/, '')
    const date = String(meta.date ?? '')
    const group = String(meta.group ?? '')
    // Loud, not lenient — an unknown group would silently drop the page
    // from the sidebar, which is a broken site wearing a working build.
    if (!OPS_GROUPS.some((g) => g.id === group)) {
      throw new Error(`docs/operations/${file}: group "${group}" is not one of ${OPS_GROUPS.map((g) => g.id).join(', ')}`)
    }
    docs.push({
      slug,
      sourcePath,
      route: `operations/${slug}.html`,
      title: firstHeading(body, slug),
      summary: String(meta.summary ?? ''),
      group,
      order: Number(meta.order ?? 99),
      updated: String(meta.updated ?? date),
      body,
    })
  }
  docs.sort((a, b) => a.order - b.order)
  return docs
}

// ------------------------------------------------------------------ markdown

// Routes by absolute source path, so relative .md links between docs rewrite
// to site routes. A link whose target is not rendered (ideas/, code paths)
// degrades to plain text — a public site must not dangle into the repo.
function rewriteLinks(routes: Map<string, string>, fromDir: string) {
  const walk = (node: Record<string, any>): void => {
    for (const child of node.children ?? []) walk(child)
    if (node.type !== 'element' || node.tagName !== 'a') return
    const href: string = node.properties?.href ?? ''
    if (/^(https?:|mailto:|#)/.test(href)) return
    const [path, fragment] = href.split('#')
    const target = resolve(fromDir, path)
    const route = routes.get(target)
    if (route) {
      const pretty = route.endsWith('/index.html') ? route.slice(0, -'index.html'.length) : route === 'index.html' ? '' : route
      node.properties.href = `/docs/${pretty}${fragment ? '#' + fragment : ''}`
    } else {
      // Not part of the site: keep the words, drop the link.
      node.tagName = 'span'
      node.properties = {}
    }
  }
  return (tree: Record<string, any>) => walk(tree)
}

// A heading's anchor, and the same function the "On this page" column uses to
// point at it — one source, so a link cannot address an id that was never
// written. Non-word characters collapse to a hyphen; a repeat gets a number,
// because two sections called "Open questions" is normal in these documents.
function slugOf(text: string, taken: Set<string>): string {
  const base = text.toLowerCase().replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '') || 'section'
  let slug = base
  for (let n = 2; taken.has(slug); n += 1) slug = `${base}-${n}`
  taken.add(slug)
  return slug
}

// Gives every h2 an id and reports it, so the page can list its own sections.
// Written as a plugin beside rewriteLinks rather than pulled in as rehype-slug:
// one visitor over the same tree, and the ids stay ours to match.
function slugHeadings(into: { id: string; text: string }[]) {
  const taken = new Set<string>()
  const textOf = (node: Record<string, any>): string =>
    node.type === 'text' ? String(node.value) : (node.children ?? []).map(textOf).join('')
  const walk = (node: Record<string, any>): void => {
    for (const child of node.children ?? []) walk(child)
    if (node.type !== 'element' || node.tagName !== 'h2') return
    const text = textOf(node).trim()
    const id = slugOf(text, taken)
    node.properties = { ...(node.properties ?? {}), id }
    into.push({ id, text })
  }
  return (tree: Record<string, any>) => walk(tree)
}

async function renderMarkdown(
  body: string,
  routes: Map<string, string>,
  fromDir: string,
  headings: { id: string; text: string }[] = [],
): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(() => rewriteLinks(routes, fromDir))
    .use(() => slugHeadings(headings))
    .use(rehypeStringify)
  return String(await processor.process(body))
}

// Inline markup for changelog entry text (the strict format parseChangelog
// leaves in place): escape, then `code`, **bold**, *italic*.
function inlineHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
}

// ------------------------------------------------------------------ template

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// The pages of one operations group, the synthetic reference pages included —
// used by the sidebar and by the group index pages alike.
function opsGroupItems(ops: OpsDoc[], groupId: string): { route: string; label: string; summary: string }[] {
  const items = ops.filter((d) => d.group === groupId).map((d) => ({ route: d.route, label: d.title, summary: d.summary }))
  if (groupId === 'reference') {
    items.push(
      { route: 'operations/cli.html', label: 'CLI', summary: referenceSummary('CLI') },
      { route: 'operations/configuration.html', label: 'Configuration', summary: referenceSummary('Configuration') },
    )
  }
  return items
}

// One collapsible group — the ONE shape both sections' title level uses, so
// Operations and Development cannot drift apart in structure or styling:
// section heading → group (side-title, own index page) → pages.
function sidebarGroup(label: string, indexRoute: string, items: string[], open: boolean, activeRoute: string): string {
  return `<details ${open ? 'open' : ''}>
    <summary><a href="/docs/${indexRoute.replace(/index\.html$/, '')}" class="side-title ${activeRoute === indexRoute ? 'is-active' : ''}">${esc(label)}</a></summary>
    <ul>${items.join('\n')}</ul>
  </details>`
}

function sidebar(docs: Doc[], ops: OpsDoc[], activeArea: string | null, activeRoute: string): string {
  const link = (route: string, label: string): string =>
    `<li><a href="/docs/${route}" class="${activeRoute === route ? 'is-active' : ''}">${esc(label)}</a></li>`

  const areaBlocks = AREAS.map((area) => {
    const areaDocs = docs.filter((d) => d.area === area.id && d.stage !== 'superseded')
    const items = [
      link(`${area.id}/changelog.html`, 'Changelog'),
      ...areaDocs.map((d) => link(d.route, shownTitle(d))),
    ]
    return sidebarGroup(area.label, `${area.id}/index.html`, items, area.id === activeArea, activeRoute)
  }).join('\n')

  const opsBlocks = OPS_GROUPS.map((group) => {
    const items = opsGroupItems(ops, group.id)
    if (!items.length) return '' // `guides` stays invisible until its first page
    const indexRoute = `operations/${group.id}/index.html`
    const open = activeRoute === indexRoute || items.some((i) => i.route === activeRoute)
    return sidebarGroup(group.label, indexRoute, items.map((i) => link(i.route, i.label)), open, activeRoute)
  }).join('\n')

  // Top levels are audiences, and they are HEADINGS in one navigation — not
  // site modes (documentation-architecture.md, addendum 2).
  // No wordmark here: the header carries it, and two of them one above the
  // other was the first thing the eye landed on.
  return `<nav class="side">
    <div class="side-section">Operations</div>
    <div class="side-group">${opsBlocks}</div>
    <div class="side-section">Development</div>
    <div class="side-group">${areaBlocks}</div>
  </nav>`
}

// The strip across the top — design canvas (Weltgenerator, artboard
// "Doku · Generator-Seite"). It carries the one control the site has: search.
// The canvas also draws an "Open the generator" button here; it is left out.
// The docs are read on their own, and a button into an application is a
// different promise from the one a documentation header should make.
//
// The mark says DOCUMENTATION, not "Casas Eternas · Documentation". Same rule
// as the app's own title bar (ui/titleBar): a surface that is one part of the
// product names that part, and only a surface that IS the product carries the
// product's name. Two words where one will do is also two words to align.
// The field is a plain <input> that works as a filter box the moment the index
// has loaded, and says nothing about a shortcut it cannot honour without it.
function header(): string {
  return `<header class="top">
    <a class="top-mark" href="/docs/">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" />
        <path d="M3 10c4 1 6-2 9-1s4 4 9 2" />
        <path d="M5 17c3-1 5 1 8 0s4-3 7-2" />
      </svg>
      Documentation
    </a>
    <span class="top-spacer"></span>
    <label class="visually-hidden" for="docs-search">Search the documentation</label>
    <div class="search">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4 4" />
      </svg>
      <input id="docs-search" type="search" autocomplete="off" placeholder="Search pages, sections, changelog" />
      <span class="search-key">⌘K</span>
      <div class="search-results" id="docs-search-results" role="listbox" hidden></div>
    </div>
  </header>`
}

// `aside` is the right-hand column: what this page holds, and what its tags
// mean. A page with nothing to list — the changelog, the front page — passes
// none and the column stands EMPTY rather than being dropped: take it away and
// the text column moves, so the site's own pages would not agree with each
// other about where the words begin.
function page(title: string, side: string, content: string, aside = ''): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} — Casas Eternas</title>
  <link rel="icon" type="image/png" href="/docs/crown.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,600;12..96,700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/docs/site.css" />
</head>
<body>
  ${header()}
  <div class="shell">
    ${side}
    <main>${content}</main>
    <aside class="onpage">${aside}</aside>
  </div>
  <script src="/docs/site.js" defer></script>
</body>
</html>
`
}

// The right column of a document page: its own sections, then the legend for
// the badges at its head. The legend is on every document rather than on an
// "about" page nobody opens — it is four lines, and it is the vocabulary the
// whole site is sorted by.
function onThisPage(headings: { id: string; text: string }[]): string {
  const list = headings.length
    ? `<span class="onpage-label">On this page</span>
       <nav class="onpage-list">${headings.map((h) => `<a href="#${h.id}">${esc(h.text)}</a>`).join('\n')}</nav>`
    : ''
  return `${list}
    <div class="legend">
      <span class="onpage-label">What the tags mean</span>
      <div class="legend-row"><span class="badge badge-stage--idea">idea</span><span>Written down, not decided.</span></div>
      <div class="legend-row"><span class="badge badge-genre--decisions">decision</span><span>Direction settled, with the reasoning.</span></div>
      <div class="legend-row"><span class="badge badge-stage--building">building</span><span>Being implemented right now.</span></div>
      <div class="legend-row"><span class="badge badge-stage--built">shipped</span><span>In the generator, documented.</span></div>
    </div>`
}

// `built` reads as "shipped" here and nowhere else: the front matter's word is
// the machine's, and this is the word the reader was offered in the design's
// legend. The class keeps the id, so the colour and the filter still agree.
const STAGE_WORD: Record<Stage, string> = {
  idea: 'idea', decided: 'decided', building: 'building', built: 'shipped', superseded: 'superseded',
}

function badges(doc: Doc): string {
  return `<span class="badge badge-genre badge-genre--${doc.genre}">${doc.genre === 'decisions' ? 'decision' : 'design'}</span>
    <span class="badge badge-stage badge-stage--${doc.stage}">${STAGE_WORD[doc.stage]}</span>
    <span class="badge badge-date" title="created ${esc(doc.date)}">updated ${esc(doc.updated)}</span>`
}

// Filter an area's cards by where the work stands. The chips are inert until
// site.js runs — which is why they carry no `hidden` state in the markup: with
// JS off the page shows everything, which is the honest fallback for a control
// that only ever hides.
function filterChips(): string {
  const stages: [string, string][] = [
    ['all', 'All'], ['idea', 'Idea'], ['decided', 'Decided'], ['building', 'Building'], ['built', 'Shipped'],
  ]
  return `<div class="chips" role="group" aria-label="Filter by status">
    ${stages.map(([id, label], i) =>
      `<button type="button" class="chip" data-stage="${id}" aria-pressed="${i === 0}">${label}</button>`).join('\n')}
  </div>`
}

function docCard(doc: Doc): string {
  return `<a class="card" data-stage="${doc.stage}" href="/docs/${doc.route}">
    <span class="card-title">${esc(shownTitle(doc))}</span>
    <div class="card-badges">${badges(doc)}</div>
    <p class="card-summary">${esc(doc.summary)}</p>
  </a>`
}

function changelogEntries(sections: ChangelogSection[], limit?: number): string {
  const parts: string[] = []
  let count = 0
  for (const section of sections) {
    if (limit !== undefined && count >= limit) break
    const entries = limit === undefined ? section.entries : section.entries.slice(0, limit - count)
    count += entries.length
    parts.push(`<h3 class="log-date">${esc(section.date)}</h3>`)
    parts.push(
      ...entries.map(
        (e) =>
          `<div class="log-entry">${e.kind ? `<span class="log-kind log-kind--${e.kind}">${e.kind}</span>` : ''}<span>${inlineHtml(e.text)}</span></div>`,
      ),
    )
  }
  return parts.join('\n')
}

// ------------------------------------------------------- reference pages

// The two pages nobody writes: rendered straight from cli-reference.json,
// so a flag exists here exactly when it exists in `--help`.

function referenceSummary(label: string): string {
  return label === 'CLI'
    ? 'Every command and flag — generated from the binary itself.'
    : 'Every configuration key with flag, environment name and default — generated from the binary itself.'
}

function generatedHead(summary: string): string {
  return `<header class="doc-head">
    <span class="badge badge-gen">generated</span>
    <p class="doc-summary">${esc(summary)} Regenerate with <code>make cli-reference</code>; the lint refuses drift.</p>
  </header>`
}

function flagsTable(flags: CliFlag[]): string {
  const rows = flags
    .map(
      (f) => `<tr>
      <td><code>--${esc(f.name)}${f.shorthand ? `, -${esc(f.shorthand)}` : ''}</code></td>
      <td>${f.default ? `<code>${esc(f.default)}</code>` : '—'}</td>
      <td>${f.env ? `<code>${esc(f.env)}</code>` : '—'}</td>
      <td>${esc(f.usage)}</td>
    </tr>`,
    )
    .join('\n')
  return `<table><thead><tr><th>Flag</th><th>Default</th><th>Environment</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>`
}

function cliPage(ref: CliReference): string {
  const sections = ref.commands
    .map((c) => {
      // The usage line: the full path plus the Use string's argument hint.
      const argHint = c.use.split(' ').slice(1).join(' ')
      const usage = `${c.path}${argHint ? ' ' + argHint : ''}${c.flags?.length ? ' [flags]' : ''}`
      const long = c.long
        ? c.long
            .split(/\n{2,}/)
            .map((p) => `<p>${esc(p)}</p>`)
            .join('\n')
        : ''
      return `<section class="ref-command">
        <h2 id="${esc(c.path.replace(/\s+/g, '-'))}"><code>${esc(c.path)}</code></h2>
        <p>${esc(c.short)}</p>
        ${long}
        <pre><code>${esc(usage)}</code></pre>
        ${c.example ? `<pre><code>${esc(c.example)}</code></pre>` : ''}
        ${c.flags?.length ? flagsTable(c.flags) : ''}
      </section>`
    })
    .join('\n')
  return `<h1>CLI</h1>${generatedHead(`Every command of ${ref.binary}, rendered from the binary's own command tree — the same texts --help prints.`)}${sections}`
}

function configurationPage(ref: CliReference): string {
  const rows = ref.keys
    .map(
      (k) => `<tr>
      <td><code>${esc(k.key)}</code></td>
      <td>${k.default ? `<code>${esc(k.default)}</code>` : '—'}</td>
      <td><code>${esc(k.env)}</code></td>
      <td>${k.usage ? esc(k.usage) : '<em>storage backend selector — see the guides</em>'}</td>
    </tr>`,
    )
    .join('\n')
  return `<h1>Configuration</h1>${generatedHead(
    'Every configuration key of the one vocabulary: the key in casas.yaml is the flag name is the CASAS_* variable. Flags override the environment, which overrides the file.',
  )}<table><thead><tr><th>Key</th><th>Default</th><th>Environment</th><th>Description</th></tr></thead><tbody>${rows}</tbody></table>`
}

// ------------------------------------------------------------------ the site

async function build(): Promise<void> {
  const docs = collectDocs()
  const ops = collectOps()
  const routes = new Map<string, string>()
  for (const doc of docs) routes.set(doc.sourcePath, doc.route)
  for (const doc of ops) routes.set(doc.sourcePath, doc.route)
  routes.set(join(DOCS, 'vision.md'), 'index.html')
  // The reference pages have no Markdown source — these pseudo-routes let
  // the guides link them as `cli.md`/`configuration.md`, the same relative
  // convention every other doc link uses.
  routes.set(join(DOCS, 'operations', 'cli.md'), 'operations/cli.html')
  routes.set(join(DOCS, 'operations', 'configuration.md'), 'operations/configuration.html')
  for (const area of AREAS) routes.set(join(DOCS, 'changelog', `${area.id}.md`), `${area.id}/changelog.html`)

  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })

  const emit = (route: string, html: string): void => {
    const path = join(OUT, route)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, html)
  }

  // Vision is the front page — a human document, rendered as-is.
  const vision = readFileSync(join(DOCS, 'vision.md'), 'utf8')
  emit(
    'index.html',
    page('Vision', sidebar(docs, ops, null, 'index.html'), await renderMarkdown(vision, routes, DOCS)),
  )

  // Filled as the pages are written, and read once at the end by the search
  // index — so what the index points at is exactly what was emitted.
  const allHeadings = new Map<string, { id: string; text: string }[]>()
  const allLogs = new Map<string, ChangelogSection[]>()

  for (const area of AREAS) {
    const md = readFileSync(join(DOCS, 'changelog', `${area.id}.md`), 'utf8')
    const sections = parseChangelog(md)
    allLogs.set(area.id, sections)
    const areaDocs = docs.filter((d) => d.area === area.id)
    const inProgress = areaDocs.filter((d) => ['idea', 'decided', 'building'].includes(d.stage))
    const reference = areaDocs.filter((d) => d.stage === 'built')
    const superseded = areaDocs.filter((d) => d.stage === 'superseded')

    // What the area is, in the three facts the design's meta line carries. The
    // newest `updated` in the area rather than the changelog's newest date:
    // the line is about these pages, and a changelog entry is not one.
    const newest = areaDocs.map((d) => d.updated).sort().pop() ?? ''
    const meta = [
      newest ? `Last updated ${newest}` : '',
      `${areaDocs.length} ${areaDocs.length === 1 ? 'page' : 'pages'}`,
      'Public — no account needed',
    ].filter(Boolean)

    const index = `<div class="area-head">
        <span class="area-kicker">Development · ${esc(area.label)}</span>
        <h1>${esc(area.label)}</h1>
        <div class="area-meta">${meta.map(esc).join('<span>·</span>')}</div>
      </div>
      ${filterChips()}
      <section class="teaser">
        <h2>Latest</h2>
        ${changelogEntries(sections, 4)}
        <a class="more" href="/docs/${area.id}/changelog.html">full changelog →</a>
      </section>
      ${inProgress.length ? `<h2 class="area-section">In progress</h2>${inProgress.map(docCard).join('\n')}` : ''}
      ${reference.length ? `<h2 class="area-section">Reference</h2>${reference.map(docCard).join('\n')}` : ''}
      ${superseded.length ? `<details class="superseded-list"><summary>Superseded (${superseded.length})</summary>${superseded.map(docCard).join('\n')}</details>` : ''}`
    emit(
      `${area.id}/index.html`,
      page(area.label, sidebar(docs, ops, area.id, `${area.id}/index.html`), index, onThisPage([])),
    )

    const log = `<h1>${area.label} — Changelog</h1>${changelogEntries(sections)}`
    emit(
      `${area.id}/changelog.html`,
      page(`${area.label} Changelog`, sidebar(docs, ops, area.id, `${area.id}/changelog.html`), log),
    )
  }

  const byId = new Map(docs.map((d) => [d.id, d]))
  const docLink = (d: Doc): string => `<a href="/docs/${esc(d.route)}">${esc(shownTitle(d))}</a>`
  for (const doc of docs) {
    const successor = doc.supersededBy ? byId.get(doc.supersededBy) : undefined
    const banner =
      doc.stage === 'superseded'
        ? `<div class="superseded-banner">This document is superseded${successor ? ` by ${docLink(successor)}` : ''}.</div>`
        : ''
    // The other directions, derived: what this one replaces, and what names
    // it as related — a relation is written once, on either side.
    const supersedes = docs.filter((d) => d.supersededBy === doc.id)
    const related = docs.filter((d) => d !== doc && (doc.related.includes(d.id) || d.related.includes(doc.id)))
    const links = [
      supersedes.length ? `<p class="doc-links"><strong>Supersedes:</strong> ${supersedes.map(docLink).join(', ')}</p>` : '',
      related.length ? `<p class="doc-links"><strong>Related:</strong> ${related.map(docLink).join(', ')}</p>` : '',
    ].join('')
    const head = `<header class="doc-head">
      <h1>${esc(shownTitle(doc))}</h1>
      ${badges(doc)}
      <p class="doc-summary">${esc(doc.summary)}</p>
      ${links}
    </header>`
    const headings: { id: string; text: string }[] = []
    const content = banner + head + (await renderMarkdown(doc.body, routes, dirname(doc.sourcePath), headings))
    allHeadings.set(doc.route, headings)
    emit(doc.route, page(shownTitle(doc), sidebar(docs, ops, doc.area, doc.route), content, onThisPage(headings)))
  }

  // Operations pages: manuals, so the header carries no lifecycle — only the
  // summary and when the page last moved.
  for (const doc of ops) {
    const head = `<header class="doc-head">
      <span class="badge badge-date">updated ${esc(doc.updated)}</span>
      <p class="doc-summary">${esc(doc.summary)}</p>
    </header>`
    const headings: { id: string; text: string }[] = []
    const content = head + (await renderMarkdown(doc.body, routes, dirname(doc.sourcePath), headings))
    // An operations page is a manual: its sections are the whole point, but it
    // carries no lifecycle, so the column lists them without the legend.
    const aside = headings.length
      ? `<span class="onpage-label">On this page</span><nav class="onpage-list">${headings.map((h) => `<a href="#${h.id}">${esc(h.text)}</a>`).join('')}</nav>`
      : ''
    allHeadings.set(doc.route, headings)
    emit(doc.route, page(doc.title, sidebar(docs, ops, null, doc.route), content, aside))
  }

  // Each group's index is a GENERATED view over its pages' front matter —
  // the operations mirror of the area index pages.
  for (const group of OPS_GROUPS) {
    const items = opsGroupItems(ops, group.id)
    if (!items.length) continue
    const cards = items
      .map(
        (i) => `<a class="card" href="/docs/${i.route}">
        <span class="card-title">${esc(i.label)}</span>
        <p class="card-summary">${esc(i.summary)}</p>
      </a>`,
      )
      .join('\n')
    const route = `operations/${group.id}/index.html`
    emit(route, page(group.label, sidebar(docs, ops, null, route), `<h1>${esc(group.label)}</h1>${cards}`))
  }

  const reference = JSON.parse(readFileSync(join(DOCS, 'operations', 'cli-reference.json'), 'utf8')) as CliReference
  emit('operations/cli.html', page('CLI', sidebar(docs, ops, null, 'operations/cli.html'), cliPage(reference)))
  emit(
    'operations/configuration.html',
    page('Configuration', sidebar(docs, ops, null, 'operations/configuration.html'), configurationPage(reference)),
  )

  writeFileSync(join(OUT, 'site.css'), CSS)
  writeFileSync(join(OUT, 'site.js'), SITE_JS)
  const index = searchIndex(docs, ops, allHeadings, allLogs)
  writeFileSync(join(OUT, 'search.json'), JSON.stringify(index))
  copyFileSync(join(REPO, 'client', 'public', 'background.png'), join(OUT, 'background.png'))
  // The client's own favicon — one crown for every surface of the same thing.
  copyFileSync(join(REPO, 'client', 'public', 'icons', 'crown.png'), join(OUT, 'crown.png'))
  checkLinks()
  const indexKb = Math.round(JSON.stringify(index).length / 1024)
  console.log(`docs site: ${docs.length} documents, ${AREAS.length} areas, ${ops.length + 2} operations pages, ${index.length} search entries (${indexKb} KB) → ${OUT}`)
}

// Every internal link must resolve inside the emitted tree — the build is the
// click-through.
function checkLinks(): void {
  const broken: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.name.endsWith('.html')) continue
      const html = readFileSync(path, 'utf8')
      for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
        const href = match[1]
        if (/^(https?:|mailto:|#)/.test(href)) continue
        const target = href.startsWith('/docs/') ? join(OUT, href.slice('/docs/'.length)) : resolve(dirname(path), href)
        let file = target.split('#')[0]
        if (href.endsWith('/') || href === '/docs') file = join(file, 'index.html')
        try {
          readFileSync(file)
        } catch {
          broken.push(`${path.slice(OUT.length + 1)} → ${href}`)
        }
      }
    }
  }
  walk(OUT)
  if (broken.length) {
    throw new Error(`broken internal links:\n  ${broken.join('\n  ')}`)
  }
}

// ------------------------------------------------------------------- search
//
// A static index, built here and read by site.js. Titles, summaries, section
// headings and changelog lines — NOT the full text, which is 740 KB of prose
// for a corpus of forty-odd documents: with the sections in the index, the
// thing you remember ("the note about the salt band") is already an entry, and
// a substring match over 60 KB needs neither stemming nor a library.
//
// Each entry is [route, kind, title, context]: kind colours the row, context is
// the document or area it sits in, so two sections with the same name are told
// apart by where they are.
type SearchEntry = [string, string, string, string]

function searchIndex(docs: Doc[], ops: OpsDoc[], headings: Map<string, { id: string; text: string }[]>,
                     logs: Map<string, ChangelogSection[]>): SearchEntry[] {
  const entries: SearchEntry[] = []
  for (const doc of docs) {
    entries.push([`/docs/${doc.route}`, doc.genre === 'decisions' ? 'decision' : 'design', shownTitle(doc), doc.summary])
    for (const h of headings.get(doc.route) ?? []) {
      entries.push([`/docs/${doc.route}#${h.id}`, 'section', h.text, shownTitle(doc)])
    }
  }
  for (const doc of ops) {
    entries.push([`/docs/${doc.route}`, 'operations', doc.title, doc.summary])
    for (const h of headings.get(doc.route) ?? []) {
      entries.push([`/docs/${doc.route}#${h.id}`, 'section', h.text, doc.title])
    }
  }
  for (const [areaId, sections] of logs) {
    const label = AREAS.find((a) => a.id === areaId)?.label ?? areaId
    for (const section of sections) {
      for (const entry of section.entries) {
        // The date, not an anchor: a changelog page is one long list, and the
        // line you searched for is found by eye once its day is on screen.
        // The markup is stripped: the index is searched as words, and a `key`
        // in backticks would otherwise only match with its backticks typed.
        const text = entry.text.replace(/[`*]/g, '')
        entries.push([`/docs/${areaId}/changelog.html`, entry.kind ?? 'changelog', text, `${label} · ${section.date}`])
      }
    }
  }
  return entries
}

// Everything the browser runs. Two jobs, one file: the search field, and the
// area pages' filter chips. Both only ever hide or reveal what the HTML
// already holds, so the site without JS is the site with everything shown.
const SITE_JS = `
(function () {
  var field = document.getElementById('docs-search')
  var results = document.getElementById('docs-search-results')
  if (field && results) {
    var index = null
    var loading = null
    // Fetched on first use, not on page load: most visits read a page and
    // never search, and the index is the only weight this site has.
    function load() {
      if (index) return Promise.resolve(index)
      if (!loading) {
        loading = fetch('/docs/search.json').then(function (r) { return r.json() }).then(function (rows) {
          index = rows
          return rows
        })
      }
      return loading
    }
    function render(rows, query) {
      if (!query) { results.hidden = true; results.textContent = ''; return }
      results.textContent = ''
      if (!rows.length) {
        var none = document.createElement('p')
        none.className = 'search-none'
        none.textContent = 'Nothing matches “' + query + '”.'
        results.appendChild(none)
        results.hidden = false
        return
      }
      rows.slice(0, 12).forEach(function (row) {
        var a = document.createElement('a')
        a.href = row[0]
        a.className = 'search-hit'
        var kind = document.createElement('span')
        kind.className = 'search-kind'
        kind.textContent = row[1]
        var title = document.createElement('span')
        title.className = 'search-title'
        title.textContent = row[2]
        var where = document.createElement('span')
        where.className = 'search-where'
        where.textContent = row[3]
        a.appendChild(kind); a.appendChild(title); a.appendChild(where)
        results.appendChild(a)
      })
      results.hidden = false
    }
    function search() {
      var query = field.value.trim()
      if (!query) { render([], ''); return }
      load().then(function (rows) {
        // Every word has to appear somewhere in the row — the order does not
        // matter, so "torus decision" finds the topology fork.
        var words = query.toLowerCase().split(/\\s+/)
        var hits = rows.filter(function (row) {
          var hay = (row[1] + ' ' + row[2] + ' ' + row[3]).toLowerCase()
          return words.every(function (w) { return hay.indexOf(w) >= 0 })
        })
        // A title match before a match buried in the context line.
        var head = query.toLowerCase()
        hits.sort(function (a, b) {
          return (b[2].toLowerCase().indexOf(head) === 0 ? 1 : 0) - (a[2].toLowerCase().indexOf(head) === 0 ? 1 : 0)
        })
        render(hits, query)
      })
    }
    field.addEventListener('input', search)
    field.addEventListener('focus', function () { load(); search() })
    document.addEventListener('keydown', function (event) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') { event.preventDefault(); field.focus(); field.select() }
      if (event.key === 'Escape' && document.activeElement === field) { field.value = ''; render([], ''); field.blur() }
    })
    document.addEventListener('click', function (event) {
      if (!results.hidden && !field.parentElement.contains(event.target)) render([], '')
    })
  }

  var chips = [].slice.call(document.querySelectorAll('.chip'))
  if (chips.length) {
    var cards = [].slice.call(document.querySelectorAll('.card[data-stage]'))
    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        var stage = chip.getAttribute('data-stage')
        chips.forEach(function (other) { other.setAttribute('aria-pressed', String(other === chip)) })
        cards.forEach(function (card) {
          card.hidden = stage !== 'all' && card.getAttribute('data-stage') !== stage
        })
        // A heading whose whole section was just hidden would sit over nothing.
        var headings = [].slice.call(document.querySelectorAll('.area-section'))
        headings.forEach(function (heading) {
          var shown = false
          for (var node = heading.nextElementSibling; node && node.classList.contains('card'); node = node.nextElementSibling) {
            if (!node.hidden) shown = true
          }
          heading.hidden = !shown
        })
      })
    })
  }
})()
`

// ---------------------------------------------------------------------- css

const CSS = `
/* The documentation site wears the app's own language — design canvas
   (Weltgenerator, artboard "Doku · Generator-Seite"): Bricolage Grotesque for
   titles, IBM Plex Sans for text, IBM Plex Mono for anything that is an
   identifier. It replaced a Cinzel-and-white dress that predated the redesign.

   The palette is copied from client/src/ui/theme/design.css rather than
   imported: this site is standalone HTML served by the Go server and shares no
   build with the client. Copied, therefore named the same, so the two can be
   compared by eye. The one deliberate difference is the paper — the docs are a
   lighter sheet than the app's chrome, as the canvas draws them. */
:root {
  --paper: #fbfaf7;
  --card: #ffffff;
  --line: #e4dfd4;
  --line2: #d3cab8;
  --strong: #15191d;
  --text: #1f2328;
  --text2: #3d434a;
  --muted: #5f6770;
  --faint: #8b9099;
  --accent: #d8912e;
  --accent-text: #9a5c0b;
  --link-hover: #7a4808;
  --hover: #ece5d8;

  /* The header's height, read by both side columns rather than written three
     times — the same idiom as the app's --title-bar-height. */
  --top-height: 62px;
}

* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  /* The title screen's artwork, almost entirely veiled: pinned to the
     VIEWPORT bottom (fixed), flush left and right, never distorted. The
     relative url keeps any static host serving it identically. */
  background-color: var(--paper);
  background-image: linear-gradient(rgba(251, 250, 247, 0.84), rgba(251, 250, 247, 0.84)), url('background.png');
  background-repeat: no-repeat, no-repeat;
  background-position: 0 0, center bottom;
  background-size: auto, 100% auto;
  background-attachment: scroll, fixed;
  color: var(--text);
  font-family: 'IBM Plex Sans', system-ui, sans-serif;
  line-height: 1.55;
}
h1, h2, h3 { font-family: 'Bricolage Grotesque', Georgia, serif; letter-spacing: -0.01em; }
h1 { font-size: 2.3rem; font-weight: 700; line-height: 1.1; }
h2 { margin-top: 2.2rem; font-size: 1.4rem; font-weight: 700; }
h3 { font-size: 1.1rem; font-weight: 600; }
code { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 0.88em; border: 1px solid var(--line); padding: 0 0.25em; border-radius: 3px; }
pre { border: 1px solid var(--line); padding: 0.9rem 1.1rem; border-radius: 6px; overflow-x: auto; background: var(--card); }
pre code { border: none; padding: 0; }
a { color: var(--accent-text); text-decoration: none; }
a:hover { color: var(--link-hover); text-decoration: underline; }
table { border-collapse: collapse; margin: 1rem 0; }
th, td { border: 1px solid var(--line); padding: 0.35rem 0.7rem; text-align: left; font-size: 0.92em; }
th { font-weight: 600; }
blockquote { margin: 1rem 0; padding: 0.1rem 1rem; border-left: 3px solid var(--line2); color: var(--muted); }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }

/* --- the strip across the top ------------------------------------------- */
.top {
  position: sticky;
  top: 0;
  z-index: 5;
  flex: none;
  height: var(--top-height);
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 28px;
  border-bottom: 1px solid var(--line);
  background: rgba(251, 250, 247, 0.93);
  backdrop-filter: blur(6px);
}
.top-mark { display: flex; align-items: center; gap: 10px; font-family: 'Bricolage Grotesque', Georgia, serif; font-size: 19px; font-weight: 700; color: var(--strong); }
.top-mark:hover { color: var(--strong); text-decoration: none; }
.top-spacer { flex-grow: 1; }

/* --- search -------------------------------------------------------------- */
.search {
  position: relative;
  display: flex; align-items: center; gap: 8px;
  width: 320px; height: 36px; padding: 0 10px 0 12px;
  border: 1px solid var(--line2); border-radius: 8px; background: var(--card);
  color: var(--faint);
}
.search input { flex-grow: 1; min-width: 0; border: 0; background: transparent; font: inherit; font-size: 13.5px; color: var(--text); }
.search input:focus { outline: none; }
.search:focus-within { border-color: var(--accent); }
.search-key { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 11px; border: 1px solid var(--line); border-radius: 4px; padding: 1px 5px; }
.search-results {
  position: absolute; top: calc(100% + 8px); right: 0; width: 460px; max-height: 60vh; overflow-y: auto;
  padding: 6px; display: flex; flex-direction: column; gap: 2px;
  border: 1px solid var(--line2); border-radius: 8px; background: var(--card);
  box-shadow: 0 14px 36px rgba(70, 52, 24, 0.18);
}
.search-results[hidden] { display: none; }
.search-hit { display: flex; align-items: baseline; gap: 10px; padding: 7px 9px; border-radius: 6px; color: var(--text); }
.search-hit:hover { background: var(--hover); text-decoration: none; color: var(--text); }
.search-kind {
  flex: none; width: 74px; font-size: 10.5px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--muted);
}
.search-title { flex-grow: 1; font-size: 13.5px; }
.search-where { flex: none; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; color: var(--faint); }
.search-none { margin: 0; padding: 8px 9px; font-size: 13px; color: var(--muted); }

/* --- the three columns ---------------------------------------------------
   The side columns sit at the EDGES of the page and keep their width, the way
   the generator's own sidebar does; the text column takes what is left and
   centres itself inside it. Centring the whole row instead (which this did at
   first) left the navigation floating somewhere in the middle of a wide
   window, at a distance that changed with every window size.

   Both are sticky under the header and scroll on their own, so a long document
   never scrolls its own table of contents away. The header's height is a
   variable rather than a number repeated three times. */
.shell { flex-grow: 1; display: flex; align-items: flex-start; min-height: 0; }

.side {
  position: sticky;
  top: var(--top-height);
  flex: none;
  width: 274px;
  height: calc(100vh - var(--top-height));
  overflow-y: auto;
  padding: 1.6rem 1.2rem 2rem 1.8rem;
  border-right: 1px solid var(--line);
}
.side-section { margin: 1.4rem 0 0.4rem; font-size: 0.72rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--faint); }
.side-section:first-child { margin-top: 0; }
.side details { margin-bottom: 0.4rem; }
.side summary { cursor: pointer; padding: 0.25rem 0; list-style: none; }
.side summary::-webkit-details-marker { display: none; }
.side ul { list-style: none; margin: 0.2rem 0 0.6rem; padding-left: 0.9rem; border-left: 1px solid var(--line); }
.side li a { display: block; padding: 0.22rem 0 0.22rem 0.55rem; font-size: 0.86rem; color: var(--muted); }
.side li a:hover { color: var(--text); text-decoration: none; }
/* The page you are on is a FILL, not a weight: these titles are long and set
   in a serif, and a bolder line of it reads as noise rather than as a place. */
.side a.is-active { color: var(--accent-text); background: #f4ecdc; border-radius: 4px; }
/* ONE class per sidebar level, shared across both sections, so Operations and
   Development cannot drift apart. */
.side-group { padding-left: 0.6rem; }
.side a.side-title { font-family: 'Bricolage Grotesque', Georgia, serif; font-size: 1rem; font-weight: 600; color: var(--strong); padding: 0.25rem 0; }
.side a.side-title.is-active { background: none; color: var(--accent-text); }

main { flex: 1; min-width: 0; max-width: 780px; margin: 0 auto; padding: 2rem 2.4rem 4rem; }

/* --- on this page, and what the tags mean -------------------------------- */
.onpage {
  position: sticky;
  top: var(--top-height);
  flex: none;
  width: 240px;
  max-height: calc(100vh - var(--top-height));
  overflow-y: auto;
  padding: 2.2rem 1.8rem 2rem 0.6rem;
}
.onpage-label { display: block; margin-bottom: 0.5rem; font-size: 0.72rem; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--faint); }
.onpage-list { display: flex; flex-direction: column; margin-bottom: 1.6rem; }
.onpage-list a { padding: 0.18rem 0 0.18rem 0.6rem; border-left: 2px solid var(--line); font-size: 0.82rem; color: var(--muted); }
.onpage-list a:hover { color: var(--text); border-left-color: var(--accent); text-decoration: none; }
.legend { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.9rem; border: 1px solid var(--line); border-radius: 10px; background: var(--card); }
.legend-row { display: flex; align-items: flex-start; gap: 0.5rem; font-size: 0.78rem; line-height: 1.35; color: var(--muted); }
.legend-row .badge { flex: none; margin: 0; }

/* --- an area's front page ------------------------------------------------ */
.area-head { display: flex; flex-direction: column; gap: 0.5rem; }
.area-head h1 { margin: 0; }
.area-kicker { font-size: 0.82rem; color: var(--faint); }
.area-meta { display: flex; gap: 0.6rem; font-size: 0.82rem; color: var(--faint); }
.area-section { margin-top: 2rem; }
.area-section[hidden] { display: none; }

.chips { display: flex; gap: 8px; margin: 1.2rem 0 0.6rem; }
.chip {
  height: 30px; padding: 0 12px; border: 1px solid var(--line2); border-radius: 15px;
  background: transparent; color: var(--text2); font: inherit; font-size: 13px; cursor: pointer;
}
.chip:hover { background: var(--hover); }
.chip[aria-pressed='true'] { background: var(--strong); border-color: var(--strong); color: var(--paper); }

/* --- badges -------------------------------------------------------------- */
.badge {
  display: inline-block;
  padding: 0.1rem 0.5rem;
  border-radius: 4px;
  font-size: 0.68rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-right: 0.35rem;
}
.badge-genre--decisions { background: var(--strong); color: var(--paper); }
.badge-genre--design { background: none; border: 1px solid var(--line2); color: var(--text2); }
.badge-stage--idea { background: #eceae4; color: var(--text2); }
.badge-stage--decided { background: #e3edfa; color: #24528f; }
.badge-stage--building { background: #f6e6c8; color: #7a5310; }
.badge-stage--built { background: #dcefe4; color: #1f6340; }
.badge-stage--superseded { background: #eceae4; color: var(--faint); }
.badge-date { color: var(--faint); font-weight: 400; text-transform: none; letter-spacing: 0; }
.badge-gen { background: #eceae4; }
.ref-command { margin-bottom: 2.4rem; }
.ref-command h2 code { border: none; font-size: 0.82em; }

/* --- cards --------------------------------------------------------------- */
.card {
  display: block; padding: 1rem 1.2rem; margin: 0.6rem 0;
  border: 1px solid var(--line); border-radius: 10px; background: var(--card);
  color: var(--text);
}
.card:hover { border-color: var(--line2); text-decoration: none; color: var(--text); }
.card[hidden] { display: none; }
.card-title { display: block; font-family: 'Bricolage Grotesque', Georgia, serif; font-size: 1.05rem; font-weight: 600; color: var(--strong); }
/* Badges on their OWN line under the title: sharing a flex row with a long
   title made them wrap unevenly and poke past the card's edge. */
.card-badges { margin-top: 0.4rem; }
.card-summary { margin: 0.4rem 0 0; font-size: 0.88rem; color: var(--muted); }

/* --- the changelog ------------------------------------------------------- */
.teaser { border: 1px solid var(--line); border-radius: 10px; padding: 0.4rem 1.3rem 1.1rem; background: var(--card); }
.teaser h2 { margin: 1rem 0 0.4rem; font-size: 1.15rem; }
.more { display: inline-block; margin-top: 0.7rem; font-size: 0.85rem; }

.log-date { margin: 1.5rem 0 0.5rem; font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 0.85rem; color: var(--faint); letter-spacing: 0.02em; }
.log-entry { display: flex; gap: 0.75rem; align-items: baseline; margin-bottom: 0.5rem; font-size: 0.88rem; line-height: 1.55; color: var(--text2); }
.log-kind {
  flex: none; min-width: 5rem; text-align: center; padding: 0.1rem 0.4rem; border-radius: 4px;
  font-size: 0.64rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em;
}
.log-kind--new { background: #dcefe4; color: #1f6340; }
.log-kind--changed { background: #e3edfa; color: #24528f; }
.log-kind--dropped { background: #eceae4; color: var(--muted); }
.log-kind--fixed { background: #f6e6c8; color: #7a5310; }

/* --- a document's own head ----------------------------------------------- */
.doc-head { margin-bottom: 1.8rem; padding-bottom: 1.1rem; border-bottom: 1px solid var(--line); }
.doc-summary { margin: 0.7rem 0 0.3rem; color: var(--text2); font-size: 0.95rem; }
.doc-links { margin: 0.4rem 0 0; font-size: 0.85rem; color: var(--muted); }
.superseded-banner { border: 1px solid #d9a39b; background: #f7e1dd; border-radius: 8px; padding: 0.7rem 1rem; margin-bottom: 1.2rem; font-size: 0.9rem; color: #b0392c; }
.superseded-list summary { cursor: pointer; margin-top: 1.8rem; color: var(--faint); }

/* One breakpoint, and it drops the two side columns rather than shrinking
   them: at this width a 240px column of section links is most of the screen. */
@media (max-width: 1100px) {
  .onpage { display: none; }
}
@media (max-width: 860px) {
  .shell { flex-direction: column; }
  .side {
    position: static;
    width: auto;
    height: auto;
    border-right: none;
    border-bottom: 1px solid var(--line);
  }
  main { padding: 1.4rem 1.2rem 3rem; max-width: none; }
  .top { padding: 0 1rem; gap: 10px; }
  .search-key { display: none; }
  .search { width: auto; flex-grow: 1; }
  .search-results { width: min(460px, calc(100vw - 2rem)); }
}

`

await build()
