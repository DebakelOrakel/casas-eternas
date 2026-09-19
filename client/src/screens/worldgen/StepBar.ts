import { t, type TKey } from '../../i18n/i18n'
import '../../ui/theme/design.css'
import './stepBar.css'

// The strip along the foot of the generator: which step you are on, which are
// computed, and the way between them. From the design canvas (Main.dc.html,
// "Fussleiste: Schritte"), light theme.
//
// It REPLACES the ‹ › arrows. The arrows could only offer the next step and
// the previous one, which made the chain something you walked rather than
// something you could see; a world eight steps in looked exactly like a world
// one step in.
//
// Order here is the PIPELINE's, not the design's: the canvas draws erosion
// before climate, the way the Earth is usually told, but climate's sliders
// shape the water forcing erosion runs on (see entryRequirementUnmet in
// WorldGenScreen). The dependency is real and the drawing is not.
//
// The status line's words come from the screen. The design's third state,
// "outdated", has nothing to read yet: changing a parameter CLEARS the
// downstream stages rather than marking them, so a cleared stage and one never
// run are the same thing here. Making them different is its own step.

export interface StepBarStep {
  // A pipeline stage id. The labels are looked up as `generator.step.<id>`,
  // so a step and its wording cannot drift apart.
  id: string
  // Set apart from the chain: reachable, but not one of the steps that build
  // on each other. Migration is the only one, until it gets its own screen.
  aside?: boolean
}

export interface StepBarStepState {
  // The small line under the label. The screen supplies the words rather than
  // the bar choosing them: step 0 is "set", not "computed", and a bar that
  // hardcoded two states could never say so.
  status: string
  // Settled — the status line reads in the confirming colour and the mark is
  // outlined rather than empty.
  settled: boolean
  // Entering it is refused for now, because an earlier step has not supplied
  // what it needs.
  blocked: boolean
}

export interface StepBarState {
  current: number
  steps: readonly StepBarStepState[]
}

export interface StepBarOptions {
  steps: readonly StepBarStep[]
  // Asked for a step. The screen decides whether it happens — a blocked step
  // still reports the click, because refusing silently is how a control
  // teaches nothing.
  onSelect(index: number): void
}

export interface StepBar {
  element: HTMLElement
  setState(state: StepBarState): void
  // The step names again, in the language that is active now. The statuses
  // come with the next setState, which the screen runs on every change anyway.
  relabel(): void
  // Away while the load screen is up: that screen is about which world, not
  // about where in one. Hidden rather than covered, because both sit at the
  // same z-index and the later one in the document would otherwise win.
  setVisible(visible: boolean): void
  dispose(): void
}

export function createStepBar(host: HTMLElement, options: StepBarOptions): StepBar {
  host.classList.add('has-step-bar')

  const bar = document.createElement('nav')
  bar.className = 'step-bar design-light'

  const buttons = options.steps.map((step, index) => {
    const slot = document.createElement('div')
    slot.className = 'step-bar__slot'
    if (step.aside) slot.classList.add('step-bar__slot--aside')

    // The connector belongs to the step on its RIGHT, so the first step has
    // none and the line is never left dangling when a step is set apart.
    const line = document.createElement('span')
    line.className = 'step-bar__line'

    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'step-bar__step'
    button.dataset.help = `generator.step.${step.id}`

    const mark = document.createElement('span')
    mark.className = 'step-bar__mark mono'
    // Numbered from ZERO, because step 0 is a real step here: naming the world
    // and choosing its seed is something you do, not something that happens
    // before you start. The steps set apart get no number at all — a number
    // says "this many to go", which is a promise migration does not keep.
    mark.textContent = step.aside ? '·' : String(index)

    const text = document.createElement('span')
    text.className = 'step-bar__text'
    const label = document.createElement('span')
    label.className = 'step-bar__label'
    label.textContent = t(`generator.step.${step.id}.label` as TKey)
    const status = document.createElement('span')
    status.className = 'step-bar__status'
    text.append(label, status)

    button.append(mark, text)
    button.addEventListener('click', () => options.onSelect(index))
    slot.append(line, button)
    bar.appendChild(slot)
    return { slot, button, label, status }
  })

  function setState(state: StepBarState): void {
    buttons.forEach(({ slot, button, status }, index) => {
      const step = state.steps[index]
      if (!step) return
      const active = index === state.current
      button.setAttribute('aria-current', active ? 'step' : 'false')
      // Blocked, not disabled: a disabled button cannot be clicked and so can
      // never say why it refused. The screen answers with the reason.
      button.setAttribute('aria-disabled', String(step.blocked))
      slot.dataset.state = active ? 'active' : step.blocked ? 'blocked' : step.settled ? 'computed' : 'pending'
      status.textContent = step.status
    })
  }

  host.appendChild(bar)

  return {
    element: bar,
    setState,
    relabel() {
      buttons.forEach(({ label }, index) => {
        label.textContent = t(`generator.step.${options.steps[index].id}.label` as TKey)
      })
    },
    setVisible(visible) {
      bar.hidden = !visible
      host.classList.toggle('has-step-bar', visible)
    },
    dispose() {
      bar.remove()
      host.classList.remove('has-step-bar')
    },
  }
}
