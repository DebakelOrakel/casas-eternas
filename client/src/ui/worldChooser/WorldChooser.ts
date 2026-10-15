import { relabel } from '../../i18n/relabel'
import type { WorldShape } from '../../map/worldView'
import { t, type TKey } from '../../i18n/i18n'
import { formatBytes, formatWhen } from '../../ui/format'
import { hasSession } from '../../server/session'
import { deleteWorld, fetchWorld, fetchWorldPreview, listWorlds, uploadWorld, type WorldSummary } from '../../server/worldClient'
import {
  browserWorldIncomplete, browserWorldThumbnail, canKeepWorldsInBrowser, completeBrowserWorld, forgetBrowserWorld,
  keepArchiveInBrowser, listBrowserWorlds, openBrowserWorld, type BrowserWorld,
} from '../../world/browserWorlds'
import { progressPosition, progressStepOf, type ProgressStep } from '../../world/worldProgress'
import type { NotificationOptions } from '../notifications/NotificationManager'
import '../../ui/theme/design.css'
import './worldChooser.css'
import { BROWSER_ICON, FLAT_ICON, SERVER_ICON, SPHERE_ICON, icon } from '../chooserIcons'
import { cardMatches, cardOpenCopy, mergeWorldCopies, type ShapeFilter, type Where, type WhereFilter, type WorldCard, type WorldCopy } from './worldCards'

// The first screen of the generator and of the incubator: which world are we
// working on?
//
// From the "Weltgenerator" design canvas (artboard Main.dc.html, "Welt
// wählen"), light theme. It covers the screen rather than being a screen of
// its own, and that is a decision worth stating: `ctx.goTo(id)` carries no
// payload, so a separate route would first need a channel to hand the chosen
// world over. As an overlay there is nothing to hand over — "open" is the
// archive path the screen already has, "new" just closes this. The generator
// builds behind it, so its starting world is ready the moment someone asks
// for one.
//
// The generator offers every world and the two big choices (new, upload).
// The incubator leaves the choices out and opens only the worlds that hold
// level 1; the others stay in the list, marked, so that a world does not
// seem lost only because it cannot be used here yet.
//
// It shows worlds from BOTH places at once — this browser and the server —
// because "where is it kept" is a property of a world, not a place to navigate
// to. The filter narrows that; it does not switch between two lists. A world
// kept in both places is ONE card (worldCards.ts, 2026-10-11); a click on the
// card opens a small panel with the facts of each copy, and the means to
// copy a world from one place to the other. Nothing is copied by itself.

// The shapes a new world can take (docs/design/two-topologies.md). The
// sphere since 2026-10-09 with its first step only (map/sphereView.ts).
export type { WorldShape }
const SHAPES: readonly { shape: WorldShape; ready: boolean }[] = [
  { shape: 'flat', ready: true },
  { shape: 'sphere', ready: true },
]


export interface WorldChooserOptions {
  // The heading and the line under it. The generator's when left out.
  titleKey?: TKey
  subtitleKey?: TKey
  // The help card on a world's Open button, which says what opening it
  // does: the base of a `.label`/`.help` key pair, as data-help takes it.
  // The generator's when left out; null for none.
  openHelpKey?: string | null
  // Where a copy between the two places reports how it went.
  notifications: { show(options: NotificationOptions): unknown }
  // A new world of the shape picked in the choice's menu. Without it (and
  // without onPickFile) the two big choices are not shown.
  onNewWorld?(shape: WorldShape): void
  // Hands an archive over; the screen owns the loading itself. `kept`
  // says where the world rests and since when — an opened world is a saved
  // one, and the title bar says so — and which world the list meant.
  onOpenArchive(archive: Blob, kept: { where: Where; savedAt: string; uid: string; name: string; seed: string }): void
  // The plain file picker, for a world that lives in neither place.
  onPickFile?(): void
  // Which worlds may be opened here: asked at every reload, beside the two
  // lists. A world it refuses stays in the list, cannot be opened, and says
  // why with `reasonKey`. Without it every world opens.
  openable?: { load(): Promise<(where: Where, uid: string) => boolean>; reasonKey: TKey }
}

