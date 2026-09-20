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
