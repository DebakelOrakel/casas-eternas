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
// copied-from` (world/worldCopy.ts) — but never a ".", the path separator.
// The server's reader (internal/modules/world/save.go) takes the same keys.
const RECIPE_LINE = /^(\s*)([\w/-]+):\s*(.*)$/

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
// their own are left out. Empty when the path is absent.
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
      entries[key] = rawValue.replace(/^["']|["']$/g, '')
    }
    stack.push({ indent, key })
  }
  return entries
}
