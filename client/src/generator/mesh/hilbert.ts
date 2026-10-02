// Hilbert curve index of a cell on a 2^order × 2^order grid — the insertion
// order of the mesh (decision 8 of docs/decisions/adaptive-mesh.md:
// "insertion in Hilbert order"). Two properties matter: it is a total order
// on positions, so the same point set inserts the same way on every run and
// every machine; and consecutive points are spatial neighbours, so the
// point-location walk from the last inserted triangle is a handful of steps
// instead of a search. The classic xy2d of Warren's "Hacker's Delight"
// (the rotation step is the standard one).
//
// Order 16 gives 2^32 indices, still exact in a double. The domain's two
// extents map onto the same 2^order range each — the curve is anisotropic
// on a 2:1 world, which costs nothing (locality is what is wanted, not
// isotropy).
export function hilbertIndex(x: number, y: number, order: number): number {
  const n = 1 << order
  let d = 0
  let rx = 0
  let ry = 0
  for (let s = n >> 1; s > 0; s >>= 1) {
    rx = (x & s) > 0 ? 1 : 0
    ry = (y & s) > 0 ? 1 : 0
    d += s * s * ((3 * rx) ^ ry)
    // Rotate the quadrant so the curve stays continuous.
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x
        y = s - 1 - y
      }
      const t = x
      x = y
      y = t
    }
  }
  return d
}

export const HILBERT_ORDER = 16

// THE SAME INDEX, FOUR BITS A STEP (2026-10-02: hilbertIndex was 3 % of an
// epoch). The loop above transforms the bits still to come by a complement
// of both coordinates and a swap — two flags that commute, so four states.
// For each state and each 4-bit chunk of x and y, the table holds what the
// loop adds to d over those four bits and the state it leaves; it is made
// by running hilbertIndex itself on the chunk, so it cannot disagree with
// it. Integer sums below 2^53 — exact.
const CHUNK = 4
const CHUNK_TABLE_D = new Uint8Array(4 * 256)
const CHUNK_TABLE_STATE = new Uint8Array(4 * 256)
for (let state = 0; state < 4; state++) {
  for (let xc = 0; xc < 16; xc++) {
    for (let yc = 0; yc < 16; yc++) {
      let x = xc
      let y = yc
      if (state & 1) { x ^= 15; y ^= 15 }
      if (state & 2) { const t = x; x = y; y = t }
      // The loop's own steps on these four bits, its flags recorded.
      let d = 0
      let flips = 0
      for (let s = 8; s > 0; s >>= 1) {
        const rx = (x & s) > 0 ? 1 : 0
        const ry = (y & s) > 0 ? 1 : 0
        d += s * s * ((3 * rx) ^ ry)
        if (ry === 0) {
          if (rx === 1) {
            x = s - 1 - x
            y = s - 1 - y
            flips ^= 1
          }
          const t = x
          x = y
          y = t
          flips ^= 2
        }
      }
      CHUNK_TABLE_D[state * 256 + xc * 16 + yc] = d
      CHUNK_TABLE_STATE[state * 256 + xc * 16 + yc] = state ^ flips
    }
  }
}

function hilbertIndexByChunks(x: number, y: number): number {
  let d = 0
  let state = 0
  for (let shift = HILBERT_ORDER - CHUNK; shift >= 0; shift -= CHUNK) {
    const k = state * 256 + ((x >> shift) & 15) * 16 + ((y >> shift) & 15)
    d = d * 256 + CHUNK_TABLE_D[k]
    state = CHUNK_TABLE_STATE[k]
  }
  return d
}

// The Hilbert key of a world position on a domain of the given extent.
export function hilbertKey(x: number, y: number, width: number, height: number): number {
  const n = 1 << HILBERT_ORDER
  const gx = Math.min(n - 1, Math.max(0, Math.floor((x / width) * n)))
  const gy = Math.min(n - 1, Math.max(0, Math.floor((y / height) * n)))
  return hilbertIndexByChunks(gx, gy)
}

// Indices 0..count-1 sorted by the Hilbert key of (xs[i], ys[i]); ties by
// index, so the order is total.
export function hilbertOrder(xs: ArrayLike<number>, ys: ArrayLike<number>, count: number, width: number, height: number): Int32Array {
  const keys = new Float64Array(count)
  for (let i = 0; i < count; i++) keys[i] = hilbertKey(xs[i], ys[i], width, height)
  const order = new Int32Array(count)
  for (let i = 0; i < count; i++) order[i] = i
  order.sort((a, b) => keys[a] - keys[b] || a - b)
  return order
}
