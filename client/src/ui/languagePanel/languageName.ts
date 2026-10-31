import { t, type TKey } from '../../i18n/i18n'
import { button, el, nodeName, yearNumber } from './languageDom'
import { samePatternNearby, type LanguageIndex, type LanguageNode, type LanguageView, type NameEntry, type NameStory } from './languageTypes'

// ONE NAME (LanguagePanel.ts, TEG-141): the names tab, after the design
// canvas (Sprachen.dc.html D, Sprachen-Voll.dc.html "Namen"). Who gave it
// and when; its parts (each word with its meaning and its role); its form
// over time, each later form with the rules of the sound changes that made
// it (the kit's notation, no sentence); its older names and what the
// neighbours call it, each with how it came; names of the same pattern
// nearby (the same head word in the family, the nearest on the torus).
// With no name chosen, the names of the language selected to choose from.

// How many names of the same pattern show, and how many names to choose
// from.
const NEARBY = 3
const PICK = 12

export interface NameState {
  view: LanguageView
  index: LanguageIndex
  year: number
  // The name chosen in its form of `year`, and the family's names then
  // (the candidates nearby); null: none chosen, or not given by then.
  name: NameEntry | null
  family: readonly NameEntry[]
  // Its story; null while it is asked for, or where there is none.
  story: NameStory | null
  // The node selected, for the names to choose from.
  selected: LanguageNode | null
}

export interface NameActions {
  choose(entry: NameEntry): void
  showOnMap(cell: number): void
}

function section(titleKey: TKey): { element: HTMLElement; body: HTMLElement } {
  const element = el('section', 'language-overview__section')
  const body = el('div', 'language-overview__body')
  element.append(el('h3', 'language-overview__heading', t(titleKey)), body)
  return { element, body }
}

// A row of three: the form (mono), what it is, an aside.
function line(form: string, what: string, aside = ''): HTMLElement {
  const row = el('div', 'language-name__row')
  row.append(el('span', 'language-name__form', form), el('span', 'language-name__what', what), el('span', 'language-name__aside', aside))
  return row
}

export function renderName(state: NameState, actions: NameActions): HTMLElement {
  const { view, index, name } = state
  const root = el('div', 'language-overview language-name')
  const languageName = (id: string): string => {
    const n = index.byId.get(id)
    return n ? nodeName(n) : ''
  }

  if (!name) {
    root.append(el('p', 'language-panel__hint', t('language.name.empty')))
    if (state.selected) {
      const pick = el('div', 'language-overview__body')
      for (const entry of view.names(state.selected.id, 0, PICK, state.year).rows) {
        const row = el('button', 'language-world__name')
        row.type = 'button'
        row.addEventListener('click', () => actions.choose(entry))
        row.append(el('span', 'language-world__name-text', entry.name), el('span', 'language-world__name-kind', t(`language.place.${entry.kind}` as TKey)))
        pick.append(row)
      }
      root.append(pick)
    }
    return root
  }

  // THE HEAD: the name, its kind, who gave it and when.
  const title = el('div', 'language-overview__title')
  title.append(el('h2', 'language-overview__name', name.name), el('span', 'language-overview__tag', t(`language.place.${name.kind}` as TKey)))
  root.append(title)
  const namer = index.byId.get(name.language)
  const people = namer && namer.peoples.length > 0 ? view.peopleName(namer.peoples[0]) : namer ? nodeName(namer) : ''
  root.append(el('p', 'language-overview__line', t('language.name.given', { people, year: yearNumber(name.given) })))

  const story = state.story
  // ITS PARTS.
  if (story && story.parts.length > 0) {
    const parts = el('div', 'language-overview__body')
    for (const part of story.parts) {
      parts.append(line(part.spelt, part.meaning ? t(`language.meaning.${part.meaning}` as TKey) : '', t(`language.name.part.${part.role}` as TKey)))
    }
    root.append(parts)
  }

  // ITS FORM OVER TIME: as given, each later form with its rules, and as
  // spelt now.
  if (story && story.steps.length > 0) {
    const { element, body } = section('language.name.forms')
    story.steps.forEach((step, k) => {
      const row = el('div', 'language-name__step')
      row.append(el('span', 'language-overview__year', yearNumber(step.year)), el('span', 'language-name__form', step.form))
      row.append(el('span', k === 0 ? 'language-name__what' : 'language-name__what language-overview__rule', k === 0 ? t('language.name.first', { language: languageName(story.language) }) : step.rules.join(' · ')))
      body.append(row)
    })
    const now = el('div', 'language-name__step language-name__step--now')
    now.append(el('span', 'language-overview__year', yearNumber(state.year)), el('span', 'language-name__form', name.name), el('span', 'language-name__what', t('language.name.today')))
    body.append(now)
    root.append(element)
  }

  // ITS OLDER NAMES, and what the neighbours call it.
  if (name.older && name.older.length > 0) {
    const { element, body } = section('language.name.older')
    for (const o of name.older) body.append(line(o.name, languageName(o.language), o.how ? t(`language.name.how.${o.how}` as TKey) : ''))
    root.append(element)
  }
  if (name.exonyms && name.exonyms.length > 0) {
    const { element, body } = section('language.name.others')
    for (const o of name.exonyms) body.append(line(o.name, languageName(o.language), o.how ? t(`language.name.how.${o.how}` as TKey) : ''))
    root.append(element)
  }

  // THE SAME PATTERN NEARBY.
  const nearby = samePatternNearby(name, state.family, view.cellAt?.bind(view), view.aspect ?? 1, NEARBY)
  if (nearby.length > 0) {
    const { element, body } = section('language.name.nearby')
    const chips = el('div', 'language-overview__chips')
    for (const entry of nearby) chips.append(button('language-overview__chip language-overview__chip--form language-name__chip', entry.name, () => actions.choose(entry)))
    body.append(chips)
    root.append(element)
  }
  root.append(button('language-world__link', t('language.world.showOnMap'), () => actions.showOnMap(name.cell)))
  return root
}
