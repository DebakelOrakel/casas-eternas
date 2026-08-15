import { hexCenter, hexCorners, hexIdEquals, hexIdKey, hexNeighbors } from './hexGrid'
import type { HexId, HexPoint } from './hexGrid'
import type { HexTileClass } from './hexTiles'

// Phase 4 of the hex build plan (docs/design/hex-world-view.md): DEVELOPED
// land becomes flat plates, and the grid stops being a drawing over the world
// and becomes the world's own geometry — but only where people have imposed
// it. Wilderness keeps its organic terrain; that contrast IS the visual
// language ("grid = civilisation").
//
// This module is the RULES and the STATE, deliberately free of Babylon so it
// can be checked headless. The geometry that follows from it lives in
// hexPlateLayer.ts.
//
// Development is game state, not world state: it is never written to the save
// and never enters the params hash (the same rule the migration layer carries
// — see docs/design/architecture-unification.md's inSpec note). Today it lives
// for a session because the only way in is a debug click.

export interface HexPlate {
  id: HexId
  // The tile's canonical height in WORLD Y units, frozen at the moment it was
  // developed: the MEDIAN of the ground as DRAWN across the tile.
  //
  // It used to be the HIGHEST of those samples, and that was a compromise
  // forced by nothing CUTTING the terrain under a plate — at the median the
  // uphill half of the tile poked through its own lid. The near ground is a
  // hex lattice now (map/hexNearMesh.ts, 2026-08-15) and a developed tile owns
  // its seven vertices, so levelling moves the ground rather than covering it:
  // the median is simply the balanced answer, half cut and half filled, which
  // is what levelling a field means.
  //
  // The other departure stands, and is no longer a compromise either: the
  // DRAWN ground, not the truth surface. A plate is a piece of the ground
  // people see, the lattice draws that same surface, and taking the truth
  // instead would sink every settlement into a systematic pit the width of
  // the near view's bias. Heights for READING the world (the hover readout,
  // gameplay) keep coming from the classification.
  height: number
}

export type DevelopRefusal = 'water' | 'undevelopable' | 'not-contiguous'

export interface HexPlates {
  isDeveloped(tile: HexId): boolean
  // Why a tile cannot be developed, or null when it can.
  refusal(tile: HexId): DevelopRefusal | null
  develop(tile: HexId): DevelopRefusal | null
  undevelop(tile: HexId): void
  plateAt(tile: HexId): HexPlate | undefined
  all(): HexPlate[]
  readonly count: number
  // Bumped on every change, so a renderer can rebuild only when it must.
  readonly revision: number
}

export interface HexPlateOptions {
  // The terrain classification (map/hexTiles.ts) — the plate rules read the
  // same answer the overlay paints, so what you see is what you may build on.
  classify: (tile: HexId) => HexTileClass
  // The ground as it is actually DRAWN near the camera, in world Y. This is
  // NOT the classification's truth surface, and the difference is not
  // cosmetic: the near-field patch is displaced by the fine sampler with
  // bias 0.6, which lifts it a median 7.7 m (up to 70 m) above the truth —
  // measured 2026-08-14, after plates placed on the truth surface turned out
  // to be buried under the visible ground and invisible.
  //
  // A plate is a piece of ground, so it belongs on the ground people see.
  // Heights for READING the world (the hover readout, gameplay) keep coming
  // from the classification; this one exists only to put geometry where the
  // eye is.
  renderGroundAt: (x: number, z: number) => number
}

// Sample points for a plate's canonical height: the centre and the six
// corners, pulled in so a corner sample cannot read the neighbour's ground
// through the sampler's own interpolation. Same inset the classifier uses.
const PLATE_RIM_INSET = 0.88