export interface WorldChooser {
  element: HTMLElement
  // Every string again, in the language that is active now. The screen holding
  // this one cannot be rebuilt on a language switch — see i18n/relabel.
  relabel(): void
  open(): void
  close(): void
  isOpen(): boolean
  dispose(): void
}

// The time and size formatters were copied per screen once, four times over,
// on the reasoning that a screen must not reach into another screen's panel for
// a string helper. That was right about the direction and wrong about the
// remedy: they live in ui/format now, which is nobody's screen. The icons are
// shared with the artifact window (chooserIcons).

// The two sources, as copies (worldCards.ts). The server's summary carries the
// kind and the progress as plain strings; they are read here, and a value this
// client does not know reads as none.
function browserCopy(world: BrowserWorld): WorldCopy {
  return {
    where: 'browser', uid: world.uid, name: world.name, seed: world.seed,
    kind: world.kind ?? null, progress: world.progress ?? null,
    bytes: world.bytes, savedAt: world.savedAt, generator: world.generator, contentHash: world.contentHash ?? '',
  }
}

function serverCopy(world: WorldSummary): WorldCopy {
  return {
    where: 'server', uid: world.uid, name: world.name, seed: world.seed ?? '',
    kind: world.kind === 'FlatWorld' || world.kind === 'SphereWorld' ? world.kind : null,
    progress: progressStepOf(world.progress),
    bytes: world.size, savedAt: world.updatedAt, generator: world.generator ?? '', contentHash: world.contentHash ?? '',
  }
}

const otherPlace = (where: Where): Where => (where === 'browser' ? 'server' : 'browser')

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(className: string, text: string): HTMLButtonElement {
  const node = el('button', className, text)
  node.type = 'button'
  return node
}

// What the list says of a world's progress (world/worldProgress.ts).
function progressText(progress: ProgressStep | null): string {
  const position = progressPosition(progress)
  if (!position) return t('generator.load.progress.none')
  if (position.done) return t('generator.load.progress.done')
  return t('generator.load.progress', { n: position.n, all: position.all, step: t(`generator.step.${progress}.label` as TKey) })
}

function progressState(progress: ProgressStep | null): 'done' | 'started' | 'none' {
  const position = progressPosition(progress)
  return !position ? 'none' : position.done ? 'done' : 'started'
}

