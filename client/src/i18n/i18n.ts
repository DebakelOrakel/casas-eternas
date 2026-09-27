// Minimal i18n runtime: two catalogs (locales/en, locales/de), a language
// switch in the title bar — see docs/decisions/localization.md.
// No side effects on import: the active locale is a plain module variable that
// defaults to 'en', so importing this from a worker bundle stays inert.
import enCommon from './locales/en/common.json'
import enTitleBar from './locales/en/titlebar.json'
import enNotify from './locales/en/notify.json'
import enGenerator from './locales/en/generator.json'
import enOverlay from './locales/en/overlay.json'
import enBiome from './locales/en/biome.json'
import enResource from './locales/en/resource.json'
import enSpecies from './locales/en/species.json'
import enReadout from './locales/en/readout.json'
import deCommon from './locales/de/common.json'
import deTitleBar from './locales/de/titlebar.json'
import deNotify from './locales/de/notify.json'
import deGenerator from './locales/de/generator.json'
import deOverlay from './locales/de/overlay.json'
import deBiome from './locales/de/biome.json'
import deResource from './locales/de/resource.json'
import deSpecies from './locales/de/species.json'
import deReadout from './locales/de/readout.json'

// The area catalogs merged into one flat lookup. English is the type
// source: TKey is every key that exists, so `t('typo.key')` fails to compile.
//
// Ten catalogs, cut three ways.
//
// By SCREEN REGION. `titlebar` is the same strip on every screen and owns its
// own vocabulary. `generator` is everything that screen says — its load
// screen, its steps, the sections of its sidebar, its panels and its actions.
// It was two catalogs until 2026-09-20, `worldgen` and `generator`, which was
// one catalog and its successor rather than two areas. There was a `game`
// catalog too, holding one unreferenced action; it was removed the same day,
// because a namespace reserved for a screen nobody has written yet is a guess
// about what that screen will say.
//
// By WHAT THE STRING IS. `notify` is a line shown in the notification area;
// `readout` is a line of the map's hover readout. Each reads as a set and is
// worded against the rest of its set — which is the argument for the grouping
// INSIDE `notify`: a subject, then the case (`save.server.conflict`,
// `bake.mismatch`), so a new line is written against its siblings and not
// against the whole area. Both sets are complete as of 2026-09-20, when the
// last nine `common.notify.*` keys moved across.
//
// By VOCABULARY — one branch per member of an enum the generator computes, the
// branch named by the same id. `overlay` (a map layer, its legend included,
// which is what lets the screen derive the key from the id rather than carry a
// table of them), `biome`, `resource`, `species`.
//
// `common` is the rest: shared words and units. There used to be a `world`
// catalog as well, which collected every list of names the world has — layers,
// biomes, resources, species, readout lines, event lines. It held six unrelated
// things because each was about "the world", which is true of everything here.
// A drawer is not a namespace; it was taken apart 2026-09-20.
const en = { ...enCommon, ...enTitleBar, ...enNotify, ...enGenerator, ...enOverlay, ...enBiome, ...enResource, ...enSpecies, ...enReadout }

export type Locale = 'en' | 'de'
export type TKey = keyof typeof en

// German is complete: typing it `Record<TKey, string>` makes a missing German
// key a compile error (tsc is the completeness gate). `t()` still falls back to
// English at runtime for safety.
const de: Record<TKey, string> = { ...deCommon, ...deTitleBar, ...deNotify, ...deGenerator, ...deOverlay, ...deBiome, ...deResource, ...deSpecies, ...deReadout }

const catalogs: Partial<Record<Locale, Record<string, string>>> = { en, de }
let locale: Locale = 'en'

const STORAGE_KEY = 'ce.locale'

export function getLocale(): Locale {
  return locale
}

// Switch language and remember the choice. Touches localStorage/document, so it
// only runs when called (never on import) — worker bundles stay inert.
export function setLocale(next: Locale): void {
  locale = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // storage unavailable (private mode) — the choice still holds for this session
  }
  if (typeof document !== 'undefined') document.documentElement.lang = next
}

// Pick the startup locale: saved choice → browser preference → English. Call
// once from main.ts (not on import — see setLocale).
export function initI18n(): void {
  let initial: Locale = 'en'
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'en' || saved === 'de') initial = saved
    else if (navigator.language?.toLowerCase().startsWith('de')) initial = 'de'
  } catch {
    // ignore — fall back to English
  }
  setLocale(initial)
}

// Warn once per missing key rather than every render.
const missing = new Set<string>()

// Resolve a key in the active locale, falling back to English and then to the
// key itself (so a gap is visible, not blank). `{name}` placeholders are filled
// from `params`.
export function t(key: TKey, params?: Record<string, string | number>): string {
  const active = catalogs[locale] ?? en
  let value: string | undefined = active[key] ?? en[key]
  if (value === undefined) {
    if (!missing.has(key)) {
      console.warn(`[i18n] missing key: ${key}`)
      missing.add(key)
    }
    return key
  }
  if (params) {
    for (const name of Object.keys(params)) {
      value = value.replace(new RegExp(`\\{${name}\\}`, 'g'), String(params[name]))
    }
  }
  return value
}