export function createHexPlates(options: HexPlateOptions): HexPlates {
  const plates = new Map<string, HexPlate>()
  let revision = 0

  // The MEDIAN of the drawn ground over the tile's seven sample points — the
  // height that cuts as much as it fills, now that levelling actually cuts.
  // Seven samples, so the median is a real sample rather than an average of
  // two, and a single freak corner cannot drag the field.
  function canonicalHeight(tile: HexId): number {
    const center = hexCenter(tile)
    const samples = [options.renderGroundAt(center.x, center.z)]
    for (const corner of hexCorners(tile)) {
      const x = center.x + (corner.x - center.x) * PLATE_RIM_INSET
      const z = center.z + (corner.z - center.z) * PLATE_RIM_INSET
      samples.push(options.renderGroundAt(x, z))
    }
    samples.sort((a, b) => a - b)
    return samples[samples.length >> 1]
  }

  function refusal(tile: HexId): DevelopRefusal | null {
    const cls = options.classify(tile)
    if (cls.water === 'water') return 'water'
    // Grade 0 is the classifier's own "never": open water, ice, or ground too
    // steep to terrace. Shore tiles keep a fraction of a grade and stay
    // buildable, which is the design's point — shores are the scarcest and
    // most interesting ground.
    if (cls.grade <= 0) return 'undevelopable'
    // CONTIGUITY: build only next to what is already built. Without it a
    // player can drop a lone plate on a mountain, and a single flattened
    // hexagon in wilderness reads as a render bug rather than as a farm.
    // The first plate of a world is the exception that starts the chain.
    if (plates.size > 0 && !hexNeighbors(tile).some((n) => plates.has(hexIdKey(n)))) return 'not-contiguous'
    return null
  }

  return {
    isDeveloped: (tile) => plates.has(hexIdKey(tile)),
    refusal,
    develop(tile: HexId): DevelopRefusal | null {
      const key = hexIdKey(tile)
      if (plates.has(key)) return null
      const why = refusal(tile)
      if (why) return why
      // Frozen HERE, from the terrain as it stands: developing is an act in
      // time, and a plate must not silently re-level itself when a finer bake
      // lands under it.
      plates.set(key, { id: tile, height: canonicalHeight(tile) })
      revision++
      return null
    },
    undevelop(tile: HexId): void {
      if (plates.delete(hexIdKey(tile))) revision++
    },
    plateAt: (tile) => plates.get(hexIdKey(tile)),
    all: () => [...plates.values()],
    get count() {
      return plates.size
    },
    get revision() {
      return revision
    },
  }
}

// --- the seam ---------------------------------------------------------------

// What a plate's edge has to bridge. Against a developed neighbour it is the
// small step between two canonical heights; against wilderness it is the
// embankment down to the real ground — the seam the design wants CELEBRATED
// (terrace edges, dry-stone walls) rather than hidden.
export interface PlateEdgeSeam {
  edge: number
  a: HexPoint
  b: HexPoint
  // Where the skirt ends: the neighbour's plate height, or the terrain under
  // the edge, whichever applies.
  bottom: number
  againstWilderness: boolean
}

// The six seams of a plate. `terrainAt` must be the same truth surface the
// classification used (world Y units), or plates will float above or sink
// into the ground they were levelled from.
export function plateSeams(
  plate: HexPlate,
  plates: HexPlates,
  terrainAt: (x: number, z: number) => number,
): PlateEdgeSeam[] {
  const corners = hexCorners(plate.id)
  const neighbors = hexNeighbors(plate.id)
  const seams: PlateEdgeSeam[] = []
  for (let k = 0; k < 6; k++) {
    const a = corners[k]
    const b = corners[(k + 1) % 6]
    const neighborPlate = plates.plateAt(neighbors[k])
    if (neighborPlate) {
      // Two plates meet: the seam is the step between them, and only the
      // HIGHER one draws it — otherwise both draw the same wall and the pair
      // z-fights along every shared edge.
      if (neighborPlate.height >= plate.height) continue
      seams.push({ edge: k, a, b, bottom: neighborPlate.height, againstWilderness: false })
      continue
    }
    // Against wilderness the skirt reaches the LOWEST ground along the edge,
    // so the plate meets the terrain even where the ground falls away between
    // the two corners.
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }
    const bottom = Math.min(terrainAt(a.x, a.z), terrainAt(b.x, b.z), terrainAt(mid.x, mid.z))
    seams.push({ edge: k, a, b, bottom: Math.min(bottom, plate.height), againstWilderness: true })
  }
  return seams
}

// A plate's neighbours that are developed — the adjacency the contiguity rule
// is built on, exposed for a renderer that wants to draw interior seams
// differently from the settlement's outer wall.
export function developedNeighbours(plate: HexPlate, plates: HexPlates): HexId[] {
  return hexNeighbors(plate.id).filter((n) => plates.isDeveloped(n) && !hexIdEquals(n, plate.id))
}