export function createWorldChooser(host: HTMLElement, options: WorldChooserOptions): WorldChooser {
  const root = document.createElement('div')
  root.className = 'world-chooser design-light'
  root.hidden = true

  root.innerHTML = `
    <div class="wc-sheet">
      <div class="wc-head">
        <h1 class="wc-title"></h1>
        <p class="wc-subtitle"></p>
      </div>
      <div class="wc-choices">
        <div class="wc-new">
          <button type="button" class="wc-choice wc-choice--new" data-act="new" aria-haspopup="menu" aria-expanded="false">
            <span class="wc-choice__mark"></span>
            <span class="wc-choice__text"><span class="wc-choice__label"></span><span class="wc-choice__sub"></span></span>
            <span class="wc-choice__chevron"></span>
          </button>
          <div class="wc-shapes" role="menu" hidden>
            ${SHAPES.map(({ shape, ready }) => `
            <button type="button" class="wc-shape" role="menuitem" data-shape="${shape}"${ready ? '' : ' aria-disabled="true"'}>
              <span class="wc-shape__name" data-t="generator.world.topology.${shape}.label"></span>
              <span class="wc-shape__desc" data-t="generator.world.topology.${shape}.help"></span>
            </button>`).join('')}
          </div>
        </div>
        <button type="button" class="wc-choice wc-choice--upload" data-act="upload">
          <span class="wc-choice__mark"></span>
          <span class="wc-choice__text"><span class="wc-choice__label"></span><span class="wc-choice__sub"></span></span>
        </button>
      </div>
      <div class="wc-listhead">
        <h2 class="wc-listtitle"></h2>
        <span class="wc-count mono"></span>
        <span class="wc-grow"></span>
        <div class="wc-filter">
          <button type="button" data-shape-filter="anyShape" data-help="generator.load.filter.anyShape"></button>
          <button type="button" data-shape-filter="sphere" data-help="generator.load.filter.sphere"></button>
          <button type="button" data-shape-filter="flat" data-help="generator.load.filter.flat"></button>
        </div>
        <div class="wc-filter">
          <button type="button" data-filter="all" data-help="generator.load.filter.all"></button>
          <button type="button" data-filter="browser" data-help="generator.load.filter.browser"></button>
          <button type="button" data-filter="server" data-help="generator.load.filter.server"></button>
        </div>
      </div>
      <div class="wc-list" data-slot="list"></div>
      <p class="wc-foot" data-slot="foot"></p>
    </div>
    <div class="wc-detail-backdrop" hidden>
      <div class="wc-detail" role="dialog" aria-modal="true"></div>
    </div>
  `

  const list = root.querySelector<HTMLElement>('[data-slot="list"]')!
  const foot = root.querySelector<HTMLElement>('[data-slot="foot"]')!
  const countText = root.querySelector<HTMLElement>('.wc-count')!
  const detailBackdrop = root.querySelector<HTMLElement>('.wc-detail-backdrop')!
  const detail = root.querySelector<HTMLElement>('.wc-detail')!

  const newChoice = root.querySelector<HTMLButtonElement>('[data-act="new"]')!
  const uploadChoice = root.querySelector<HTMLButtonElement>('[data-act="upload"]')!
  // The big two carry their explanation VISIBLY, in the design's subtitle line,
  // and therefore no data-help: a tooltip card repeating the sentence printed
  // under the label is noise. The `.help` key is the same string either way —
  // it is shown, not hidden.
  newChoice.querySelector('.wc-choice__mark')!.appendChild(icon('<path d="M12 5v14M5 12h14"/>'))
  newChoice.querySelector('.wc-choice__chevron')!.appendChild(icon('<path d="m6 9 6 6 6-6"/>'))
  const shapeMenu = root.querySelector<HTMLElement>('.wc-shapes')!
  uploadChoice.querySelector('.wc-choice__mark')!.appendChild(icon('<path d="M12 19V8M7 13l5-5 5 5M5 4h14"/>'))

  // Every string the frame itself holds, in one place, so saying them again in
  // another language is the same code that said them first.
  function paintStatic(): void {
    root.querySelector('.wc-title')!.textContent = t(options.titleKey ?? 'generator.load.title')
    root.querySelector('.wc-subtitle')!.textContent = t(options.subtitleKey ?? 'generator.load.subtitle')
    root.querySelector('.wc-listtitle')!.textContent = t('generator.load.existing')
    newChoice.querySelector('.wc-choice__label')!.textContent = t('generator.load.new.label')
    newChoice.querySelector('.wc-choice__sub')!.textContent = t('generator.load.new.help')
    relabel(shapeMenu)
    uploadChoice.querySelector('.wc-choice__label')!.textContent = t('generator.load.upload.label')
    uploadChoice.querySelector('.wc-choice__sub')!.textContent = t('generator.load.upload.help')
    for (const button of filterButtons) {
      button.textContent = t(`generator.load.filter.${button.dataset.filter as WhereFilter}.label` as TKey)
    }
    // The two shapes say their name with the words the new world's menu uses.
    for (const button of shapeButtons) {
      const value = button.dataset.shapeFilter as ShapeFilter
      button.textContent = t(value === 'anyShape' ? 'generator.load.filter.anyShape.label' : `generator.world.topology.${value}.label`)
    }
  }

  // Neither of these closes the chooser itself. The screen does, and only once
  // it knows the world is actually there: an archive that turns out not to be
  // one must leave the list standing rather than drop you into the generator
  // with a notification and no way back.
  // The new world's shape, in a menu under the choice: the shape is set once,
  // here, and step 0 only shows it (2026-10-05).
  const closeShapes = (): void => {
    shapeMenu.hidden = true
    newChoice.setAttribute('aria-expanded', 'false')
  }
  newChoice.addEventListener('click', () => {
    const open = shapeMenu.hidden
    shapeMenu.hidden = !open
    newChoice.setAttribute('aria-expanded', String(open))
    if (open) shapeMenu.querySelector<HTMLButtonElement>('.wc-shape:not([aria-disabled])')?.focus()
  })
  for (const item of shapeMenu.querySelectorAll<HTMLButtonElement>('.wc-shape')) {
    item.addEventListener('click', () => {
      if (item.getAttribute('aria-disabled') === 'true') return
      closeShapes()
      options.onNewWorld?.(item.dataset.shape as WorldShape)
    })
  }
  root.addEventListener('pointerdown', (event) => {
    if (!shapeMenu.hidden && !(event.target as Element).closest('.wc-new')) closeShapes()
  })
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (!detailBackdrop.hidden) {
      event.stopPropagation()
      closeDetail()
    } else if (!shapeMenu.hidden) {
      event.stopPropagation()
      closeShapes()
      newChoice.focus()
    }
  })
  uploadChoice.addEventListener('click', () => options.onPickFile?.())
  newChoice.hidden = !options.onNewWorld
  uploadChoice.hidden = !options.onPickFile
  root.querySelector<HTMLElement>('.wc-choices')!.hidden = !options.onNewWorld && !options.onPickFile

  // --- filters --------------------------------------------------------------

  // Where a world is kept, and its shape. Both are held as long as this
  // chooser lives — for the screen's session — and combine.
  let filter: WhereFilter = 'all'
  let shapeFilter: ShapeFilter = 'anyShape'

  const filterButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-filter]')]
  for (const button of filterButtons) {
    const value = button.dataset.filter as WhereFilter
    button.addEventListener('click', () => {
      if (filter === value) return
      filter = value
      paintFilter()
      paintList()
    })
  }
  const shapeButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-shape-filter]')]
  for (const button of shapeButtons) {
    const value = button.dataset.shapeFilter as ShapeFilter
    button.addEventListener('click', () => {
      if (shapeFilter === value) return
      shapeFilter = value
      paintFilter()
      paintList()
    })
  }

  function paintFilter(): void {
    for (const button of filterButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.filter === filter))
    }
    for (const button of shapeButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.shapeFilter === shapeFilter))
    }
  }

  // --- data -----------------------------------------------------------------

  let browserCopies: WorldCopy[] = []
  let serverCopies: WorldCopy[] = []
  let cards: WorldCard[] = []
  // Null while unknown, false once the server has said no — the difference
  // between "not asked yet" and "cannot be reached", which the list has to
  // word differently.
  let serverReachable: boolean | null = null
  // Whether this browser can keep a world: the "copy to browser" needs it.
  let browserKeeps = false
  // What `options.openable` answered at the last reload.
  let opens: (where: Where, uid: string) => boolean = () => true
  // Counts the reloads, so the answer of an older one, arriving late, does
  // not overwrite a newer one.
  let generation = 0

  // Every object URL this screen made, so closing it does not leave the page
  // holding thumbnails for the rest of the session. The thumbnails are kept
  // by copy while the chooser is open: a filter click or a merge repaints the
  // cards, and must not fetch every server preview again.
  const objectUrls = new Set<string>()
  const thumbnails = new Map<string, Promise<string | null>>()

  function releaseUrls(): void {
    for (const url of objectUrls) URL.revokeObjectURL(url)
    objectUrls.clear()
    thumbnails.clear()
  }

  async function reload(): Promise<void> {
    const run = ++generation
    // Asked together: the server list is a network round trip and the browser
    // list is not, and waiting for the slow one before showing either would
    // make a local-only user pay for a server they do not use.
    const [browser, server, openable, keeps] = await Promise.all([
      listBrowserWorlds(),
      listWorlds(),
      options.openable?.load() ?? null,
      canKeepWorldsInBrowser(),
    ])
    if (run !== generation) return
    serverReachable = server !== null
    browserKeeps = keeps
    opens = openable ?? (() => true)
    browserCopies = browser.map(browserCopy)
    serverCopies = (server ?? []).map(serverCopy)
    remerge()
    void completeOlder(browser.filter(browserWorldIncomplete), run)
  }

  function remerge(): void {
    cards = mergeWorldCopies(browserCopies, serverCopies)
    paintList()
    paintDetail()
  }

  // A world this browser kept before its meta carried the shape and the hash
  // gets them now, once, after the list is up: it costs a read of the whole
  // archive. The cards are merged again when all are done.
  async function completeOlder(worlds: BrowserWorld[], run: number): Promise<void> {
    if (worlds.length === 0) return
    for (const world of worlds) {
      const done = await completeBrowserWorld(world.uid)
      if (run !== generation) return
      if (done) browserCopies = browserCopies.map((copy) => (copy.uid === done.uid ? browserCopy(done) : copy))
    }
    remerge()
  }

  // --- acting on a copy -----------------------------------------------------

  function thumbnailInto(frame: HTMLElement, copy: WorldCopy): void {
    const key = `${copy.where}:${copy.uid}`
    let source = thumbnails.get(key)
    if (!source) {
      source = (copy.where === 'browser' ? openThumbnailUrl(copy.uid) : fetchWorldPreview(copy.uid)).then((url) => {
        if (url) objectUrls.add(url)
        return url
      })
      thumbnails.set(key, source)
    }
    void source.then((url) => {
      if (!url) return
      const image = document.createElement('img')
      image.src = url
      image.alt = ''
      image.addEventListener('error', () => image.remove(), { once: true })
      frame.appendChild(image)
    })
  }

  async function openThumbnailUrl(uid: string): Promise<string | null> {
    const blob = await browserWorldThumbnail(uid)
    return blob ? URL.createObjectURL(blob) : null
  }

  const readArchive = (copy: WorldCopy): Promise<Blob | null> =>
    copy.where === 'browser' ? openBrowserWorld(copy.uid) : fetchWorld(copy.uid)

  async function openCopy(copy: WorldCopy, trigger: HTMLButtonElement): Promise<void> {
    trigger.disabled = true
    const archive = await readArchive(copy)
    trigger.disabled = false
    if (!archive) {
      closeDetail()
      setNote(t('generator.load.unavailable'))
      return
    }
    options.onOpenArchive(archive, { where: copy.where, savedAt: copy.savedAt, uid: copy.uid, name: copy.name, seed: copy.seed })
  }

  // Copies a world to the other place, with the save's own notifications —
  // a copy is a save of that world to there. The server's revision lock
  // holds as for any upload: a conflict is said, never overwritten.
  async function copyToOther(copy: WorldCopy): Promise<void> {
    const archive = await readArchive(copy)
    const target = otherPlace(copy.where)
    if (!archive) {
      options.notifications.show({ message: t('generator.load.unavailable'), icon: '/icons/warning.png', durationMs: 6000 })
      return
    }
    if (target === 'browser') {
      const kept = await keepArchiveInBrowser(archive, copy.savedAt)
      options.notifications.show(kept
        ? { message: t('notify.save.browser.stored'), icon: '/icons/ok.png', durationMs: 4000 }
        : { message: t('notify.save.browser.failed'), icon: '/icons/warning.png', durationMs: 8000 })
    } else {
      const outcome = await uploadWorld(copy.uid, archive)
      options.notifications.show(outcome.ok
        ? { message: t('notify.save.server.stored'), icon: '/icons/ok.png', durationMs: 4000 }
        : { message: t(outcome.reason === 'conflict' ? 'notify.save.server.conflict' : 'notify.save.server.failed'), icon: '/icons/warning.png', durationMs: 8000 })
    }
    thumbnails.delete(`${target}:${copy.uid}`)
    await reload()
  }

  async function removeCopy(copy: WorldCopy): Promise<boolean> {
    if (copy.where === 'browser') {
      await forgetBrowserWorld(copy.uid)
    } else if (!(await deleteWorld(copy.uid))) {
      closeDetail()
      setNote(t('generator.load.unavailable'))
      return false
    }
    await reload()
    return true
  }

  // A button that confirms IN PLACE: the first click arms it and says what the
  // second would do; the second within a few seconds acts, and an accidental
  // click disarms itself. For what cannot be undone — removing a world,
  // overwriting another version of it — which may not go on a single click,
  // and need not need a dialog either.
  function armedButton(className: string, labelKey: TKey, confirmKey: TKey, act: () => Promise<unknown>): HTMLButtonElement {
    const node = button(className, t(labelKey))
    let armed: ReturnType<typeof setTimeout> | undefined
    node.addEventListener('click', () => {
      if (armed === undefined) {
        node.textContent = t(confirmKey)
        node.classList.add('wc-armed')
        armed = setTimeout(() => {
          armed = undefined
          node.textContent = t(labelKey)
          node.classList.remove('wc-armed')
        }, 4000)
        return
      }
      clearTimeout(armed)
      armed = undefined
      node.disabled = true
      void act().finally(() => {
        node.disabled = false
        node.textContent = t(labelKey)
        node.classList.remove('wc-armed')
      })
    })
    return node
  }

  function openButton(copy: WorldCopy | null, className: string): HTMLButtonElement {
    const node = button(className, t('generator.load.open.label'))
    const help = options.openHelpKey === undefined ? 'generator.load.open' : options.openHelpKey
    if (!copy) {
      // Readable, not usable — and not `disabled`, which would also silence
      // the help card a caller may hang on it.
      node.setAttribute('aria-disabled', 'true')
      return node
    }
    if (help) node.dataset.help = help
    node.addEventListener('click', () => void openCopy(copy, node))
    return node
  }

  // The copy-to-the-other-place button, or null where it does not apply: the
  // other place cannot take it (no server, a browser that keeps no worlds),
  // or already holds the same bytes. Over a different version it confirms
  // first, since that version is then gone.
  function copyButton(card: WorldCard, copy: WorldCopy): HTMLButtonElement | null {
    const target = otherPlace(copy.where)
    if (target === 'server' ? serverReachable !== true : !browserKeeps) return null
    if (card.state === 'same') return null
    const base = target === 'server' ? 'generator.load.copy.toServer' : 'generator.load.copy.toBrowser'
    const label = `${base}.label` as TKey
    if (card.state === 'diverged') {
      const node = armedButton('wc-action', label, 'generator.load.copy.overwrite.confirm', () => copyToOther(copy))
      node.dataset.help = base
      return node
    }
    const node = button('wc-action', t(label))
    node.dataset.help = base
    node.addEventListener('click', () => {
      node.disabled = true
      void copyToOther(copy).finally(() => { node.disabled = false })
    })
    return node
  }

  function removeButton(copy: WorldCopy): HTMLButtonElement {
    const node = armedButton('wc-action wc-action--remove', 'generator.load.remove.label', 'generator.load.remove.confirm', () => removeCopy(copy))
    node.dataset.help = 'generator.load.remove'
    return node
  }

  // --- rendering ------------------------------------------------------------

  function shapeBadge(card: WorldCard): HTMLElement | null {
    if (!card.kind) return null
    const shape = card.kind === 'SphereWorld' ? 'sphere' : 'flat'
    const badge = el('span', 'wc-badge')
    badge.append(icon(shape === 'sphere' ? SPHERE_ICON : FLAT_ICON), el('span', '', t(`generator.world.topology.${shape}.label`)))
    return badge
  }

  // The warning that the two places hold different versions. Drawn like a
  // notification's warning: the same icon.
  function divergedBadge(): HTMLElement {
    const badge = el('span', 'wc-badge wc-badge--warn')
    badge.dataset.help = 'generator.load.diverged'
    const mark = el('img', 'wc-badge__icon')
    mark.src = '/icons/warning.png'
    mark.alt = ''
    badge.append(mark, el('span', '', t('generator.load.diverged.label')))
    return badge
  }

  function badges(card: WorldCard): HTMLElement {
    const row = el('span', 'wc-badges')
    const shape = shapeBadge(card)
    if (shape) row.append(shape)
    if (card.state === 'diverged') row.append(divergedBadge())
    return row
  }

  const whereText = (card: WorldCard): string =>
    card.browser && card.server ? t('generator.load.where.both') : t(`generator.load.filter.${card.shown.where}.label` as TKey)

  // The card says where the world is kept by its icons alone; the words are
  // the icons' names (for a screen reader and as a tooltip) and stand in the
  // detail panel.
  function whereIcons(card: WorldCard): SVGElement[] {
    const named = (path: string, where: Where): SVGElement => {
      const svg = icon(path)
      const label = t(`generator.load.filter.${where}.label` as TKey)
      svg.removeAttribute('aria-hidden')
      svg.setAttribute('role', 'img')
      svg.setAttribute('aria-label', label)
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title')
      title.textContent = label
      svg.prepend(title)
      return svg
    }
    return [card.browser ? named(BROWSER_ICON, 'browser') : null, card.server ? named(SERVER_ICON, 'server') : null].filter((x): x is SVGElement => x !== null)
  }

  // Whether any copy of the world may be opened here.
  const anyOpens = (card: WorldCard): boolean =>
    [card.browser, card.server].some((copy) => copy !== null && opens(copy.where, copy.uid))

  function renderCard(card: WorldCard): HTMLElement {
    const shown = card.shown
    const node = el('div', 'wc-card')
    if (card.state === 'diverged') node.classList.add('wc-card--diverged')
    const openable = anyOpens(card)
    if (!openable) node.classList.add('wc-card--closed')

    // The card itself opens its panel; the Open button beside it opens the
    // world. Two buttons in a div, not one in another: a button inside a
    // button is invalid.
    const info = button('wc-card__info', '')
    info.dataset.help = 'generator.load.card'
    info.addEventListener('click', () => openDetail(card.uid))

    const frame = el('span', 'wc-thumb')
    thumbnailInto(frame, shown)

    const main = el('span', 'wc-main')
    const heading = el('span', 'wc-heading')
    heading.append(el('span', 'wc-name', shown.name || shown.uid))
    // A world uploaded before the server mirrored the recipe's seed has none;
    // then the line simply is not there rather than reading "Seed ".
    if (shown.seed) heading.append(el('span', 'wc-seed mono', `${t('titlebar.seed')} ${shown.seed}`))

    // How far its user took it (world/worldProgress.ts) — or, for a world
    // this screen cannot open, why not.
    const progress = el('span', 'wc-progress')
    const dot = el('span', 'wc-dot')
    dot.dataset.state = !openable ? 'closed' : progressState(shown.progress)
    progress.append(dot, el('span', '', !openable && options.openable ? t(options.openable.reasonKey) : progressText(shown.progress)))

    const meta = el('span', 'wc-meta')
    meta.append(...whereIcons(card), el('span', '', [formatBytes(shown.bytes), formatWhen(shown.savedAt)].filter(Boolean).join(' · ')))

    main.append(heading, badges(card), progress, meta)
    info.append(frame, main)

    // Of two different versions, neither opens from here: which one is the
    // user's choice, in the panel. The button says why.
    const target = cardOpenCopy(card, opens)
    const open = openButton(target, 'wc-open')
    if (card.state === 'diverged') open.dataset.help = 'generator.load.diverged'
    node.append(info, open)
    return node
  }

  function setNote(text: string): void {
    list.replaceChildren(el('p', 'wc-note', text))
  }

  function paintList(): void {
    const shown = cards.filter((card) => cardMatches(card, filter, shapeFilter))
    countText.textContent = t('generator.load.count', { n: shown.length, all: cards.length })
    foot.textContent = hasSession() ? t('generator.load.foot.signedIn') : t('generator.load.foot.signedOut')

    if (shown.length === 0) {
      // "Nothing here" and "the server did not answer" are different facts and
      // a list that collapses them sends someone looking in the wrong place.
      // The server's silence only matters where server worlds would show.
      const missingServer = serverReachable === false && filter !== 'browser'
      setNote(missingServer ? t('generator.load.unavailable') : t('generator.load.empty'))
      return
    }
    list.replaceChildren(...shown.map(renderCard))
  }

  // --- the panel ------------------------------------------------------------

  // The world whose panel is open, by uid: the panel is painted again from the
  // cards at every merge, so a copy or a removal shows at once.
  let detailUid: string | null = null

  function openDetail(uid: string): void {
    detailUid = uid
    paintDetail()
    detailBackdrop.hidden = false
    detail.querySelector<HTMLButtonElement>('.wc-detail__close')?.focus()
  }

  function closeDetail(): void {
    detailUid = null
    detailBackdrop.hidden = true
  }

  detailBackdrop.addEventListener('click', (event) => {
    if (event.target === detailBackdrop) closeDetail()
  })

  // One fact: a term and its value; none for an empty value.
  function facts(rows: [TKey, string][]): HTMLElement {
    const dl = el('dl', 'wc-facts')
    for (const [key, value] of rows) {
      if (!value) continue
      dl.append(el('dt', '', t(key)), el('dd', '', value))
    }
    return dl
  }

  // What is true of one copy: when, by which build, how big, how far.
  const copyFacts = (copy: WorldCopy): [TKey, string][] => [
    ['generator.load.detail.progress', progressText(copy.progress)],
    ['generator.load.detail.savedAt', formatWhen(copy.savedAt)],
    ['generator.load.detail.build', copy.generator],
    ['generator.load.detail.size', formatBytes(copy.bytes)],
  ]

  function actions(card: WorldCard, copy: WorldCopy): HTMLElement {
    const row = el('div', 'wc-actions')
    row.append(openButton(opens(copy.where, copy.uid) ? copy : null, 'wc-action wc-action--open'))
    const copyNode = copyButton(card, copy)
    if (copyNode) row.append(copyNode)
    row.append(removeButton(copy))
    return row
  }

  function paintDetail(): void {
    if (detailUid === null) return
    const card = cards.find((c) => c.uid === detailUid)
    if (!card) {
      closeDetail()
      return
    }
    const shown = card.shown
    detail.setAttribute('aria-label', shown.name || shown.uid)

    const head = el('div', 'wc-detail__head')
    const frame = el('span', 'wc-thumb wc-thumb--large')
    thumbnailInto(frame, shown)
    const title = el('div', 'wc-detail__title')
    title.append(el('h2', 'wc-detail__name', shown.name || shown.uid), badges(card))
    const close = button('wc-detail__close', '')
    close.setAttribute('aria-label', t('common.action.close.label'))
    close.append(icon('<path d="M6 6l12 12M18 6 6 18"/>'))
    close.addEventListener('click', closeDetail)
    head.append(frame, title, close)

    const shape = card.kind ? t(`generator.world.topology.${card.kind === 'SphereWorld' ? 'sphere' : 'flat'}.label`) : ''
    const common: [TKey, string][] = [
      ['titlebar.seed', shown.seed],
      ['generator.load.detail.shape', shape],
      ['generator.load.detail.where', whereText(card)],
    ]

    const parts: HTMLElement[] = [head]
    if (!card.browser || !card.server) {
      parts.push(facts([...common, ...copyFacts(shown)]), actions(card, shown))
    } else {
      // Both places: the two copies side by side, each with its own facts and
      // its own buttons — of two different versions, the user picks one.
      parts.push(facts(common))
      const versions = el('div', 'wc-versions')
      for (const copy of [card.browser, card.server]) {
        const column = el('section', 'wc-version')
        const heading = el('h3', 'wc-version__title', t(copy.where === 'browser' ? 'generator.load.version.browser' : 'generator.load.version.server'))
        if (card.newer === copy.where) heading.append(el('span', 'wc-version__newer', t('generator.load.version.newer')))
        column.append(heading, facts(copyFacts(copy)), actions(card, copy))
        versions.append(column)
      }
      parts.push(versions)
    }
    detail.replaceChildren(...parts)
  }

  function close(): void {
    root.hidden = true
    closeDetail()
    releaseUrls()
  }

  paintStatic()
  paintFilter()
  paintList()
  host.appendChild(root)

  return {
    element: root,
    relabel() {
      paintStatic()
      // The cards carry strings too, and they are rebuilt from the cards
      // already in hand — no second round trip to say the same list again.
      paintList()
      paintDetail()
    },
    open() {
      root.hidden = false
      void reload()
    },
    close,
    isOpen: () => !root.hidden,
    dispose() {
      releaseUrls()
      root.remove()
    },
  }
}
