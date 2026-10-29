import type { TerrainFeature } from './terrainFeatures'

// The volcanoes a world currently shows, distilled from its terrain features.
//
// The map's markers (the volcano overlay), not the ecology's: the ecology reads
// its own list in the engine (tectonics/volcanoes.rs ecology_volcanoes, DEC-0053,
// 2026-10-29) — every active arc, not one per ARC_MARKER_CELL, and the extinct arcs
// for the copper. Until then it read this one, and the marker grid, a display rule,
// thinned the copper's arcs.
export interface Volcano {
  x: number
  y: number
  thickness: number
  kind: 'hotspot' | 'flood' | 'arc'
}

// World-cell size for grid-thinning the volcanic-arc markers: a long subduction zone
// has one range feature every ~312 km (the engine's MERGE_RADIUS_M), so hundreds accumulate — one
// (tallest) cone per this-size cell keeps the arc reading as a dotted chain without
// flooding the marker layer. Hotspots/flood basalts are few, so they're never thinned.
const ARC_MARKER_CELL = 60

// Volcanic markers for the mantle overlay: hotspot cones (plateB -1) + flood-basalt
// provinces (plateB -2), both always shown, plus ACTIVE volcanic arcs (subduction/
// island arcs still being fed at their boundary — epochsSinceDeposit small — with real
// relief), grid-thinned so a busy world doesn't send thousands. See TerrainFeature.volcanic.
export function collectVolcanoes(features: TerrainFeature[]): Volcano[] {
  const out: Volcano[] = []
  const arcByCell = new Map<number, TerrainFeature>()
  for (const f of features) {
    if (f.plateB === -1) out.push({ x: f.x, y: f.y, thickness: Math.abs(f.thickness), kind: 'hotspot' })
    else if (f.plateB === -2) out.push({ x: f.x, y: f.y, thickness: Math.abs(f.thickness), kind: 'flood' })
    else if (f.volcanic && f.epochsSinceDeposit < 8 && Math.abs(f.thickness) > 3) {
      const key = Math.floor(f.y / ARC_MARKER_CELL) * 100000 + Math.floor(f.x / ARC_MARKER_CELL)
      const cur = arcByCell.get(key)
      if (!cur || Math.abs(f.thickness) > Math.abs(cur.thickness)) arcByCell.set(key, f)
    }
  }
  for (const f of arcByCell.values()) out.push({ x: f.x, y: f.y, thickness: Math.abs(f.thickness), kind: 'arc' })
  return out
}
