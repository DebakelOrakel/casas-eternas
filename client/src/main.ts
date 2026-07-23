import './style.css'
import { Engine } from '@babylonjs/core'
import { AppStateManager } from './app/AppStateManager'
import { createTitleScreen } from './screens/title/TitleScreen'
import { createWorldGenScreen } from './screens/worldgen/WorldGenScreen'
import { createWorldGenScreen as createWorldGenSphereScreen } from './screens/worldgen-sphere/WorldGenScreen'
import { createGameScreen } from './screens/game/GameScreen'
import { createMarsScreen } from './screens/mars/MarsScreen'

const canvas = document.querySelector<HTMLCanvasElement>('#renderCanvas')!
const overlay = document.querySelector<HTMLDivElement>('#overlay')!
const engine = new Engine(canvas, true)

const app = new AppStateManager(engine, canvas, overlay, {
  title: createTitleScreen,
  worldgen: createWorldGenScreen,
  'worldgen-sphere': createWorldGenSphereScreen,
  game: createGameScreen,
  mars: createMarsScreen,
})

app.goTo('title')

engine.runRenderLoop(() => app.render())
window.addEventListener('resize', () => engine.resize())

if (import.meta.hot) {
  import.meta.hot.accept(() => {
    window.location.reload()
  })
}
