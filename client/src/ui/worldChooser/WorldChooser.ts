import { relabel } from '../../i18n/relabel'
import type { WorldShape } from '../../map/worldView'
import { t, type TKey } from '../../i18n/i18n'
import { formatBytes, formatWhen } from '../../ui/format'
import { downloadBlob } from '../../ui/download'
import { hasSession, needsSignIn } from '../../server/session'
import {
  copyWorldOnServer, deleteWorld, fetchWorld, fetchWorldPreview, listWorlds, setWorldTemplate, setWorldVisibility, uploadWorld,
  WORLD_VISIBILITIES, type WorldSummary,
} from '../../server/worldClient'
import { newWorldUid } from '../../world/identity'
import { copyArchive } from '../../world/worldCopy'
import {
  browserWorldIncomplete, browserWorldThumbnail, canKeepWorldsInBrowser, completeBrowserWorld, forgetBrowserWorld,
  keepArchiveInBrowser, listBrowserWorlds, openBrowserWorld, type BrowserWorld,
} from '../../world/browserWorlds'
import { COUNTED_STEPS, PROGRESS_STEPS, progressPosition, progressStepOf, type ProgressStep } from '../../world/worldProgress'
import { levelPipelineVersion } from '../../world/levels'
import { listServerArtifactLevels, type ServerArtifactLevel } from '../../server/artifactsClient'
import type { NotificationOptions } from '../notifications/NotificationManager'
import '../../ui/theme/design.css'
import './worldChooser.css'
// The rows of the title bar's save menu, for the two places a copy can go.
import '../titleBar/saveMenu.css'
import { BROWSER_ICON, FLAT_ICON, SERVER_ICON, SPHERE_ICON, icon } from '../chooserIcons'
import {
  cardMatches, cardOpenCopy, foreignTemplate, mergeWorldCopies, type ShapeFilter, type Where, type WhereFilter, type WorldCard, type WorldCopy,
} from './worldCards'

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
// card opens its panel (design canvas, Welt-Laden.dc.html, 2026-10-17): the
// two copies in one table, the means to copy a world from one place to the
// other, one choice of the copy to load and one button that loads it, the
// server's settings, and the download and the removals at the foot. Nothing
// is copied by itself.
//
// TEMPLATES (docs/decisions/template-worlds.md, 2026-10-15) are server worlds
// an admin offers to everyone, signed in or not. They carry a badge, have a
// value of their own in the place filter, and someone else's template is not
// opened but copied: "Make a copy" asks where the copy goes, with the save
// menu's own two rows (titlebar.save.browser / .server). The copy is a new
// world with a new uid (world/worldCopy.ts). An admin marks a server world as
// a template, or removes the mark, in its panel.

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
    bytes: world.bytes, savedAt: world.savedAt, pipeline: world.pipeline ?? '', terrain: world.terrain ?? '', contentHash: world.contentHash ?? '',
    template: false, actions: [], visibility: '',
  }
}

