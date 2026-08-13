// The documentation site generator — the homegrown half of the re-decision
// documentation-architecture.md reserved (addendum 2026-08-13).
//
// Renders docs/ (vision, decisions, design, changelog) into a static site:
// navigation by AREA (the changelog's vocabulary), genre and stage as badges
// derived from folder and front matter, per-area index pages with a changelog
// teaser and summary lists. `ideas/` is hard-excluded; `content/` is the
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

import { execSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import { parseChangelog, type ChangelogSection } from '../src/ui/changelog/parseChangelog'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOCS = join(REPO, 'docs')
const OUT = join(REPO, 'client', 'docs-dist')

// The five areas — deliberately the changelog's vocabulary, so one nav spine
// carries timeline and documents alike.
const AREAS = [
  { id: 'worldgen', label: 'Worldgen' },
  { id: 'ui', label: 'UI' },
  { id: 'mechanics', label: 'Mechanics' },
  { id: 'concepts', label: 'Concepts' },
  { id: 'platform', label: 'Platform' },
]

type Genre = 'decisions' | 'design'
type Stage = 'idea' | 'decided' | 'building' | 'built' | 'superseded'

interface Doc {
  genre: Genre
  slug: string
  sourcePath: string // absolute, for link resolution and git dates
  route: string // site-relative, e.g. "decisions/server-config.html"
  title: string
  area: string
  stage: Stage
  summary: string
  status: string
  supersededBy?: string
  date: string
  updated: string
  body: string // markdown without front matter
}

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

// The front matter convention is FLAT — `key: rest of the line`, wrapped
// continuations indented — and the summaries freely contain colons and
// dashes, which strict YAML refuses in unquoted scalars. So: a tolerant
// line parser for exactly the convention, not a YAML dependency that would
// force quoting onto every doc.
function frontMatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(raw)
  if (!match) return { meta: {}, body: raw }
  const meta: Record<string, string> = {}
  let lastKey: string | null = null
  for (const line of match[1].split('\n')) {
    const kv = /^([A-Za-z][A-Za-z0-9-]*):\s?(.*)$/.exec(line)
    if (kv) {
      meta[kv[1]] = kv[2].trim()
      lastKey = kv[1]
    } else if (lastKey && /^\s+\S/.test(line)) {
      meta[lastKey] += ' ' + line.trim()
    }
  }
  return { meta, body: raw.slice(match[0].length) }
}

function firstHeading(body: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(body)
  return match ? match[1].trim() : fallback
}

function gitUpdated(sourcePath: string, fallback: string): string {
  try {
    const out = execSync(`git log -1 --format=%cs -- "${sourcePath}"`, { cwd: REPO }).toString().trim()
    return out || fallback
  } catch {
    return fallback
  }
}

function collectDocs(): Doc[] {
  const docs: Doc[] = []
  for (const genre of ['decisions', 'design'] as Genre[]) {
    for (const file of readdirSync(join(DOCS, genre)).sort()) {
      if (!file.endsWith('.md') || file === 'README.md') continue
      const sourcePath = join(DOCS, genre, file)
      const { meta, body } = frontMatter(readFileSync(sourcePath, 'utf8'))
      const slug = file.replace(/\.md$/, '')
      const date = String(meta.date ?? '')
      docs.push({
        genre,
        slug,
        sourcePath,
        route: `${genre}/${slug}.html`,
        title: firstHeading(body, slug),
        area: String(meta.area ?? 'platform'),
        stage: (meta.stage as Stage) ?? 'idea',
        summary: String(meta.summary ?? ''),
        status: String(meta.status ?? ''),
        supersededBy: meta['superseded-by'] ? String(meta['superseded-by']) : undefined,
        date,
        updated: gitUpdated(sourcePath, date),
        body,
      })
    }
  }
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
      updated: gitUpdated(sourcePath, date),
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

async function renderMarkdown(body: string, routes: Map<string, string>, fromDir: string): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(() => rewriteLinks(routes, fromDir))
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
      ...areaDocs.map((d) => link(d.route, d.title)),
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
  return `<nav class="side">
    <a class="side-home ${activeRoute === 'index.html' ? 'is-active' : ''}" href="/docs/">Casas Eternas</a>
    <div class="side-section">Operations</div>
    <div class="side-group">${opsBlocks}</div>
    <div class="side-section">Development</div>
    <div class="side-group">${areaBlocks}</div>
  </nav>`
}

