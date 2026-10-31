import type { LanguageDetail, LanguageLevel, LanguageView, NameEntry, NameStory } from '../../src/ui/languagePanel/languageTypes'

// THE LANGUAGES FIXTURE as a view model (ui/languagePanel/languageTypes.ts):
// languages.json, made up after the design boards (Sprachen.dc.html:
// Tavhisch, Keldisch …), for the panel before an engine makes languages.
// The incubator shows it with `?screen=incubator&languages=fixture`, and
// the harness (scripts/languageView.mjs) reads it. Browser-safe: no Node.
//
// For the compare and names tabs (TEG-141): Keldisch, Orrisch and Vellisch
// have the same meanings with their lines' sound changes, the family's
// proto-language a detail; Keldfurt has its exonyms, its story
// (`stories`, by name) and names of its pattern nearby (`cells`: where
// the named cells lie, u and v; any other cell lies where its number
// puts it).

export interface LanguageFixture {
  times: number[]
  nodes: { id: string; level: LanguageLevel; parent: string | null; name: string; proto: boolean; born: number; ended: number | null; speakers: number[]; peoples: number[] }[]
  details: Record<string, Omit<LanguageDetail, 'id'>>
  names: Record<string, NameEntry[]>
  peoples: Record<string, string>
  cells?: Record<string, [number, number]>
  stories?: Record<string, NameStory>
}

// The torus's width over its height, as the incubator's chart.
const ASPECT = 2

export function fixtureView(fixture: LanguageFixture): LanguageView {
  return {
    times: Float32Array.from(fixture.times),
    nodes: fixture.nodes.map((n) => ({ ...n, speakers: Float32Array.from(n.speakers) })),
    detail: (id) => {
      const detail = fixture.details[id]
      return detail ? { id, ...detail } : null
    },
    names: (id, from, count) => {
      const rows = fixture.names[id] ?? []
      return { total: rows.length, rows: rows.slice(from, from + count) }
    },
    namesFound: (query, year) => {
      const found = new Set<string>()
      if (!query) return found
      for (const [id, rows] of Object.entries(fixture.names)) if (rows.some((r) => r.given <= year && r.name.toLowerCase().includes(query))) found.add(id)
      return found
    },
    peopleName: (people) => fixture.peoples[String(people)] ?? String(people + 1),
    story: (entry, year) => {
      const story = fixture.stories?.[entry.name]
      return Promise.resolve(story && story.year <= year ? story : null)
    },
    cellAt: (cell) => {
      const at = fixture.cells?.[String(cell)]
      if (at) return { u: at[0], v: at[1] }
      return { u: (cell * 0.6180339887) % 1, v: (cell * 0.4142135623) % 1 }
    },
    aspect: ASPECT,
  }
}

// The fixture, loaded when asked for: it stays out of the screen's bundle.
export async function loadFixtureView(): Promise<LanguageView> {
  const fixture = (await import('./languages.json')).default as unknown as LanguageFixture
  return fixtureView(fixture)
}
