import type { KnowledgeRamp, PigmentTuning } from '../../map/mapPresentation'
import type { TerrainWash } from '../../map/terrainPalette'
import type { WatercolorTuning } from './watercolorPass'
import './knowledgeDebug.css'

// Tuning controls for the watercolour map's knowledge registers — stage A of
// docs/design/watercolor-map.md, whose entire purpose is deciding where the
// three bands sit and how strong the pale wash is. Nobody guesses those from a
// constant file; they get dragged.
//
// DEBUG-ONLY AND BUILT TO BE DELETED, which is why its labels are hardcoded
// English rather than catalog keys: a key is a documentation anchor, and
// minting anchors for something temporary is the cost the i18n rule exists to
// avoid. When the values are frozen, this file and its stylesheet go, and
// whatever the PLAYER gets is a different, much smaller thing in different
// words — see the doc's "Player settings are not the tuning knobs".

export interface KnowledgeDebugPanelOptions {
  // Mutated in place by the sliders; the callback fires after every change.
  ramp: KnowledgeRamp
  onRampChange: () => void
  // Edge darkening, likewise mutated in place — but it repaints on the CPU, so
  // unlike the sheet it does need a callback.
  pigment: PigmentTuning
  onPigmentChange: () => void
  // The terrain palette's chroma and strength — the "make it pop" pair.
  wash: TerrainWash
  onWashChange: () => void
  // Also mutated in place — but the pass reads it per frame, so it needs no
  // callback at all. That asymmetry is the whole difference between the two
  // stages: A recomposites eight million texels on the CPU, B is a uniform.
  sheet: WatercolorTuning
  onSeed: () => void
  onClear: () => void
  onReveal: () => void
  // Brush mode takes the pointer away from the camera's pan.
  onBrushToggle: (active: boolean) => void
}

export interface KnowledgeDebugPanel {
  isBrushActive(): boolean
  // Brush radius as a fraction of world width.
  brushRadius(): number
  // The terrain raster currently feeding the presentation — the screen
  // reports the macro raster at load and each amplified tier as it lands
  // (2048 → "2K", 4096 → "4K", 8192 → "8K").
  setTerrainTier(width: number, height: number): void
  // The hex tile the hover pick currently resolves to (canonical col,row),
  // or null — a truth readout for chasing pick-vs-highlight mismatches.
  setHexTile(tile: { col: number; row: number } | null): void
  dispose(): void
}

