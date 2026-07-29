// Minimal i18n runtime. English only for now; German (locales/de) and a
// title-screen language switch come later — see docs/decisions/localization.md.
// No side effects on import: the active locale is a plain module variable that
// defaults to 'en', so importing this from a worker bundle stays inert.
import enCommon from './locales/en/common.json'
import enWorld from './locales/en/world.json'
import enWorldgen from './locales/en/worldgen.json'
import enGame from './locales/en/game.json'
import deCommon from './locales/de/common.json'
import deWorld from './locales/de/world.json'
import deWorldgen from './locales/de/worldgen.json'
import deGame from './locales/de/game.json'

// The four area catalogs merged into one flat lookup. English is the type
// source: TKey is every key that exists, so `t('typo.key')` fails to compile.
const en = { ...enCommon, ...enWorld, ...enWorldgen, ...enGame }

export type Locale = 'en' | 'de'
export type TKey = keyof typeof en

// German is complete: typing it `Record<TKey, string>` makes a missing German
// key a compile error (tsc is the completeness gate). `t()` still falls back to
// English at runtime for safety.
const de: Record<TKey, string> = { ...deCommon, ...deWorld, ...deWorldgen, ...deGame }

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
