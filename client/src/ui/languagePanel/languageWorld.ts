import { t, type TKey } from '../../i18n/i18n'
import { formatCount } from '../format'
import { button, el, nodeName } from './languageDom'
import type { LanguageNode, LanguageView, NameEntry } from './languageTypes'

// THE WORLD SIDE of one language (LanguagePanel.ts): where it is spoken,
// by whom, and the names given in it. The full layout's right column; the
// narrow layout shows its first two parts under the overview (the names are
// the full view's).

// How many peoples show before the "more" row, and how many names at first.
const FIRST_PEOPLES = 3
export const FIRST_NAMES = 3
// How many more names "show all" shows at a time: a language has thousands.
export const NAMES_PAGE = 50
// How many exonyms a name's line shows; an ellipsis for the rest.
export const EXONYMS_SHOWN = 6

export interface WorldState {
  view: LanguageView
  node: LanguageNode
  // The time shown: the names given by then, in their form of then.
  year: number
  peoplesWhole: boolean
  namesShown: number
}

export interface WorldActions {
  showOnMap(target: { language: string } | { cell: number }): void
  peoplesWhole(): void
  moreNames(): void
}

function section(titleKey: TKey, fullOnly = false): { element: HTMLElement; body: HTMLElement } {
  const element = el('section', `language-world__section${fullOnly ? ' language-panel__full-only' : ''}`)
  const body = el('div', 'language-world__body')
  element.append(el('h3', 'language-world__heading', t(titleKey)), body)
  return { element, body }
}

// A name's other names on one line, with no words of the interface (the
// names and the languages' names are the world's content): its older
// names, each "formerly name (language)", the latest first; then what other
// languages call it, "language: name"; " · " between two.
function otherNames(entry: NameEntry, languageName: (id: string) => string): string {
  const older = (entry.older ?? []).map((o) => `${t('language.world.formerly', { name: o.name })} (${languageName(o.language)})`)
  const exonyms = entry.exonyms ?? []
  const shown = exonyms.slice(0, EXONYMS_SHOWN).map((o) => t('language.world.calledBy', { language: languageName(o.language), name: o.name }))
  if (exonyms.length > EXONYMS_SHOWN) shown.push('…')
  return [older.join(' · '), shown.join(' · ')].filter((x) => x !== '').join('   ')
}

export function renderWorld(state: WorldState, actions: WorldActions): HTMLElement {
  const { view, node } = state
  const root = el('div', 'language-world')

  const spread = el('section', 'language-world__section')
  spread.append(el('h3', 'language-world__heading language-panel__full-only', t('language.world.spread')))
  spread.append(button('language-world__link', t('language.world.showOnMap'), () => actions.showOnMap({ language: node.id })))
  root.append(spread)

  if (node.peoples.length > 0) {
    const { element, body } = section('language.world.peoples')
    const all = state.peoplesWhole || node.peoples.length <= FIRST_PEOPLES + 1
    for (const people of all ? node.peoples : node.peoples.slice(0, FIRST_PEOPLES)) body.append(el('div', 'language-world__people', view.peopleName(people)))
    if (!all) body.append(button('language-world__link', t('language.world.morePeoples', { count: node.peoples.length - FIRST_PEOPLES }), actions.peoplesWhole))
    root.append(element)
  }

  const names = view.names(node.id, 0, state.namesShown, state.year)
  const byId = new Map(view.nodes.map((n) => [n.id, n]))
  const languageName = (id: string): string => {
    const n = byId.get(id)
    return n ? nodeName(n) : ''
  }
  if (names.total > 0) {
    const { element, body } = section('language.world.names', true)
    for (const entry of names.rows) {
      const line = el('button', 'language-world__name')
      line.type = 'button'
      line.addEventListener('click', () => actions.showOnMap({ cell: entry.cell }))
      const text = el('span', 'language-world__name-text', entry.name)
      const others = otherNames(entry, languageName)
      if (others) text.append(el('span', 'language-world__name-other', others))
      line.append(text, el('span', 'language-world__name-kind', t(`language.place.${entry.kind}` as TKey)))
      body.append(line)
    }
    const rest = names.total - names.rows.length
    if (rest > 0) {
      const foot = el('div', 'language-world__foot')
      foot.append(el('span', 'language-world__rest', t('language.world.moreNames', { count: formatCount(rest) })), button('language-world__link', t('language.world.showAll'), actions.moreNames))
      body.append(foot)
    }
    root.append(element)
  }
  return root
}