export function createKnowledgeDebugPanel(host: HTMLElement, options: KnowledgeDebugPanelOptions): KnowledgeDebugPanel {
  const { ramp, sheet, pigment, wash, onRampChange, onPigmentChange, onWashChange, onSeed, onClear, onReveal, onBrushToggle } = options
  let brushActive = false

  const root = document.createElement('div')
  root.className = 'knowledge-debug'
  root.innerHTML = `
    <span class="knowledge-debug__status" data-status="tier">terrain: —</span>
    <span class="knowledge-debug__status" data-status="hex">hex: —</span>
    <span class="knowledge-debug__title">knowledge (debug)</span>
    <button type="button" data-action="brush">brush: off</button>
    <label>radius <input type="range" data-knob="radius" min="0.01" max="0.25" step="0.005" value="0.06" /></label>
    <label>wash <input type="range" data-knob="exploredPigment" min="0" max="1" step="0.01" /></label>
    <label>wash at k <input type="range" data-knob="exploredAt" min="0.05" max="0.95" step="0.01" /></label>
    <label>active from <input type="range" data-knob="activeFrom" min="0.05" max="0.99" step="0.01" /></label>
    <button type="button" data-action="seed">reseed</button>
    <button type="button" data-action="clear">clear</button>
    <button type="button" data-action="reveal">reveal all</button>
    <span class="knowledge-debug__title">terrain wash (debug)</span>
    <label>chroma <input type="range" data-wash="desaturate" min="-0.6" max="0.8" step="0.02" /></label>
    <label>strength <input type="range" data-wash="strength" min="0" max="1" step="0.02" /></label>
    <span class="knowledge-debug__title">pigment (debug)</span>
    <label>edge dark <input type="range" data-pigment="edgeDarkening" min="0" max="0.8" step="0.01" /></label>
    <label>edge width <input type="range" data-pigment="edgeWidth" min="1" max="10" step="1" /></label>
    <label>interior <input type="range" data-pigment="interiorEdgeScale" min="0" max="1" step="0.05" /></label>
    <span class="knowledge-debug__title">sheet (debug)</span>
    <label>fibre <input type="range" data-sheet="fibreAmount" min="0" max="0.5" step="0.005" /></label>
    <label>fibre scale <input type="range" data-sheet="fibreScale" min="100" max="3000" step="50" /></label>
    <label>granulation <input type="range" data-sheet="granulation" min="0" max="0.6" step="0.01" /></label>
    <label>spatter <input type="range" data-sheet="dropletDensity" min="0" max="260" step="5" /></label>
    <label>spatter size <input type="range" data-sheet="dropletSize" min="0.02" max="0.45" step="0.01" /></label>
    <label>frontier <input type="range" data-sheet="frontier" min="0.02" max="0.5" step="0.01" /></label>
  `
  host.appendChild(root)

  const knob = (name: string): HTMLInputElement => root.querySelector<HTMLInputElement>(`[data-knob="${name}"]`)!
  knob('exploredPigment').value = String(ramp.exploredPigment)
  knob('exploredAt').value = String(ramp.exploredAt)
  knob('activeFrom').value = String(ramp.activeFrom)
  for (const input of root.querySelectorAll<HTMLInputElement>('[data-sheet]')) {
    input.value = String(sheet[input.dataset.sheet as keyof WatercolorTuning])
  }
  for (const input of root.querySelectorAll<HTMLInputElement>('[data-pigment]')) {
    input.value = String(pigment[input.dataset.pigment as keyof PigmentTuning])
  }
  for (const input of root.querySelectorAll<HTMLInputElement>('[data-wash]')) {
    input.value = String(wash[input.dataset.wash as keyof TerrainWash])
  }

  const onInput = (event: Event): void => {
    const input = event.target as HTMLInputElement
    const sheetKnob = input.dataset.sheet
    if (sheetKnob) {
      // No callback: the pass reads these straight off the object each frame.
      sheet[sheetKnob as keyof WatercolorTuning] = Number(input.value)
      return
    }
    const washKnob = input.dataset.wash
    if (washKnob) {
      wash[washKnob as keyof TerrainWash] = Number(input.value)
      onWashChange()
      return
    }
    const pigmentKnob = input.dataset.pigment
    if (pigmentKnob) {
      pigment[pigmentKnob as keyof PigmentTuning] = Number(input.value)
      onPigmentChange()
      return
    }
    const name = input.dataset.knob
    if (!name || name === 'radius') return
    ramp[name as keyof KnowledgeRamp] = Number(input.value)
    onRampChange()
  }
  root.addEventListener('input', onInput)

  const brushButton = root.querySelector<HTMLButtonElement>('[data-action="brush"]')!
  const onClick = (event: Event): void => {
    const action = (event.target as HTMLElement).closest('button')?.dataset.action
    if (action === 'brush') {
      brushActive = !brushActive
      brushButton.textContent = `brush: ${brushActive ? 'on' : 'off'}`
      brushButton.classList.toggle('is-on', brushActive)
      onBrushToggle(brushActive)
    } else if (action === 'seed') onSeed()
    else if (action === 'clear') onClear()
    else if (action === 'reveal') onReveal()
  }
  root.addEventListener('click', onClick)

  const tierStatus = root.querySelector<HTMLSpanElement>('[data-status="tier"]')!
  const hexStatus = root.querySelector<HTMLSpanElement>('[data-status="hex"]')!

  return {
    isBrushActive: () => brushActive,
    brushRadius: () => Number(knob('radius').value),
    setTerrainTier(width: number, height: number): void {
      const label = width === 2048 ? '2K (macro)' : width === 4096 ? '4K' : width === 8192 ? '8K' : `${width}×${height}`
      tierStatus.textContent = `terrain: ${label}`
    },
    setHexTile(tile: { col: number; row: number } | null): void {
      hexStatus.textContent = tile ? `hex: ${tile.col},${tile.row}` : 'hex: —'
    },
    dispose(): void {
      root.removeEventListener('input', onInput)
      root.removeEventListener('click', onClick)
      root.remove()
    },
  }
}
