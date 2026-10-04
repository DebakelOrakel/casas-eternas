// THE FRONT MATTER of docs/: the convention is FLAT — `key: rest of the
// line`, wrapped continuations indented, a language as a dotted key
// (`title.de`), a list as `[a, b]` — and the summaries freely contain colons
// and dashes, which strict YAML refuses in unquoted scalars. So: a tolerant
// line parser for exactly the convention, not a YAML dependency that would
// force quoting onto every doc. Shared by the doc site (docsite.ts) and the
// handbook (handbook.ts), which both read the design and decision docs.
//
// Tolerant of the convention, not of everything: a line it cannot place
// (a YAML block list, a key in a form it does not know) comes back in
// `ignored`, and the doc site refuses a document with one rather than
// silently dropping what it said. Line ends are taken as they come (CRLF).

export function frontMatter(raw: string): { meta: Record<string, string>; body: string; ignored: string[] } {
  const text = raw.replace(/\r\n/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text)
  if (!match) return { meta: {}, body: text, ignored: [] }
  const meta: Record<string, string> = {}
  const ignored: string[] = []
  let lastKey: string | null = null
  for (const line of match[1].split('\n')) {
    const kv = /^([A-Za-z][A-Za-z0-9.-]*):\s?(.*)$/.exec(line)
    if (kv) {
      meta[kv[1]] = kv[2].trim()
      lastKey = kv[1]
    } else if (lastKey && /^\s+\S/.test(line)) {
      meta[lastKey] += ' ' + line.trim()
    } else if (line.trim() && !line.trim().startsWith('#')) {
      ignored.push(line)
    }
  }
  return { meta, body: text.slice(match[0].length), ignored }
}

// `[a, b]` → ['a', 'b']; absent → [].
export function frontMatterList(value: string | undefined): string[] {
  if (!value) return []
  return value.replace(/^\[|\]$/g, '').split(',').map((v) => v.trim()).filter(Boolean)
}
