import { metersToElevation, ABYSSAL_FLOOR } from '../elevation/elevationScale'
import { toroidalDistanceSq } from '../core/toroidal'

// THE SAMPLE WORLD'S FALLBACK — a fixed terrain the Planet step shows its
// controls on before any world exists: three continents, a coastal range
// across the westerlies (the rain shadow), an island arc in the trades.
// Deterministic, no simulation, the same on every screen; the climate chain
// runs on it as it runs on a real world, so what the overlays show is the
// model, not a sketch of it. Once a world has plates the step shows that
// world instead. Since 2026-09-27 the screen hands the worker a real world
// for this (public/sample/, scripts/sampleWorld.mjs), and this one stands in
// where that file is missing or fails to load — and in the harnesses.
export function sampleWorldElevation(width: number, height: number): Float32Array {
  const out = new Float32Array(width * height).fill(ABYSSAL_FLOOR)
  // Continents as smooth domes: centre (fractions of the map), radius
  // (fraction of the width), height (metres at the crown).
  const domes: [number, number, number, number][] = [
    [0.28, 0.42, 0.13, 900], // a mid-latitude continent under the westerlies
    [0.66, 0.60, 0.11, 700], // a tropical continent, monsoon coasts
    [0.82, 0.24, 0.07, 500], // a small northern continent
  ]
  // A range along a continent's west coast, across the westerlies.
  const ridge = { x: 0.20, y0: 0.32, y1: 0.52, halfWidth: 0.012, heightM: 3200 }
  const arc: [number, number][] = [[0.48, 0.72], [0.52, 0.74], [0.56, 0.75], [0.60, 0.75]]
  const shelfM = -140
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let hM = -Infinity
      for (const [cx, cy, r, top] of domes) {
        const d = Math.sqrt(toroidalDistanceSq(x, y, cx * width, cy * height, width, height)) / (r * width)
        // Land inside the dome, a shelf just outside it.
        const h = d < 1 ? top * (1 - d * d) + 60 : d < 1.15 ? shelfM : -Infinity
        if (h > hM) hM = h
      }
      if (y / height >= ridge.y0 && y / height <= ridge.y1) {
        const dx = Math.abs(x / width - ridge.x)
        const across = Math.min(dx, 1 - dx) / ridge.halfWidth
        if (across < 1) hM = Math.max(hM, ridge.heightM * (1 - across * across) + 300)
      }
      for (const [ax, ay] of arc) {
        const d = Math.sqrt(toroidalDistanceSq(x, y, ax * width, ay * height, width, height)) / (0.012 * width)
        if (d < 1) hM = Math.max(hM, 800 * (1 - d * d) + 40)
      }
      if (hM > -Infinity) out[y * width + x] = metersToElevation(hM)
    }
  }
  return out
}