function serverCopy(world: WorldSummary): WorldCopy {
  return {
    where: 'server', uid: world.uid, name: world.name, seed: world.seed ?? '',
    kind: world.kind === 'FlatWorld' || world.kind === 'SphereWorld' ? world.kind : null,
    progress: progressStepOf(world.progress),
    bytes: world.size, savedAt: world.updatedAt, pipeline: world.pipeline ?? '', terrain: world.terrain ?? '', contentHash: world.contentHash ?? '',
    template: world.template ?? false, actions: world.actions ?? [], visibility: world.visibility ?? '',
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

// The levels on the server per terrain, as far as they are current for
// this client (world/levels.ts): a level counts when it has its whole level
// or at least one tile under the version this client reads it with. Read
// live at every list, so what was deleted or evicted meanwhile no longer
// shows.
function currentLevels(levels: ServerArtifactLevel[]): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  for (const level of levels) {
    if (level.pipelineVersion !== levelPipelineVersion(level.level, level.tiles)) continue
    let set = out.get(level.worldId)
    if (!set) out.set(level.worldId, (set = new Set()))
    set.add(level.level)
  }
  return out
}

// The levels the badges name.
const SHOWN_LEVELS = [1, 2, 3]

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
          <button type="button" data-filter="template" data-help="generator.load.template.filter"></button>
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
      const value = button.dataset.filter as WhereFilter
      button.textContent = t(value === 'template' ? 'generator.load.template.filter.label' : `generator.load.filter.${value}.label` as TKey)
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
  // The one copy menu of a template that is open, if any (copyMenu below):
  // closed by a click elsewhere and by Escape, like the shapes.
  let openCopyMenu: HTMLElement | null = null
  root.addEventListener('pointerdown', (event) => {
    if (!shapeMenu.hidden && !(event.target as Element).closest('.wc-new')) closeShapes()
    if (openCopyMenu && !openCopyMenu.contains(event.target as Node)) closeCopyMenu()
  })
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (openCopyMenu) {
      event.stopPropagation()
      closeCopyMenu()
    } else if (!detailBackdrop.hidden) {
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
  // The current levels per terrain (currentLevels), from the last list.
  let levelsByTerrain = new Map<string, Set<number>>()
  // Whether this browser can keep a world: the "copy to browser" needs it.
  let browserKeeps = false
  // Whether a sign-in stands between this browser and the server: a copy
  // ON the server needs one, a copy of a template into the browser does not.
  let signInMissing = false
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
    const [browser, server, openable, keeps, signIn, levels] = await Promise.all([
      listBrowserWorlds(),
      listWorlds(),
      options.openable?.load() ?? null,
      canKeepWorldsInBrowser(),
      needsSignIn(),
      listServerArtifactLevels(),
    ])
    if (run !== generation) return
    levelsByTerrain = currentLevels(levels?.levels ?? [])
    serverReachable = server !== null
    browserKeeps = keeps
    signInMissing = signIn
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

  function openButton(copy: WorldCopy | null, className: string, labelKey: TKey = 'generator.load.open.label'): HTMLButtonElement {
    const node = button(className, t(labelKey))
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

  // The copy-to-the-other-place button, drawn like a "Load from" choice: the
  // direction, and under it what the copy would do. Greyed out where it does
  // not apply: no copy to copy, the other place cannot take it (no server,
  // no sign-in, a browser that keeps no worlds), someone else's template, or
  // the other place already holds the same bytes. Over a different version
  // it confirms in place first, since that version is then gone: the line
  // under the direction asks.
  function copyButton(card: WorldCard, from: Where): HTMLButtonElement {
    const copy = from === 'browser' ? card.browser : card.server
    const target = otherPlace(from)
    const base = target === 'server' ? 'generator.load.copy.toServer' : 'generator.load.copy.toBrowser'
    const subText = !copy ? ''
      : card.state === 'single' ? t(`${base}.only.sub` as TKey, { size: formatBytes(copy.bytes) })
      : card.state === 'same' ? t(`${base}.same` as TKey)
      : t(`${base}.${card.newer === from ? 'newer' : card.newer === target ? 'older' : 'replace'}` as TKey)
    const node = button('wc-from__item wc-copy-dir', '')
    const sub = el('span', 'wc-from__sub', subText)
    node.append(el('span', 'wc-from__label', t(`${base}.direction` as TKey)), sub)
    const takes = target === 'server' ? serverReachable === true && !signInMissing : browserKeeps
    if (!copy || !takes || foreignTemplate(copy) || card.state === 'same') {
      node.setAttribute('aria-disabled', 'true')
      return node
    }
    node.dataset.help = base
    let armed: ReturnType<typeof setTimeout> | undefined
    const disarm = (): void => {
      clearTimeout(armed)
      armed = undefined
      sub.textContent = subText
      node.classList.remove('wc-armed')
    }
    node.addEventListener('click', () => {
      if (card.state === 'diverged' && armed === undefined) {
        sub.textContent = t('generator.load.copy.overwrite.confirm')
        node.classList.add('wc-armed')
        armed = setTimeout(disarm, 4000)
        return
      }
      disarm()
      node.disabled = true
      void copyToOther(copy).finally(() => { node.disabled = false })
    })
    return node
  }

  // --- templates ------------------------------------------------------------

  // A copy of a server world, kept where the user chose, with the save's own
  // notifications — a copy is a save of a new world to there. In the browser
  // it is made here from the fetched archive; on the server the server makes
  // it and nothing travels.
  async function copyInto(target: Where, source: WorldCopy): Promise<void> {
    if (target === 'browser') {
      const archive = await fetchWorld(source.uid)
      if (!archive) {
        options.notifications.show({ message: t('notify.copy.fetchFailed'), icon: '/icons/warning.png', durationMs: 6000 })
        return
      }
      const copy = await copyArchive(archive, newWorldUid(), source.uid)
      const kept = copy !== null && (await keepArchiveInBrowser(copy, new Date().toISOString()))
      options.notifications.show(kept
        ? { message: t('notify.save.browser.stored'), icon: '/icons/ok.png', durationMs: 4000 }
        : { message: t('notify.save.browser.failed'), icon: '/icons/warning.png', durationMs: 8000 })
    } else {
      const made = await copyWorldOnServer(source.uid)
      options.notifications.show(made
        ? { message: t('notify.save.server.stored'), icon: '/icons/ok.png', durationMs: 4000 }
        : { message: t('notify.save.server.failed'), icon: '/icons/warning.png', durationMs: 8000 })
    }
    await reload()
  }

  function closeCopyMenu(): void {
    if (!openCopyMenu) return
    openCopyMenu.querySelector<HTMLElement>('.save-menu__list')!.hidden = true
    openCopyMenu.querySelector('.wc-copy__button')!.setAttribute('aria-expanded', 'false')
    openCopyMenu = null
  }

  // "Make a copy", and under it the places a copy can go: the save menu's
  // rows, with its words (titlebar.save.*) and its marks. A place this
  // browser or this deployment does not have is not offered; the server
  // without a sign-in is offered, readable and not usable, and says why.
  function copyMenu(source: WorldCopy, className: string): HTMLElement {
    const host = el('div', 'wc-copy')
    const trigger = button(`${className} wc-copy__button`, t('generator.load.template.copy.label'))
    trigger.dataset.help = 'generator.load.template.copy'
    trigger.setAttribute('aria-haspopup', 'menu')
    trigger.setAttribute('aria-expanded', 'false')
    const list = el('div', 'save-menu__list')
    list.setAttribute('role', 'menu')
    list.hidden = true
    const places: { where: Where; shown: boolean; mark: string }[] = [
      { where: 'browser', shown: browserKeeps, mark: BROWSER_ICON },
      { where: 'server', shown: serverReachable === true, mark: SERVER_ICON },
    ]
    for (const place of places) {
      if (!place.shown) continue
      const blocked = place.where === 'server' && signInMissing
      const item = button('save-menu__item', '')
      item.setAttribute('role', 'menuitem')
      item.dataset.help = `titlebar.save.${place.where}`
      if (blocked) item.setAttribute('aria-disabled', 'true')
      const mark = el('span', 'save-menu__mark')
      mark.append(icon(place.mark))
      const text = el('span', 'save-menu__text')
      text.append(
        el('span', 'save-menu__label', t(`titlebar.save.${place.where}.label`)),
        el('span', 'save-menu__sub', t(place.where === 'browser' ? 'titlebar.save.browser.sub' : blocked ? 'titlebar.save.server.sub.out' : 'titlebar.save.server.sub.in')),
      )
      item.append(mark, text)
      item.addEventListener('click', () => {
        if (blocked) return
        closeCopyMenu()
        trigger.disabled = true
        void copyInto(place.where, source).finally(() => { trigger.disabled = false })
      })
      list.append(item)
    }
    trigger.addEventListener('click', () => {
      const opening = list.hidden
      closeCopyMenu()
      if (!opening) return
      list.hidden = false
      trigger.setAttribute('aria-expanded', 'true')
      openCopyMenu = host
    })
    host.append(trigger, list)
    return host
  }

  // An admin's mark on a server world, as a switch (world.template). The
  // world's content does not change. Without a copy it is drawn, not usable.
  function templateSwitch(copy: WorldCopy | null): HTMLElement {
    const label = el('label', 'wc-switch')
    const input = el('input', 'wc-switch__input')
    input.type = 'checkbox'
    input.checked = copy?.template ?? false
    input.disabled = !copy?.actions.includes('world.template')
    label.dataset.help = copy?.template ? 'generator.load.template.unmark' : 'generator.load.template.mark'
    input.addEventListener('change', () => {
      if (!copy) return
      input.disabled = true
      void setWorldTemplate(copy.uid, input.checked).then(async (done) => {
        if (!done) {
          closeDetail()
          setNote(t('generator.load.template.failed'))
          return
        }
        await reload()
      })
    })
    label.append(input, el('span', '', t('generator.load.template.badge.label')))
    return label
  }

  // Who reads a server copy: three buttons, usable by whoever may share the
  // world (world.share). Public is the admin's (world.publish), greyed out
  // for the owner, so the help card can say what the choice is. Without a
  // copy it is drawn, not usable.
  function visibilityControl(copy: WorldCopy | null): HTMLElement {
    const group = el('div', 'wc-filter')
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', t('generator.load.visibility.label'))
    const shares = copy?.actions.includes('world.share') ?? false
    for (const value of WORLD_VISIBILITIES) {
      const node = button('', t(`generator.load.visibility.${value}.label`))
      node.dataset.help = 'generator.load.visibility'
      node.setAttribute('aria-pressed', String((copy?.visibility || 'private') === value))
      node.disabled = !shares || (value === 'public' && !copy!.actions.includes('world.publish'))
      node.addEventListener('click', () => {
        if (!copy || copy.visibility === value) return
        for (const other of group.querySelectorAll('button')) other.disabled = true
        void setWorldVisibility(copy.uid, value).then(async (done) => {
          if (!done) {
            closeDetail()
            setNote(t('generator.load.visibility.failed'))
            return
          }
          await reload()
        })
      })
      group.append(node)
    }
    return group
  }

  // Removing the copy of one place, confirmed in place. Drawn, not usable,
  // where that place holds none or the caller may not delete it.
  function removeLink(where: Where, copy: WorldCopy | null): HTMLButtonElement {
    const labelKey = where === 'browser' ? 'generator.load.remove.browser.label' : 'generator.load.remove.server.label'
    const className = `wc-link${where === 'server' ? ' wc-link--danger' : ''}`
    const allowed = copy !== null && (where === 'browser' || copy.actions.includes('world.delete'))
    if (!allowed) {
      const node = button(className, t(labelKey))
      node.setAttribute('aria-disabled', 'true')
      return node
    }
    const node = armedButton(className, labelKey, 'generator.load.remove.confirm', () => removeCopy(copy))
    node.dataset.help = 'generator.load.remove'
    return node
  }

  function downloadLink(copy: WorldCopy): HTMLButtonElement {
    const node = button('wc-link', t('generator.load.download.label'))
    node.addEventListener('click', () => {
      node.disabled = true
      void readArchive(copy).then((archive) => {
        if (!archive) {
          options.notifications.show({ message: t('generator.load.unavailable'), icon: '/icons/warning.png', durationMs: 6000 })
          return
        }
        downloadBlob(archive, `${(copy.name || copy.seed || 'world').replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`)
      }).finally(() => { node.disabled = false })
    })
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
    if (card.template) {
      const template = el('span', 'wc-badge', t('generator.load.template.badge.label'))
      template.dataset.help = 'generator.load.template.badge'
      row.append(template)
    }
    if (card.state === 'diverged') row.append(divergedBadge())
    return row
  }

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

  // The card's badges for how far it was taken: the counted steps as their
  // numbers, on when accepted (the save's), and the levels its terrain has
  // on the server (the artifact store's, read live).
  function stageMarks(card: WorldCard): HTMLElement {
    const row = el('span', 'wc-stages')
    const position = progressPosition(card.shown.progress)
    const reached = position ? position.n : 0
    for (let n = 1; n <= COUNTED_STEPS; n++) {
      const mark = el('span', n <= reached ? 'wc-stage wc-stage--on' : 'wc-stage', String(n))
      mark.dataset.help = `generator.step.${PROGRESS_STEPS[n]}`
      row.append(mark)
    }
    const terrain = card.shown.terrain || card.server?.terrain || card.browser?.terrain || ''
    const held = levelsByTerrain.get(terrain)
    for (const level of SHOWN_LEVELS) row.append(el('span', held?.has(level) ? 'wc-stage wc-stage--level wc-stage--on' : 'wc-stage wc-stage--level', `L${level}`))
    return row
  }

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
    if (!openable && options.openable) {
      const dot = el('span', 'wc-dot')
      dot.dataset.state = 'closed'
      progress.append(dot, el('span', '', t(options.openable.reasonKey)))
    } else {
      progress.append(stageMarks(card))
    }

    const meta = el('span', 'wc-meta')
    meta.append(...whereIcons(card), el('span', '', [formatBytes(shown.bytes), formatWhen(shown.savedAt)].filter(Boolean).join(' · ')))

    main.append(heading, badges(card), progress, meta)
    info.append(frame, main)

    // Of two different versions, neither opens from here: which one is the
    // user's choice, in the panel. The button says why.
    // Someone else's template is copied, not opened.
    const target = cardOpenCopy(card, opens)
    if (!target && foreignTemplate(card.server)) {
      node.append(info, copyMenu(card.server!, 'wc-open'))
      return node
    }
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
  // The copy the panel loads (its "Load from"), null for the default: the
  // newer of two, the browser's of two same copies.
  let loadFrom: Where | null = null

  function openDetail(uid: string): void {
    detailUid = uid
    loadFrom = null
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

  // A copy the panel may load: there, not someone else's template (that one
  // is copied), and opened by this screen.
  const loadable = (copy: WorldCopy | null): copy is WorldCopy =>
    copy !== null && !foreignTemplate(copy) && opens(copy.where, copy.uid)

  const copyOf = (card: WorldCard, where: Where): WorldCopy | null => (where === 'browser' ? card.browser : card.server)

  function section(labelKey: TKey | null, ...body: HTMLElement[]): HTMLElement {
    const node = el('div', 'wc-section')
    if (labelKey) node.append(el('span', 'wc-section__label mono', t(labelKey)))
    node.append(...body)
    return node
  }

  function panelHead(card: WorldCard): HTMLElement {
    const shown = card.shown
    const head = el('div', 'wc-detail__head')
    const frame = el('span', 'wc-thumb wc-thumb--large')
    thumbnailInto(frame, shown)
    const title = el('div', 'wc-detail__title')
    title.append(el('h2', 'wc-detail__name', shown.name || shown.uid), badges(card))
    if (shown.seed) title.append(el('span', 'wc-seed mono', `${t('titlebar.seed')} ${shown.seed}`))
    const progress = el('span', 'wc-detail__progress')
    progress.append(stageMarks(card), el('span', '', progressText(shown.progress)))
    title.append(progress)
    const close = button('wc-detail__close', '')
    close.setAttribute('aria-label', t('common.action.close.label'))
    close.append(icon('<path d="M6 6l12 12M18 6 6 18"/>'))
    close.addEventListener('click', closeDetail)
    head.append(frame, title, close)
    return head
  }

  // The two copies side by side: what is true of each, a dash where a place
  // holds none.
  function copiesTable(card: WorldCard): HTMLElement {
    const table = el('table', 'wc-copies')
    const head = el('tr', '')
    head.append(el('th', 'mono', t('generator.load.copies')))
    for (const where of ['browser', 'server'] as const) {
      const cell = el('th', '')
      cell.scope = 'col'
      cell.append(icon(where === 'browser' ? BROWSER_ICON : SERVER_ICON), el('span', '', t(`generator.load.version.${where}`)))
      head.append(cell)
    }
    const rows: [TKey, (copy: WorldCopy) => string][] = [
      ['generator.load.detail.progress', (copy) => progressText(copy.progress)],
      ['generator.load.detail.savedAt', (copy) => formatWhen(copy.savedAt)],
      ['generator.load.detail.pipeline', (copy) => copy.pipeline],
      ['generator.load.detail.size', (copy) => formatBytes(copy.bytes)],
    ]
    const body = el('tbody', '')
    for (const [key, value] of rows) {
      const row = el('tr', '')
      const term = el('th', '', t(key))
      term.scope = 'row'
      row.append(term)
      for (const copy of [card.browser, card.server]) row.append(el('td', 'mono', (copy && value(copy)) || '—'))
      body.append(row)
    }
    const thead = el('thead', '')
    thead.append(head)
    table.append(thead, body)
    return table
  }

  // "Load from": one choice per place, a place without a loadable copy
  // drawn, not usable.
  function loadFromChoice(card: WorldCard, chosen: Where | null): HTMLElement {
    const row = el('div', 'wc-from')
    for (const where of ['browser', 'server'] as const) {
      const copy = copyOf(card, where)
      const node = button('wc-from__item', '')
      node.setAttribute('aria-pressed', String(chosen === where))
      node.append(el('span', 'wc-from__label', t(`generator.load.version.${where}`)), el('span', 'wc-from__sub mono', copy ? formatWhen(copy.savedAt) : '—'))
      if (!loadable(copy)) {
        node.setAttribute('aria-disabled', 'true')
      } else {
        node.addEventListener('click', () => {
          if (loadFrom === where) return
          loadFrom = where
          paintDetail()
        })
      }
      row.append(node)
    }
    return row
  }

  // The server's settings of the world: who reads it, and the template
  // mark. Drawn, not usable, for a world the server does not hold.
  function serverSettings(card: WorldCard): HTMLElement | null {
    const copy = card.server
    if (copy ? !copy.actions.some((a) => a === 'world.share' || a === 'world.template') : serverReachable !== true) return null
    const row = el('div', 'wc-server')
    if (!copy) row.classList.add('wc-server--absent')
    row.append(visibilityControl(copy), templateSwitch(copy))
    return section('generator.load.server.section', row)
  }

  function paintDetail(): void {
    if (detailUid === null) return
    const card = cards.find((c) => c.uid === detailUid)
    if (!card) {
      closeDetail()
      return
    }
    detail.setAttribute('aria-label', card.shown.name || card.shown.uid)
    const parts: HTMLElement[] = [panelHead(card)]

    if (card.state === 'diverged') {
      const note = el('p', 'wc-detail__note')
      const mark = el('img', 'wc-badge__icon')
      mark.src = '/icons/warning.png'
      mark.alt = ''
      const key: TKey = card.newer === 'server' ? 'generator.load.diverged.serverNewer' : card.newer === 'browser' ? 'generator.load.diverged.browserNewer' : 'generator.load.diverged.help'
      note.append(mark, el('span', '', t(key)))
      parts.push(note)
    }

    parts.push(copiesTable(card))

    // Copying between the two places, and a template's copy as a new world.
    const copying = el('div', 'wc-from')
    copying.append(copyButton(card, 'browser'), copyButton(card, 'server'))
    const foreign = foreignTemplate(card.server)
    const copyBody: HTMLElement[] = [copying]
    if (card.server?.template && !foreign) {
      const row = el('div', 'wc-actions')
      row.append(copyMenu(card.server, 'wc-action'))
      copyBody.push(row)
    }
    parts.push(section('generator.load.copy.section', ...copyBody))

    // Which copy loads, and the one button that loads it.
    const fallback: Where | null = loadable(copyOf(card, card.newer ?? 'browser'))
      ? card.newer ?? 'browser'
      : loadable(copyOf(card, card.newer === 'server' ? 'browser' : 'server')) ? (card.newer === 'server' ? 'browser' : 'server') : null
    const chosen = loadFrom && loadable(copyOf(card, loadFrom)) ? loadFrom : fallback
    if (chosen === null && foreign) {
      const main = copyMenu(card.server!, 'wc-action wc-action--open wc-detail__main')
      parts.push(main)
    } else {
      parts.push(section('generator.load.from.label', loadFromChoice(card, chosen)))
      const labelKey: TKey = card.state !== 'diverged' ? 'generator.load.open.label'
        : chosen === 'server' ? 'generator.load.open.fromServer.label' : 'generator.load.open.fromBrowser.label'
      const main = openButton(chosen ? copyOf(card, chosen) : null, 'wc-action wc-action--open wc-detail__main', labelKey)
      parts.push(main)
    }

    const settings = serverSettings(card)
    if (settings) parts.push(settings)

    const foot = el('div', 'wc-detail__foot')
    foot.append(downloadLink(chosen ? copyOf(card, chosen)! : card.shown), el('span', 'wc-grow'), removeLink('browser', card.browser))
    if (card.server || serverReachable === true) foot.append(removeLink('server', card.server))
    parts.push(foot)

    detail.replaceChildren(...parts)
  }

  function close(): void {
    root.hidden = true
    closeCopyMenu()
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
