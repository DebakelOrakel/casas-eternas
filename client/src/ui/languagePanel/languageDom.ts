import { getLocale, t } from '../../i18n/i18n'
import { formatCount } from '../format'
import type { LanguageNode } from './languageTypes'

// What the languages panel's parts (the tree, the overview, the world side)
// share: an element maker and the ways a node, a year and a count are written.

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag)
  made.className = className
  if (text !== undefined) made.textContent = text
  return made
}

export function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const made = el('button', className, text)
  made.type = 'button'
  made.addEventListener('click', onClick)
  return made
}

// A node's name as the panel writes it: a family's root language with the
// catalog's prefix ("Proto-…"); the name itself is the world's.
export function nodeName(node: LanguageNode): string {
  return node.proto ? t('language.tree.proto', { name: node.name }) : node.name
}

// A year as a number alone ("−6 400"), and as "Year …" (the chronicle's).
export const yearNumber = (year: number): string => Math.round(year).toLocaleString(getLocale())
export const yearText = (year: number): string => t('incubator.chronicle.year', { year: yearNumber(year) })

// The speakers of a node at a time sample.
export const speakersText = (node: LanguageNode, sample: number): string => formatCount(Math.round(node.speakers[sample] ?? 0))

// The mark of the panel's head: the design canvas's own (Sprachen.dc.html),
// a stroke on a 24 grid as the title bar's marks.
export const LANGUAGES_ICON = '<path d="M5 7h9M9 7v10M7 17h5"/><path d="M14 20l4-10 4 10M15.4 17h5.2"/>'

export function iconOf(paths: string, size = 16): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = paths
  return svg
}
