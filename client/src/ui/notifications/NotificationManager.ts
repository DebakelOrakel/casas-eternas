import './notifications.css'

export interface NotificationOptions {
  message: string
  icon?: string
  sticky?: boolean
  durationMs?: number
  // 0..1 draws a progress bar; undefined draws none.
  //
  // Undefined is a REAL state rather than a missing value: a bake running as a
  // Kubernetes Job reports only that it is pending or working, because a Job's
  // output is its pod's log and streaming that back would be a second
  // connection for a number nobody acts on. A bar stuck at zero would be a
  // worse lie than no bar at all.
  progress?: number
}

// What `update` may change. Message and progress only — an icon that moved or
// a timeout that restarted mid-notification would read as a second event.
export interface NotificationPatch {
  message?: string
  progress?: number
}

interface ActiveNotification {
  id: string
  element: HTMLElement
  textElement: HTMLElement
  timeoutId?: ReturnType<typeof setTimeout>
}

// The bar, as a real progressbar rather than a styled div: a bake runs for
// minutes, which is long enough that someone using a screen reader deserves to
// be able to ask how far along it is.
function makeProgress(fraction: number): HTMLElement {
  const track = document.createElement('div')
  track.className = 'notification-toast__progress'
  track.setAttribute('role', 'progressbar')
  track.setAttribute('aria-valuemin', '0')
  track.setAttribute('aria-valuemax', '100')
  const fill = document.createElement('div')
  fill.className = 'notification-toast__bar'
  track.appendChild(fill)
  setProgress(track, fraction)
  return track
}

function setProgress(track: HTMLElement, fraction: number): void {
  // Clamped, because the sources are not all trustworthy: a job's percent
  // comes off the wire, and a bar wider than its track would spill out of the
  // toast rather than merely look wrong.
  const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)))
  track.setAttribute('aria-valuenow', String(percent))
  const fill = track.firstElementChild as HTMLElement | null
  if (fill) fill.style.width = `${percent}%`
}

export class NotificationManager {
  private parentOverlay: HTMLElement
  private container: HTMLElement
  private activeNotifications = new Map<string, ActiveNotification>()
  private nextId = 1

  constructor(parentOverlay: HTMLElement) {
    this.parentOverlay = parentOverlay
    this.container = document.createElement('div')
    this.container.className = 'notification-container'
    this.parentOverlay.appendChild(this.container)
  }

  public ensureContainer(parentOverlay?: HTMLElement): void {
    if (parentOverlay) this.parentOverlay = parentOverlay
    if (!this.container.parentNode || this.container.parentNode !== this.parentOverlay) {
      this.container.innerHTML = ''
      this.parentOverlay.appendChild(this.container)
    }
  }

  public show(options: NotificationOptions): string {
    const id = `notif_${this.nextId++}`
    const { message, icon, sticky = false, durationMs = 5000, progress } = options

    const toast = document.createElement('div')
    toast.className = 'notification-toast'
    toast.id = id

    if (icon) {
      const img = document.createElement('img')
      img.className = 'notification-toast__icon'
      img.src = icon
      img.alt = ''
      toast.appendChild(img)
    }

    // The message is a COLUMN now, so a progress bar can sit under its own
    // text rather than beside it. The text lives in its own element because
    // setting textContent on the container would delete the bar with it —
    // which is exactly what an update does, several times a second.
    const msgDiv = document.createElement('div')
    msgDiv.className = 'notification-toast__message'
    const textDiv = document.createElement('span')
    textDiv.className = 'notification-toast__text'
    textDiv.textContent = message
    msgDiv.appendChild(textDiv)
    if (progress !== undefined) msgDiv.appendChild(makeProgress(progress))
    toast.appendChild(msgDiv)

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'notification-toast__close'
    closeBtn.setAttribute('aria-label', 'Dismiss')
    closeBtn.innerHTML = '&times;'
    closeBtn.addEventListener('click', () => this.dismiss(id))
    toast.appendChild(closeBtn)

    this.container.appendChild(toast)

    const notifObj: ActiveNotification = {
      id,
      element: toast,
      textElement: textDiv,
    }

    if (!sticky) {
      notifObj.timeoutId = setTimeout(() => {
        this.dismiss(id)
      }, durationMs)
    }

    this.activeNotifications.set(id, notifObj)
    return id
  }

  // Change a notification in place.
  //
  // The alternative — dismiss and show again — is what makes a progress
  // readout flash and re-animate on every tick, and it would also lose its
  // place in the stack. Silently ignores an unknown id: a caller following
  // something slow may well outlive the toast a user dismissed by hand, and
  // that is not an error worth handling at every call site.
  public update(id: string, patch: NotificationPatch): void {
    const notif = this.activeNotifications.get(id)
    if (!notif) return

    if (patch.message !== undefined) notif.textElement.textContent = patch.message
    if (patch.progress === undefined) return

    const message = notif.element.querySelector('.notification-toast__message')
    if (!message) return
    let bar = message.querySelector<HTMLElement>('.notification-toast__progress')
    // Created on first use rather than up front, so a notification that only
    // LATER learns a percentage still gets one — and one that never does keeps
    // an empty row out of its layout.
    if (!bar) {
      bar = makeProgress(patch.progress)
      message.appendChild(bar)
      return
    }
    setProgress(bar, patch.progress)
  }

  public dismiss(id: string): void {
    const notif = this.activeNotifications.get(id)
    if (!notif) return

    if (notif.timeoutId !== undefined) {
      clearTimeout(notif.timeoutId)
    }

    this.activeNotifications.delete(id)
    notif.element.classList.add('toast--dismissing')
    setTimeout(() => {
      if (notif.element.parentNode) {
        notif.element.parentNode.removeChild(notif.element)
      }
    }, 350)
  }

  public clearAll(): void {
    for (const notif of this.activeNotifications.values()) {
      if (notif.timeoutId !== undefined) {
        clearTimeout(notif.timeoutId)
      }
    }
    this.activeNotifications.clear()
    this.container.innerHTML = ''
  }
}
