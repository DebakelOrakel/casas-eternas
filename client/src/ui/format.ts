import { getLocale } from '../i18n/i18n'

// How this program writes a quantity that is not a world's own — a time, a file
// size. World quantities (a metre, a °C, a rainfall) belong to the readout and
// the catalogs, because each is a sentence with a unit in it; these are the few
// values that are the SAME wherever they appear and are written by nobody in
// particular.
//
// It exists because the same formatter had been written four times over: the
// title bar, the save menu, the load window and the world chooser each carried
// their own `formatWhen`, three of them character-for-character. Four copies of
// one decision cannot stay one decision.

// A moment, absolutely and in the reader's locale.
//
// Deliberately absolute where the design draws "2 min ago": one more way to
// write a time is one more thing to keep consistent, and the relative form
// would have to re-render on a timer to stay true.
//
// Takes a `Date` or an ISO string, because the callers hold both — a title bar
// that was handed a moment, and a list that was handed a record. An unparseable
// string is an empty string, not an "Invalid Date" in the middle of a row.
export function formatWhen(at: Date | string): string {
  const date = typeof at === 'string' ? new Date(at) : at
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(getLocale(), { dateStyle: 'medium', timeStyle: 'short' })
}

// A moment as a clock time, the date only when it is not today — the jobs
// window's start and end, which are mostly within the hour.
export function formatClock(at: Date | string): string {
  const date = typeof at === 'string' ? new Date(at) : at
  if (Number.isNaN(date.getTime())) return ''
  const today = new Date()
  if (date.toDateString() !== today.toDateString()) return formatWhen(date)
  return date.toLocaleTimeString(getLocale(), { timeStyle: 'short' })
}

// A length of time, to the two largest units: "2 h 28 min", "45 min",
// "30 s". The units are the SI symbols, the same in every language.
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const min = Math.round(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  return min % 60 === 0 ? `${h} h` : `${h} h ${min % 60} min`
}

// A file size, counted in thousands.
//
// DECIMAL, not binary: a kB is 1000 bytes here, because that is what a disk, a
// browser quota and a server's own report all mean by it, and a number the
// reader can check against another tool beats one that is 2.4% smaller for a
// reason only the program knows. Decided 2026-09-20, when three formatters were
// found disagreeing — two binary, one decimal.
//
// Never below 1 kB: a cached world is never truly 0, and a row reading "0 kB"
// looks like a broken entry rather than a small one.
export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} kB`
}

// A month and its year — since when an account exists.
export function formatMonth(at: Date | string): string {
  const date = typeof at === 'string' ? new Date(at) : at
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(getLocale(), { month: 'long', year: 'numeric' })
}

// A name's initials, where there is no picture: one word gives its first two
// letters, more give the first and the last word's first.
export function initialsOf(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return [...parts[0]].slice(0, 2).join('').toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}
