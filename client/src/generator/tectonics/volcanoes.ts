import type { TerrainFeature } from './terrainFeatures'

// The volcanoes a world currently shows, distilled from its terrain features.
//
// Lives here rather than inside the worker because it is not worker-only knowledge:
// the Ecology layer reads this list for copper (arcs), obsidian and the volcanic
// province, and the golden harness has to build the very same list or it tests the
// ecology against inputs the program never produces. It did exactly that for a while —
// passing an empty array — so every volcano-derived resource was silently untested.
export interface Volcano {
  x: number
  y: number
  thickness: number
  kind: 'hotspot' | 'flood' | 'arc'
}

// World-cell size for grid-thinning the volcanic-arc markers: a long subduction zone
// has one range feature every ~MERGE_RADIUS (40px), so hundreds accumulate — one
// (tallest) cone per this-size cell keeps the arc reading as a dotted chain without
// flooding the marker layer. Hotspots/flood basalts are few, so they're never thinned.
const ARC_MARKER_CELL = 60

export // Volcanic markers for the mantle overlay: hotspot cones (plateB -1) + flood-basalt
// provinces (plateB -2), both always shown, plus ACTIVE volcanic arcs (subduction/
// island arcs still being fed at their boundary — epochsSinceDeposit small — with real
// relief), grid-thinned so a busy world doesn't send thousands. See TerrainFeature.volcanic.
function collectVolcanoes(features: TerrainFeature[]): { x: number; y: number; thickness: number; kind: 'hotspot' | 'flood' | 'arc' }[] {
  const out: { x: number; y: number; thickness: number; kind: 'hotspot' | 'flood' | 'arc' }[] = []
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
