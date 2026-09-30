import { t, type TKey } from '../../i18n/i18n'
import { formatBytes, formatWhen } from '../../ui/format'
import { hasSession } from '../../server/session'
import { deleteWorld, fetchWorld, fetchWorldPreview, listWorlds } from '../../server/worldClient'
import { browserWorldThumbnail, forgetBrowserWorld, listBrowserWorlds, openBrowserWorld } from '../../world/browserWorlds'
import '../../ui/theme/design.css'
import './worldChooser.css'
import { BROWSER_ICON, SERVER_ICON, icon } from '../chooserIcons'

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
// to. The filter narrows that; it does not switch between two lists.

export interface WorldChooserOptions {
  // The heading and the line under it. The generator's when left out.
  titleKey?: TKey
  subtitleKey?: TKey
  // The help card on a world's card, which says what opening it does: the
  // base of a `.label`/`.help` key pair, as data-help takes it. The
  // generator's when left out; null for none.
  cardHelpKey?: string | null
  // Keep the world the generator already built and get out of the way.
  // Without it (and without onPickFile) the two big choices are not shown.
  onNewWorld?(): void
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

type Where = 'browser' | 'server'
type Filter = 'all' | Where

// One row, whatever it came from. The two sources answer the same questions
// with different field names; normalising here is what lets the list sort and
// render once instead of twice.
interface Entry {
  where: Where
  uid: string
  name: string
  seed: string
  erosionRun: number
  bytes: number
  savedAt: string
}

// The time and size formatters were copied per screen once, four times over,
// on the reasoning that a screen must not reach into another screen's panel for
// a string helper. That was right about the direction and wrong about the
// remedy: they live in ui/format now, which is nobody's screen. The icons are
// shared with the artifact window (chooserIcons).

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
        <button type="button" class="wc-choice wc-choice--new" data-act="new">
          <span class="wc-choice__mark"></span>
          <span class="wc-choice__text"><span class="wc-choice__label"></span><span class="wc-choice__sub"></span></span>
        </button>
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
          <button type="button" data-filter="all" data-help="generator.load.filter.all"></button>
          <button type="button" data-filter="browser" data-help="generator.load.filter.browser"></button>
          <button type="button" data-filter="server" data-help="generator.load.filter.server"></button>
        </div>
      </div>
      <div class="wc-list" data-slot="list"></div>
      <p class="wc-foot" data-slot="foot"></p>
    </div>
  `

  const list = root.querySelector<HTMLElement>('[data-slot="list"]')!
  const foot = root.querySelector<HTMLElement>('[data-slot="foot"]')!
  const countText = root.querySelector<HTMLElement>('.wc-count')!

  const newChoice = root.querySelector<HTMLButtonElement>('[data-act="new"]')!
  const uploadChoice = root.querySelector<HTMLButtonElement>('[data-act="upload"]')!
  // The big two carry their explanation VISIBLY, in the design's subtitle line,
  // and therefore no data-help: a tooltip card repeating the sentence printed
  // under the label is noise. The `.help` key is the same string either way —
  // it is shown, not hidden.
  newChoice.querySelector('.wc-choice__mark')!.appendChild(icon('<path d="M12 5v14M5 12h14"/>'))
  uploadChoice.querySelector('.wc-choice__mark')!.appendChild(icon('<path d="M12 19V8M7 13l5-5 5 5M5 4h14"/>'))

  // Every string the frame itself holds, in one place, so saying them again in
  // another language is the same code that said them first.
  function paintStatic(): void {
    root.querySelector('.wc-title')!.textContent = t(options.titleKey ?? 'generator.load.title')
    root.querySelector('.wc-subtitle')!.textContent = t(options.subtitleKey ?? 'generator.load.subtitle')
    root.querySelector('.wc-listtitle')!.textContent = t('generator.load.existing')
    newChoice.querySelector('.wc-choice__label')!.textContent = t('generator.load.new.label')
    newChoice.querySelector('.wc-choice__sub')!.textContent = t('generator.load.new.help')
    uploadChoice.querySelector('.wc-choice__label')!.textContent = t('generator.load.upload.label')
    uploadChoice.querySelector('.wc-choice__sub')!.textContent = t('generator.load.upload.help')
    for (const button of filterButtons) {
      button.textContent = t(`generator.load.filter.${button.dataset.filter as Filter}.label` as TKey)
    }
  }

  // Neither of these closes the chooser itself. The screen does, and only once
  // it knows the world is actually there: an archive that turns out not to be
  // one must leave the list standing rather than drop you into the generator
  // with a notification and no way back.
  newChoice.addEventListener('click', () => options.onNewWorld?.())
  uploadChoice.addEventListener('click', () => options.onPickFile?.())
  newChoice.hidden = !options.onNewWorld
  uploadChoice.hidden = !options.onPickFile
  root.querySelector<HTMLElement>('.wc-choices')!.hidden = !options.onNewWorld && !options.onPickFile

  // --- filter ---------------------------------------------------------------

  let filter: Filter = 'all'

  const filterButtons = [...root.querySelectorAll<HTMLButtonElement>('[data-filter]')]
  for (const button of filterButtons) {
    const value = button.dataset.filter as Filter
    button.addEventListener('click', () => {
      if (filter === value) return
      filter = value
      paintFilter()
      paintList()
    })
  }

  function paintFilter(): void {
    for (const button of filterButtons) {
      button.setAttribute('aria-pressed', String(button.dataset.filter === filter))
    }
  }

  // --- data -----------------------------------------------------------------

  let entries: Entry[] = []
  // Null while unknown, false once the server has said no — the difference
  // between "not asked yet" and "cannot be reached", which the list has to
  // word differently.
  let serverReachable: boolean | null = null
  // What `options.openable` answered at the last reload.
  let opens: (where: Where, uid: string) => boolean = () => true

  // Every object URL this screen made, so closing it does not leave the page
  // holding thumbnails for the rest of the session.
  const objectUrls = new Set<string>()

  function releaseUrls(): void {
    for (const url of objectUrls) URL.revokeObjectURL(url)
    objectUrls.clear()
  }

  async function reload(): Promise<void> {
    // Asked together: the server list is a network round trip and the browser
    // list is not, and waiting for the slow one before showing either would
    // make a local-only user pay for a server they do not use.
    const [browser, server, openable] = await Promise.all([
      listBrowserWorlds(),
      listWorlds(),
      options.openable?.load() ?? null,
    ])
    serverReachable = server !== null
    opens = openable ?? (() => true)
    entries = [
      ...browser.map((world): Entry => ({
        where: 'browser',
        uid: world.uid,
        name: world.name,
        seed: world.seed,
        erosionRun: world.erosionRun,
        bytes: world.bytes,
        savedAt: world.savedAt,
      })),
      ...(server ?? []).map((world): Entry => ({
        where: 'server',
        uid: world.uid,
        name: world.name,
        seed: world.seed,
        erosionRun: world.erosionRun,
        bytes: world.size,
        savedAt: world.updatedAt,
      })),
    ].sort((a, b) => b.savedAt.localeCompare(a.savedAt))
    paintList()
  }

  // --- rendering ------------------------------------------------------------

  function thumbnailInto(frame: HTMLElement, entry: Entry): void {
    const source = entry.where === 'browser'
      ? openThumbnailUrl(entry.uid)
      : fetchWorldPreview(entry.uid)
    void source.then((url) => {
      if (!url) return
      objectUrls.add(url)
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

  function renderCard(entry: Entry): HTMLElement {
    const card = document.createElement('div')
    card.className = 'wc-card'

    const open = document.createElement('button')
    open.type = 'button'
    open.className = 'wc-card__open'
    const cardHelp = options.cardHelpKey === undefined ? 'generator.load.card' : options.cardHelpKey
    if (cardHelp) open.dataset.help = cardHelp

    const frame = document.createElement('span')
    frame.className = 'wc-thumb'
    thumbnailInto(frame, entry)

    const main = document.createElement('span')
    main.className = 'wc-main'

    const heading = document.createElement('span')
    heading.className = 'wc-heading'
    const name = document.createElement('span')
    name.className = 'wc-name'
    name.textContent = entry.name || entry.uid
    const seed = document.createElement('span')
    seed.className = 'wc-seed mono'
    // A world uploaded before the server mirrored the recipe's seed has none;
    // then the line simply is not there rather than reading "Seed ".
    seed.textContent = entry.seed ? `${t('titlebar.seed')} ${entry.seed}` : ''
    heading.append(name, seed)

    // The design draws "step 3/6" here. Nothing in either source knows which
    // step a world stopped at — the save records no panel — so this says the
    // one thing both sources DO carry: whether the world has been eroded, and
    // how often. An invented step number would be worse than a smaller truth.
    //
    // A world this screen cannot open says why in the same line instead.
    const openable = opens(entry.where, entry.uid)
    const progress = document.createElement('span')
    progress.className = 'wc-progress'
    const dot = document.createElement('span')
    dot.className = 'wc-dot'
    dot.dataset.state = !openable ? 'closed' : entry.erosionRun >= 1 ? 'eroded' : 'fresh'
    const progressText = document.createElement('span')
    progressText.textContent = !openable && options.openable ? t(options.openable.reasonKey)
      : entry.erosionRun >= 1 ? t('generator.load.eroded', { n: entry.erosionRun })
      : t('generator.load.notEroded')
    progress.append(dot, progressText)

    const meta = document.createElement('span')
    meta.className = 'wc-meta'
    meta.appendChild(icon(entry.where === 'server' ? SERVER_ICON : BROWSER_ICON))
    const metaText = document.createElement('span')
    metaText.textContent = [
      t(`generator.load.filter.${entry.where}.label` as TKey),
      formatBytes(entry.bytes),
      formatWhen(entry.savedAt),
    ].filter(Boolean).join(' · ')
    meta.appendChild(metaText)

    main.append(heading, progress, meta)
    open.append(frame, main)
    if (!openable) {
      open.disabled = true
      // The card's help says what a click does, and here it does nothing.
      delete open.dataset.help
      card.classList.add('wc-card--closed')
    }

    open.addEventListener('click', () => {
      void (async () => {
        open.disabled = true
        const archive = entry.where === 'browser'
          ? await openBrowserWorld(entry.uid)
          : await fetchWorld(entry.uid)
        open.disabled = false
        if (!archive) {
          setNote(t('generator.load.unavailable'))
          return
        }
        options.onOpenArchive(archive, { where: entry.where, savedAt: entry.savedAt, uid: entry.uid, name: entry.name, seed: entry.seed })
      })()
    })

    // Removal confirms IN PLACE: the first click arms the button, the second
    // within a few seconds deletes, and an accidental click disarms itself. A world is the one thing here that
    // cannot be recomputed, so it may not go on a single click — and it may
    // not need a dialog either.
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'wc-remove'
    remove.dataset.help = 'generator.load.remove'
    remove.textContent = t('generator.load.remove.label')
    let armed: ReturnType<typeof setTimeout> | undefined
    remove.addEventListener('click', () => {
      if (armed === undefined) {
        remove.textContent = t('generator.load.remove.confirm')
        remove.classList.add('wc-remove--armed')
        armed = setTimeout(() => {
          armed = undefined
          remove.textContent = t('generator.load.remove.label')
          remove.classList.remove('wc-remove--armed')
        }, 4000)
        return
      }
      clearTimeout(armed)
      armed = undefined
      void (async () => {
        remove.disabled = true
        if (entry.where === 'browser') {
          await forgetBrowserWorld(entry.uid)
        } else if (!(await deleteWorld(entry.uid))) {
          remove.disabled = false
          setNote(t('generator.load.unavailable'))
          return
        }
        await reload()
      })()
    })

    card.append(open, remove)
    return card
  }

  function setNote(text: string): void {
    const note = document.createElement('p')
    note.className = 'wc-note'
    note.textContent = text
    list.replaceChildren(note)
  }

  function paintList(): void {
    const shown = entries.filter((entry) => filter === 'all' || entry.where === filter)
    countText.textContent = t('generator.load.count', { n: shown.length, all: entries.length })
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

  function close(): void {
    root.hidden = true
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
      // The cards carry strings too, and they are rebuilt from the entries
      // already in hand — no second round trip to say the same list again.
      paintList()
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
