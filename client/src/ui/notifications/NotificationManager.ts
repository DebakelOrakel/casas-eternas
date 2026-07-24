import './notifications.css'

export interface NotificationOptions {
  message: string
  icon?: string
  sticky?: boolean
  durationMs?: number
}

interface ActiveNotification {
  id: string
  element: HTMLElement
  timeoutId?: ReturnType<typeof setTimeout>
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
    const { message, icon, sticky = false, durationMs = 5000 } = options

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

    const msgDiv = document.createElement('div')
    msgDiv.className = 'notification-toast__message'
    msgDiv.textContent = message
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
    }

    if (!sticky) {
      notifObj.timeoutId = setTimeout(() => {
        this.dismiss(id)
      }, durationMs)
    }

    this.activeNotifications.set(id, notifObj)
    return id
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
