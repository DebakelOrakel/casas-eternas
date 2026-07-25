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
    <!-- <div class="title-block">
      <h1>Casas Eternas</h1>
      <p class="subtitle">Herederos del Mundo</p>
    </div> -->
    <section class="mission">
      <h2 class="mission-title">Mission Statement</h2>
      <ul class="mission-list">
        <li>Deterministic, seeded — flat-torus world</li>
        <li>Plate tectonics: Voronoi plates, Euler-pole motion, seafloor spreading &amp; ocean age</li>
        <li>Continental crust as metaball rafts: accretion, collision, supercontinent cycles</li>
        <li>Erosion: hybrid stream-power (MFD drainage area, D8 incision) + thermal talus, priority-flood pit filling</li>
        <li>Climate: latitudinal temperature + elevation lapse rate</li>
        <li>Prescribed three-cell winds (Hadley / Ferrel / Polar)</li>
        <li>Ocean gyres from wind-stress curl (streamfunction) → sea-surface temperature</li>
        <li>Precipitation: moisture advection + orographic rain shadow</li>
        <li>Seasonality from continentality (distance-to-ocean)</li>
        <li>Whittaker biome classification</li>
        <li>Rivers: precipitation-weighted D8 discharge, spline-smoothed</li>
        <li>Endorheic lakes: inflow vs. evaporation balance</li>
        <li>Riparian zones green the biomes (Nile effect)</li>
        <li>Watercolour relief rendering, scene-space vector rivers, toggleable overlays</li>
        <li class="backlog">To do: Tectonic rift lakes (Baikal-type) — the big dramatic lakes</li>
        <li class="backlog">To do: Sharper valleys via Braun–Willett erosion (implicit, O(n))</li>
        <li class="backlog">To do: Evolving plate motion via a mantle field → realistic supercontinent breakup</li>
        <li class="backlog">To do: Volcanism — arcs, hotspot chains, flood basalts (from the mantle field)</li>
        <li class="backlog">To do: Tune lake abundance, riparian strength, river-density default</li>
        <li class="backlog">To do: Combined biome + rivers view in one panel</li>
        <li class="backlog">To do: On-demand / hex-tile fine hydrology (creeks are sub-grid at ~8 km/cell)</li>
        <li class="backlog">To do: Render-perf pass: cache ridged field + domain warp, GPU compute</li>
        <li class="backlog">To do: Firefox nested-worker regression (un-nest the render pool)</li>
        <li class="backlog">To do: Seasonal precipitation / monsoons</li>
        <li class="backlog">To do: Gain back my sanity</li>
      </ul>
    </section>
    <nav class="title-nav">
      <button class="text-link" data-action="worldgen">Hacedor del Mundo</button>
      <div class="title-nav-row">
        <button class="text-link" data-action="worldgen-sphere">Sphere</button>
        <button class="text-link" data-action="mars">Mars</button>
      </div>
    </nav>
  `
  root.querySelector('[data-action="worldgen"]')!.addEventListener('click', () => {
    ctx.goTo('worldgen')
  })
  root.querySelector('[data-action="worldgen-sphere"]')!.addEventListener('click', () => {
    ctx.goTo('worldgen-sphere')
  })
  root.querySelector('[data-action="mars"]')!.addEventListener('click', () => {
    ctx.goTo('mars')
  })
  ctx.overlay.appendChild(root)

  return {
    scene,
    dispose() {
      scene.dispose()
    },
  }
}
