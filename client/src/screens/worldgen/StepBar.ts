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
// Status is two-valued for now — computed or not. The design's third state,
// "outdated", has nothing to read: changing a parameter CLEARS the downstream
// stages rather than marking them, so a cleared stage and one never run are
// the same thing here. Making them different is its own step.

export interface StepBarStep {
  // A pipeline stage id. The labels are looked up as `generator.step.<id>`,
  // so a step and its wording cannot drift apart.
  id: string
  // Set apart from the chain: reachable, but not one of the steps that build
  // on each other. Migration is the only one, until it gets its own screen.
  aside?: boolean
}

export interface StepBarState {
  current: number
  // Per step, in the same order: has it been computed, and is entering it
  // blocked by an unmet requirement.
  computed: readonly boolean[]
  blocked: readonly boolean[]
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
    // Numbered from one, and the steps set apart get no number: a number says
    // "this many to go", which is a promise the migration step does not keep.
    mark.textContent = step.aside ? '·' : String(index + 1)

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
    return { slot, button, status }
  })

  function setState(state: StepBarState): void {
    buttons.forEach(({ slot, button, status }, index) => {
      const active = index === state.current
      const computed = state.computed[index] === true
      const blocked = state.blocked[index] === true
      button.setAttribute('aria-current', active ? 'step' : 'false')
      // Blocked, not disabled: a disabled button cannot be clicked and so can
      // never say why it refused. The screen answers with the reason.
      button.setAttribute('aria-disabled', String(blocked))
      slot.dataset.state = active ? 'active' : blocked ? 'blocked' : computed ? 'computed' : 'pending'
      status.textContent = t(computed ? 'generator.step.status.computed' : 'generator.step.status.pending')
    })
  }

  host.appendChild(bar)

  return {
    element: bar,
    setState,
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
