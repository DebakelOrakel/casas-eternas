import { t, type TKey } from './i18n'

// Re-reads the strings in a piece of markup in the language that is active NOW.
//
// Markup written as a template literal calls `t()` once, when the screen is
// built. That is correct for a screen you leave and come back to, and wrong for
// the generator, which you enter once and stay in: switching the language there
// must not rebuild the screen, because rebuilding it throws away an unsaved
// world. So the string has to be found again in place.
//
// The key stays on the element that shows it, which is the same bargain
// `data-help` already makes: one attribute, and the element remains the single
// place that says which string it is. `data-t` replaces the element's text, so
// use it only where the element holds nothing else.
export function relabel(root: ParentNode): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-t]')) {
    el.textContent = t(el.dataset.t as TKey)
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-t-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.tAria as TKey))
  }
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-t-placeholder]')) {
    el.placeholder = t(el.dataset.tPlaceholder as TKey)
  }
}
