import { ArcRotateCamera, HemisphericLight, MeshBuilder, Scene, Vector3 } from '@babylonjs/core'
import type { Screen, ScreenContext, ScreenFactory } from '../../app/Screen'
import './game.css'

export const createGameScreen: ScreenFactory = (ctx: ScreenContext): Screen => {
  const scene = new Scene(ctx.engine)

  const camera = new ArcRotateCamera('camera', -Math.PI / 2, Math.PI / 2.5, 6, Vector3.Zero(), scene)
  camera.attachControl(ctx.canvas, true)
  new HemisphericLight('light', new Vector3(0, 1, 0), scene)
  MeshBuilder.CreateSphere('planet', { diameter: 2, segments: 32 }, scene)

  const root = document.createElement('div')
  root.className = 'game-screen'
  root.innerHTML = `<button data-action="back">Back to Title</button>`
  root.querySelector('[data-action="back"]')!.addEventListener('click', () => {
    ctx.goTo('title')
  })
  ctx.overlay.appendChild(root)

  return {
    scene,
    dispose() {
      scene.dispose()
    },
  }
}
