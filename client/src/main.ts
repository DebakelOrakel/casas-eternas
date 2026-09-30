import './style.css'
import { Engine } from '@babylonjs/core'
import { initI18n } from './i18n/i18n'
import { AppStateManager } from './app/AppStateManager'
import { createTitleScreen } from './screens/title/TitleScreen'
import { createGeneratorScreen } from './screens/generator/GeneratorScreen'
import { createIncubatorScreen } from './screens/incubator/IncubatorScreen'

const canvas = document.querySelector<HTMLCanvasElement>('#renderCanvas')!
const overlay = document.querySelector<HTMLDivElement>('#overlay')!
const engine = new Engine(canvas, true)

initI18n()

const app = new AppStateManager(engine, canvas, overlay, {
  title: createTitleScreen,
  generator: createGeneratorScreen,
  incubator: createIncubatorScreen,
})

app.goTo('title')

engine.runRenderLoop(() => app.render())

// Keep the render buffer matched to the canvas's actual on-screen size. A
// ResizeObserver on the canvas covers everything a `window resize` listener
// misses on mobile — orientation changes and the browser chrome showing/hiding
// (which changes 100dvh) — so the map always scales to the visible viewport.
new ResizeObserver(() => engine.resize()).observe(canvas)

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload()
  })
}
