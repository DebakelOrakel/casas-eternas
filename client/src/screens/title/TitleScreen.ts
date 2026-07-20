import { ArcRotateCamera, Color4, Scene, Vector3 } from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import './title.css'

export const createTitleScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)
  scene.clearColor = new Color4(1, 1, 1, 1)
  new ArcRotateCamera('camera', -Math.PI / 2, Math.PI / 2.5, 6, Vector3.Zero(), scene)

  const root = document.createElement('div')
  root.className = 'title-screen'
  root.innerHTML = `
    <div class="title-block">
      <h1>Casas Eternas</h1>
      <p class="subtitle">Herederos del Mundo</p>
    </div>
    <button class="text-link" data-action="worldgen">World Generation</button>
  `
  root.querySelector('[data-action="worldgen"]')!.addEventListener('click', () => {
    ctx.goTo('worldgen')
  })
  ctx.overlay.appendChild(root)

  return {
    scene,
    dispose() {
      scene.dispose()
    },
  }
}
