import { SEA_LEVEL } from '../elevation/elevationScale'
import type { PeriodicTriangulation } from '../mesh/periodicDelaunay'
import { detHypot } from '../core/detMath'

// THE SHORE: land nodes with a sea neighbour, and each one's landward
// normal from its sea neighbours' mean offset — the history's coast
// process and the coast graph (coastGraph.ts) read the same line.
// Offsets between neighbours through the Domain (step 4d5; until then the
// torus's minimum image by hand, the same numbers there): each in v's own
// frame, the frame its normal and its wind are read in.
export interface Shore {
  // The shore nodes in slot order.
  shore: Int32Array
  isShore: Uint8Array
  normalX: Float32Array
  normalY: Float32Array
}

export function findShore(mesh: PeriodicTriangulation, z: Float32Array): Shore {
  const slots = mesh.vertexSlots
  const domain = mesh.domain
  const out = new Int32Array(64)
  const offset = { x: 0, y: 0 }
  const isShore = new Uint8Array(slots)
  const shoreList: number[] = []
  const normalX = new Float32Array(slots)
  const normalY = new Float32Array(slots)
  for (let v = 0; v < slots; v++) {
    if (!mesh.vAlive[v] || z[v] <= SEA_LEVEL) continue
    const n = mesh.outgoing(v, out)
    let nx = 0
    let ny = 0
    let seaCount = 0
    for (let k = 0; k < n; k++) {
      const u = mesh.to(out[k])
      if (z[u] > SEA_LEVEL) continue
      seaCount++
      // From the sea neighbour to v: minus the offset from v to it.
      domain.delta(mesh.vx[u], mesh.vy[u], mesh.vx[v], mesh.vy[v], offset)
      nx -= offset.x
      ny -= offset.y
    }
    if (seaCount === 0) continue
    isShore[v] = 1
    shoreList.push(v)
    const len = detHypot(nx, ny) || 1
    normalX[v] = nx / len
    normalY[v] = ny / len
  }
  return { shore: Int32Array.from(shoreList), isShore, normalX, normalY }
}
