import { parseChangelog } from './parseChangelog'
import './changelog.css'

// Render an entry's inline text into DOM nodes (content is repo-authored, but we
// still build nodes rather than innerHTML). Handles a leading "Label: " emphasis
// plus `code`, **bold**, *italic*.
function renderInline(text: string): DocumentFragment {
  const frag = document.createDocumentFragment()

  // Optional short leading label before a colon (e.g. "Genesis: …"), as long as
  // it doesn't run past an em-dash / markup — those aren't labels.
  let body = text
  const labelMatch = /^([^:—`*]{1,28}):\s+([\s\S]+)$/.exec(text)
  if (labelMatch) {
    const label = document.createElement('span')
    label.className = 'changelog-label'
    label.textContent = labelMatch[1]
    frag.appendChild(label)
    frag.appendChild(document.createTextNode(': '))
    body = labelMatch[2]
  }

  const token = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = token.exec(body)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(body.slice(last, m.index)))
    const tok = m[0]
    if (tok.startsWith('`')) {
      const code = document.createElement('code')
      code.className = 'changelog-key'
      code.textContent = tok.slice(1, -1)
      frag.appendChild(code)
    } else if (tok.startsWith('**')) {
      const strong = document.createElement('strong')
      strong.textContent = tok.slice(2, -2)
      frag.appendChild(strong)
    } else {
      const em = document.createElement('em')
      em.textContent = tok.slice(1, -1)
      frag.appendChild(em)
    }
    last = m.index + tok.length
  }
  if (last < body.length) frag.appendChild(document.createTextNode(body.slice(last)))

  return frag
}

// Build the rendered changelog list for one category's raw Markdown.
export function renderChangelog(md: string): HTMLElement {
  const root = document.createElement('div')
  root.className = 'changelog-list'

  const sections = parseChangelog(md)
  if (sections.length === 0) {
    const empty = document.createElement('p')
    empty.className = 'changelog-empty'
    empty.textContent = 'No entries yet.'
    root.appendChild(empty)
    return root
  }

  for (const section of sections) {
    const date = document.createElement('div')
    date.className = 'changelog-date'
    date.textContent = section.date
    root.appendChild(date)

    for (const entry of section.entries) {
      const row = document.createElement('div')
      row.className = 'changelog-entry'
      if (entry.kind) {
        const badge = document.createElement('span')
        badge.className = `changelog-kind changelog-kind--${entry.kind}`
        badge.textContent = entry.kind
        row.appendChild(badge)
      }
      const body = document.createElement('span')
      body.className = 'changelog-entry-text'
      body.appendChild(renderInline(entry.text))
      row.appendChild(body)
      root.appendChild(row)
    }
  }

  return root
}
