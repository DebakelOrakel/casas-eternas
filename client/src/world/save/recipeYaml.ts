// Reading single values out of a save's `world.yaml` recipe.
//
// Flat, single-occurrence keys → a tiny regex parser, no YAML dependency.
// Reads a dotted path ("spec.ecology.metal.iron") by tracking indentation.
// It used to match the leaf name anywhere in the document, which worked only
// as long as no two groups ever shared a key — an invariant nothing enforces
// and the nesting makes easy to break.
//
// Shared (2026-08-07) rather than living inside the generator screen,
// because the worldmap needs the same values and had grown its own
// bare-key regexes for them — which fell into exactly the trap described
// above: `seed:` is written INDENTED under `spec:`, so a pattern anchored at
// the line start never matched and every world silently fell back to a
// default, giving them all the same label and the same detail seed.
//
// A key may hold a "/" — an annotation key is prefixed, `casas-eternas/
// copied-from` (world/worldCopy.ts) — and a ".", as a prefix that is a
// domain does (`example.com/x`, 2026-10-16). A "." is also the separator of
// a path, so a path cannot name such a key; readRecipeMap reads it as a key
// of its map. The server's reader (internal/modules/world/save.go) takes
// the same keys.
const RECIPE_LINE = /^(\s*)([\w./-]+):\s*(.*)$/

export function readRecipeValue(text: string, path: string): string | undefined {
  const stack: { indent: number; key: string }[] = []
  for (const line of text.split('\n')) {
    const match = line.match(RECIPE_LINE)
    if (!match) continue
    const [, indentText, key, rawValue] = match
    const indent = indentText.length
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    stack.push({ indent, key })
    if (rawValue !== '' && stack.map((entry) => entry.key).join('.') === path) {
      return rawValue.replace(/^["']|["']$/g, '')
    }
  }
  return undefined
}

// The same, parsed as a number — undefined when absent or unparseable, so a
// caller can fall back to its own default without distinguishing the two.
export function readRecipeNumber(text: string, path: string): number | undefined {
  const raw = readRecipeValue(text, path)
  if (raw === undefined) return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

// Every key directly under a dotted path, with its value, in the file's order
// — a map such as `metadata.annotations`. Keys whose value is a block of
// their own are left out. Empty when the path is absent. A quoted value is
// read as yamlScalar writes it: "…" with its escapes, '…' with '' for '.
export function readRecipeMap(text: string, path: string): Record<string, string> {
  const entries: Record<string, string> = {}
  const stack: { indent: number; key: string }[] = []
  for (const line of text.split('\n')) {
    const match = line.match(RECIPE_LINE)
    if (!match) continue
    const [, indentText, key, rawValue] = match
    const indent = indentText.length
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop()
    if (rawValue !== '' && stack.map((entry) => entry.key).join('.') === path) {
      entries[key] = unquoted(rawValue)
    }
    stack.push({ indent, key })
  }
  return entries
}

// A value for a `key: value` line: as it is when YAML reads it back as the
// same string, else double-quoted (JSON's escapes, which are YAML's: `"`,
// `\`, control characters). Quoted: the empty string, a value with ": " or
// " #" or "#" in it, one that ends with ":", one with a space or a tab at
// either end, one that starts with an indicator (- ? : , [ ] { } # & * ! | >
// ' " % @ `), one with a control character, and one that YAML would read
// as another type (true, null, a number). Until 2026-10-16 annotation
// values were written as they were, so `a: b` made the file invalid.
export function yamlScalar(value: string): string {
  const needsQuotes =
    value === '' ||
    /: |#|:$|^[\s]|[\s]$|^[-?:,[\]{}&*!|>'"%@`]|[\u0000-\u001f\u007f]/.test(value) ||
    /^(true|false|yes|no|on|off|y|n|null|~)$/i.test(value) ||
    /^[-+]?(\.?\d|\.(inf|nan)$)/i.test(value)
  return needsQuotes ? JSON.stringify(value) : value
}

// A value as YAML reads it back from yamlScalar (and the plain ones as they
// are). A double-quoted value that JSON cannot read (YAML escapes beyond
// JSON's) loses its quotes only, as before.
function unquoted(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string
    } catch {
      return raw.slice(1, -1)
    }
  }
  if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1).replace(/''/g, "'")
  return raw
}
