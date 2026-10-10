import { RIVER_MAX_WIDTH, RIVER_MIN_WIDTH } from '../generator/surface/hydrology'

// THE RIVERS' WIDTH AND PRESENCE RULES, shared by the flat map's ribbons
// (ToroidalRibbonOverlay.ts) and the globe's (globeRibbons.ts): pure
// arithmetic, no scene, so a script can check it (scripts/globeWater.mjs).
// Moved out of ToroidalRibbonOverlay.ts on 2026-10-10, unchanged.

// The rivers' ink, 0..255: the legend's swatch (GeneratorScreen) is the same.
export const RIVER_RGB = [45, 95, 175] as const

// --- the width rule ---------------------------------------------------------
//
// Every ribbon vertex derives TWO half-widths (plus its relative discharge,
// for the presence rule below) from the stored cartographic width, and the
// vertex shader takes the max per frame (RibbonWidthMaterialPlugin):
//
// - a PHYSICAL width in world units — what the river would measure on the
//   ground. Wins near the ground, where a map line would read as a flood.
// - a CARTOGRAPHIC width in SCREEN pixels — how wide the line draws on a
//   map, whatever the zoom. Wins in the map regime, where even the largest
//   river's physical width is subpixel.
//
// This replaces three stepped zoom profiles that scaled world-fixed widths
// down per relief level. Each step REDUCED the on-screen width at the moment
// it fired (measured: 0.80 px → 0.40 px across the first boundary), and
// between the steps small rivers spent the whole middle zoom band under one
// pixel. A screen floor is the thing a world-fixed width cannot express,
// whatever it is multiplied by — and with the floor in the shader, zoom
// changes no geometry at all.

// Physical scale: the world's largest river reads ~3 km wide near its mouth
// (Amazon-class lower courses run 2–5 km); width falls with √discharge below
// that, floored at what the channel threshold's smallest basins (Moselle
// scale) plausibly measure.
export const RIVER_PHYSICAL_MAX_M = 3000
export const RIVER_PHYSICAL_MIN_M = 80

// Cartographic scale: the line hierarchy on the map, in pixels. The top end
// matches what the old flat profile drew at far zoom (~6.6 px for the
// biggest river); the bottom stays a resolvable line under MSAA.
export const RIBBON_CARTO_MAX_PX = 6
export const RIBBON_CARTO_MIN_PX = 1.1

// Where a stored width sits between the hydrology's min and max — i.e. the
// √ of discharge relative to the world's biggest river.
export const relativeWidth = (widthPx: number): number =>
  Math.min(1, Math.max(0, (widthPx - RIVER_MIN_WIDTH) / (RIVER_MAX_WIDTH - RIVER_MIN_WIDTH)))

// The full PHYSICAL width in metres and the full CARTOGRAPHIC width in
// pixels of a stored width — the two the width rule takes the larger of.
// Both shapes take them from here, so a river is as wide on the globe as on
// the flat map at the same discharge.
export const riverWidthMetres = (widthPx: number): number =>
  Math.max(RIVER_PHYSICAL_MIN_M, relativeWidth(widthPx) * RIVER_PHYSICAL_MAX_M)
export const riverCartoPx = (widthPx: number): number =>
  RIBBON_CARTO_MIN_PX + relativeWidth(widthPx) * (RIBBON_CARTO_MAX_PX - RIBBON_CARTO_MIN_PX)

// --- the presence rule (zoom-Q filter) --------------------------------------
//
// An 8K bake's network is legitimately ~5× the macro network's total line
// length (measured on world 558937267: 30.4 vs 5.9 world-widths of
// centerline) — the channel threshold is a cell count on purpose, so a finer
// grid resolves more tributaries. Drawn in full at every zoom, that reads as
// "far too many rivers": the cartographic pixel floor above hands even the
// smallest rill a resolvable line. Width already follows zoom; PRESENCE is
// what this rule adds.
//
// The rule: the screen gets a constant ink budget. On-screen line length is
// (network length above the threshold) × z × renderWidth, where z is the
// visible fraction of the world's width — so holding visual density constant
// means a drawn-length target of INK / z, and the per-frame threshold is that
// target pushed through the inverse of the network's own length-vs-discharge
// distribution (the histogram below, rebuilt with the geometry). Anchoring
// INK at the macro network's total keeps a freshly loaded world unfiltered
// (its budget exceeds its total at every zoom, threshold 0), while an 8K
// network thins to the same far-zoom look — the two nets are near-identical
// above r≈0.15 (8K 3.84 vs macro 3.67 world-widths at r≥0.15), so what
// remains is the SAME major-river map, and the tributaries surface as the
// budget grows on the way down (full 8K detail from z≈0.2).
//
// Threshold r is √ of discharge relative to the network's biggest river —
// the same value the width rules key on, carried per vertex; the shader
// tapers a band below the threshold instead of cutting (see
// RibbonWidthMaterialPlugin), so tips grow out of their trunks smoothly.
export const FULL_VIEW_INK_WORLD_WIDTHS = 6
export const INK_BINS = 200

// The presence threshold for a view: the smallest r whose remaining drawn
// length fits the ink budget, `inkByBin` the drawn length per bin in
// world-widths and `z` the visible fraction of the world's width. A 200-bin
// top-down scan per frame — noise next to the scene's own per-frame work.
export function presenceThreshold(inkByBin: Float64Array, z: number): number {
  const budget = FULL_VIEW_INK_WORLD_WIDTHS / Math.min(1, Math.max(1e-6, z))
  let acc = 0
  for (let b = INK_BINS - 1; b >= 0; b--) {
    acc += inkByBin[b]
    if (acc > budget) return (b + 1) / INK_BINS
  }
  return 0
}

// Catmull-Rom subdivisions per input span — turns the D8 cell-to-cell staircase
// into a smooth curve.
export const SUBDIV = 5

export function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
}