function page(title: string, side: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(title)} — Casas Eternas</title>
  <link rel="icon" type="image/png" href="/docs/crown.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@400;600;900&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/docs/site.css" />
</head>
<body>
  ${side}
  <main>${content}</main>
</body>
</html>
`
}

function badges(doc: Doc): string {
  return `<span class="badge badge-genre badge-genre--${doc.genre}">${doc.genre === 'decisions' ? 'decision' : 'design'}</span>
    <span class="badge badge-stage badge-stage--${doc.stage}">${doc.stage}</span>
    <span class="badge badge-date" title="created ${esc(doc.date)}">updated ${esc(doc.updated)}</span>`
}

function docCard(doc: Doc): string {
  return `<a class="card" href="/docs/${doc.route}">
    <div class="card-head"><span class="card-title">${esc(doc.title)}</span>${badges(doc)}</div>
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

  for (const area of AREAS) {
    const md = readFileSync(join(DOCS, 'changelog', `${area.id}.md`), 'utf8')
    const sections = parseChangelog(md)
    const areaDocs = docs.filter((d) => d.area === area.id)
    const inProgress = areaDocs.filter((d) => ['idea', 'decided', 'building'].includes(d.stage))
    const reference = areaDocs.filter((d) => d.stage === 'built')
    const superseded = areaDocs.filter((d) => d.stage === 'superseded')

    const index = `<h1>${area.label}</h1>
      <section class="teaser">
        <h2>Latest</h2>
        ${changelogEntries(sections, 4)}
        <a class="more" href="/docs/${area.id}/changelog.html">full changelog →</a>
      </section>
      ${inProgress.length ? `<h2>In progress</h2>${inProgress.map(docCard).join('\n')}` : ''}
      ${reference.length ? `<h2>Reference</h2>${reference.map(docCard).join('\n')}` : ''}
      ${superseded.length ? `<details class="superseded-list"><summary>Superseded (${superseded.length})</summary>${superseded.map(docCard).join('\n')}</details>` : ''}`
    emit(`${area.id}/index.html`, page(area.label, sidebar(docs, ops, area.id, `${area.id}/index.html`), index))

    const log = `<h1>${area.label} — Changelog</h1>${changelogEntries(sections)}`
    emit(
      `${area.id}/changelog.html`,
      page(`${area.label} Changelog`, sidebar(docs, ops, area.id, `${area.id}/changelog.html`), log),
    )
  }

  for (const doc of docs) {
    const banner =
      doc.stage === 'superseded'
        ? `<div class="superseded-banner">This document is superseded${doc.supersededBy ? ` by <a href="/docs/${esc(findRoute(docs, doc.supersededBy) ?? '')}">${esc(doc.supersededBy)}</a>` : ''}.</div>`
        : ''
    const head = `<header class="doc-head">
      ${badges(doc)}
      <p class="doc-summary">${esc(doc.summary)}</p>
      ${doc.status ? `<p class="doc-status"><strong>Status:</strong> ${esc(doc.status)}</p>` : ''}
    </header>`
    const content = banner + head + (await renderMarkdown(doc.body, routes, dirname(doc.sourcePath)))
    emit(doc.route, page(doc.title, sidebar(docs, ops, doc.area, doc.route), content))
  }

  // Operations pages: manuals, so the header carries no lifecycle — only the
  // summary and when the page last moved.
  for (const doc of ops) {
    const head = `<header class="doc-head">
      <span class="badge badge-date">updated ${esc(doc.updated)}</span>
      <p class="doc-summary">${esc(doc.summary)}</p>
    </header>`
    const content = head + (await renderMarkdown(doc.body, routes, dirname(doc.sourcePath)))
    emit(doc.route, page(doc.title, sidebar(docs, ops, null, doc.route), content))
  }

  // Each group's index is a GENERATED view over its pages' front matter —
  // the operations mirror of the area index pages.
  for (const group of OPS_GROUPS) {
    const items = opsGroupItems(ops, group.id)
    if (!items.length) continue
    const cards = items
      .map(
        (i) => `<a class="card" href="/docs/${i.route}">
        <div class="card-head"><span class="card-title">${esc(i.label)}</span></div>
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
  copyFileSync(join(REPO, 'client', 'public', 'background.png'), join(OUT, 'background.png'))
  // The client's own favicon — one crown for every surface of the same thing.
  copyFileSync(join(REPO, 'client', 'public', 'icons', 'crown.png'), join(OUT, 'crown.png'))
  checkLinks()
  console.log(`docs site: ${docs.length} documents, ${AREAS.length} areas, ${ops.length + 2} operations pages → ${OUT}`)
}

function findRoute(docs: Doc[], slugOrFile: string): string | undefined {
  const slug = slugOrFile.replace(/\.md$/, '')
  return docs.find((d) => d.slug === slug)?.route
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

// ---------------------------------------------------------------------- css

const CSS = `
/* The documentation site wears the title screen's language: Cinzel for
   titles, the app's plain sans for everything else, white throughout, the
   changelog's kind colors. One file, no JS. */
* { box-sizing: border-box; }
body {
  margin: 0;
  display: flex;
  justify-content: center;
  min-height: 100vh;
  /* The title screen's artwork, almost entirely veiled: pinned to the
     VIEWPORT bottom (fixed), flush left and right, never distorted — a white
     layer at 84% over it keeps the text unbothered. The relative url keeps
     any static host serving it identically. */
  background-color: #ffffff;
  background-image: linear-gradient(rgba(255, 255, 255, 0.84), rgba(255, 255, 255, 0.84)), url('background.png');
  background-repeat: no-repeat, no-repeat;
  background-position: 0 0, center bottom;
  background-size: auto, 100% auto;
  background-attachment: scroll, fixed;
  color: #1a1a1a;
  font-family: sans-serif;
  line-height: 1.55;
}
h1, h2, h3 { font-family: 'Cinzel', serif; }
.side-home, .side summary { font-family: 'Cinzel', serif; }
h1 { font-weight: 900; letter-spacing: 0.04em; }
h2 { margin-top: 2.2rem; letter-spacing: 0.06em; }
code { font-family: ui-monospace, monospace; font-size: 0.88em; border: 1px solid #e7e4dc; padding: 0 0.25em; border-radius: 3px; }
pre { border: 1px solid #e7e4dc; padding: 0.9rem 1.1rem; border-radius: 4px; overflow-x: auto; }
pre code { border: none; padding: 0; }
a { color: #1a1a1a; }
table { border-collapse: collapse; margin: 1rem 0; }
th, td { border: 1px solid #d8d4ca; padding: 0.35rem 0.7rem; text-align: left; font-size: 0.92em; }
th { font-weight: 700; }
blockquote { margin: 1rem 0; padding: 0.1rem 1rem; border-left: 3px solid #d8d4ca; color: #555; }

.side {
  flex: none;
  width: 240px;
  padding: 1.4rem 1rem 2rem;
  border-right: 1px solid #e7e4dc;
}
.side-home { display: block; font-weight: 900; letter-spacing: 0.08em; text-transform: uppercase; text-decoration: none; margin-bottom: 1.2rem; font-size: 0.95rem; }
.side-section { margin: 1.2rem 0 0.35rem; font-family: 'Cinzel', serif; font-weight: 900; font-size: 0.7rem; letter-spacing: 0.14em; text-transform: uppercase; color: #999; }
.side details { margin-bottom: 0.4rem; }
.side summary { cursor: pointer; font-weight: 600; letter-spacing: 0.06em; padding: 0.25rem 0; list-style: none; }
.side summary::-webkit-details-marker { display: none; }
.side summary a { text-decoration: none; }
.side summary a:hover { text-decoration: underline; }
.side ul { list-style: none; margin: 0.2rem 0 0.6rem; padding-left: 0.9rem; }
.side li a { display: block; padding: 0.14rem 0; font-size: 0.86rem; color: #444; text-decoration: none; }
.side li a:hover { text-decoration: underline; }
.side a.is-active { font-weight: 700; color: #1a1a1a; }
/* ONE class per sidebar level, shared across both sections, so Operations
   and Development cannot drift apart: .side-group is the indent under a
   section heading, .side-title the dress of every group title inside it —
   areas and operations groups alike. Active titles go to 900 because that
   is a Cinzel weight that actually loads; 700 would silently round and
   look like nothing happened. */
.side-group { padding-left: 0.9rem; }
.side a.side-title { font-family: 'Cinzel', serif; font-weight: 600; letter-spacing: 0.06em; font-size: 1rem; color: #1a1a1a; padding: 0.25rem 0; }
.side a.side-title.is-active { font-weight: 900; }

main { flex: 1; min-width: 0; max-width: 780px; padding: 2.2rem 3rem 4rem; }

.badge {
  display: inline-block;
  padding: 0.08rem 0.5rem;
  border-radius: 3px;
  font-size: 0.68rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-right: 0.35rem;
}
.badge-genre--decisions { background: #1a1a1a; color: #fff; }
.badge-genre--design { background: none; border: 1px solid #1a1a1a; }
.badge-stage--idea { background: #e7e4dc; }
.badge-stage--decided { background: #3d7fb8; color: #fff; }
.badge-stage--building { background: #c8912f; color: #fff; }
.badge-stage--built { background: #3f9d5a; color: #fff; }
.badge-stage--superseded { background: #8a8a8a; color: #fff; }
.badge-date { color: #888; font-weight: 400; text-transform: none; }
.badge-gen { background: #e7e4dc; }
.ref-command { margin-bottom: 2.4rem; }
.ref-command h2 code { border: none; font-size: 0.82em; }

.card { display: block; text-decoration: none; padding: 0.7rem 0.9rem; margin: 0.5rem 0; border: 1px solid #e7e4dc; border-radius: 4px; }
.card:hover { border-color: #b9b2a2; }
.card-head { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; }
.card-title { font-family: 'Cinzel', serif; font-weight: 600; margin-right: 0.3rem; }
.card-summary { margin: 0.35rem 0 0; font-size: 0.88rem; color: #555; }

.teaser { border: 1px solid #e7e4dc; border-radius: 4px; padding: 0.2rem 1rem 0.8rem; }
.teaser h2 { margin: 0.7rem 0 0.2rem; font-size: 1rem; }
.more { display: inline-block; margin-top: 0.5rem; font-size: 0.85rem; }

.log-date { margin: 1.3rem 0 0.4rem; font-size: 0.92rem; letter-spacing: 0.05em; }
.log-entry { display: flex; gap: 0.6rem; align-items: baseline; margin-bottom: 0.4rem; font-size: 0.9rem; }
.log-kind { flex: none; min-width: 4.4rem; text-align: center; padding: 0.06rem 0.4rem; border-radius: 3px; font-size: 0.64rem; font-weight: 700; text-transform: uppercase; color: #fff; }
.log-kind--new { background: #3f9d5a; }
.log-kind--changed { background: #3d7fb8; }
.log-kind--dropped { background: #8a8a8a; }
.log-kind--fixed { background: #c8912f; }

.doc-head { margin-bottom: 1.6rem; padding-bottom: 1rem; border-bottom: 1px solid #e7e4dc; }
.doc-summary { margin: 0.6rem 0 0.3rem; color: #555; font-size: 0.92rem; }
.doc-status { margin: 0.3rem 0 0; font-size: 0.85rem; color: #777; }
.superseded-banner { border: 1px solid #c98b8b; border-radius: 4px; padding: 0.6rem 0.9rem; margin-bottom: 1rem; font-size: 0.9rem; }
.superseded-list summary { cursor: pointer; margin-top: 1.6rem; color: #888; }

@media (max-width: 860px) {
  body { flex-direction: column; }
  .side { width: auto; border-right: none; border-bottom: 1px solid #e7e4dc; }
  main { padding: 1.4rem 1.2rem 3rem; }
}
`

await build()
