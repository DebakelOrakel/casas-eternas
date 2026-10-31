import type { LanguageDetail, LanguageLevel, LanguageView, NameEntry } from '../../src/ui/languagePanel/languageTypes'

// THE LANGUAGES FIXTURE as a view model (ui/languagePanel/languageTypes.ts):
// languages.json, made up after the design boards (Sprachen.dc.html:
// Tavhisch, Keldisch …), for the panel before an engine makes languages.
// The incubator shows it with `?screen=incubator&languages=fixture`, and
// the harness (scripts/languageView.mjs) reads it. Browser-safe: no Node.

export interface LanguageFixture {
  times: number[]
  nodes: { id: string; level: LanguageLevel; parent: string | null; name: string; proto: boolean; born: number; ended: number | null; speakers: number[]; peoples: number[] }[]
  details: Record<string, Omit<LanguageDetail, 'id'>>
  names: Record<string, NameEntry[]>
  peoples: Record<string, string>
}

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
    peopleName: (people) => fixture.peoples[String(people)] ?? String(people + 1),
  }
}

// The fixture, loaded when asked for: it stays out of the screen's bundle.
export async function loadFixtureView(): Promise<LanguageView> {
  const fixture = (await import('./languages.json')).default as unknown as LanguageFixture
  return fixtureView(fixture)
}
