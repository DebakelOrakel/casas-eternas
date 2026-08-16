// EROSION V2 — P1 THREADING SPIKE (docs/design/erosion-v2.md, phase P1).
// An EXPERIMENT, not a production path: the P0 physics prototype re-cut for
// worker_threads + SharedArrayBuffer, kept in the tree so P2 grows from
// measured code instead of memory. Ran 2026-08-16 on 2048×1024, 8 workers
// (4P+4E granted of a 4P+6E M-series):
//
//   serial best 830 ms/iter → K=1 threaded 614 → K=4 248 → K=8 169 ms/iter
//
//   parallel & proven:  Barnes strip flood (16 fixed strips, spill graph +
//                       min-max Dijkstra; exact to 0.02 m vs the serial
//                       flood, byte-deterministic for ANY worker count),
//                       LTD facet scan, MFD edges, stencils, uplift
//   still serial:       λ-walk 72 + accumulation 78 + sediment 39 +
//                       fluvial 18 + pop-order merge ~100 ms — THE wall;
//                       P2 breaks it with the pipelined refresh (see doc)
//
// Physics identical to the P0 prototype (11 of 131072 cells off by one u16
// quantum from float summation order — nothing else). Output is
// byte-identical across worker counts; that is the correctness gate.
//
// Run from client/:
//   node scripts/erosion-v2-spike.mjs <artifactDir> <lithoFile> <res> <iters> <workers> [outDir] [routingEvery]
//   workers = 0      → every job runs inline (the serial baseline, same code)
//   routingEvery = K → recompute ocean/flood/LTD/MFD/accumulation every K
//                      iterations (v1's drainage-refresh model); physics on
//                      the cached routing in between. K ≤ 8 validated: land
//                      fraction and convergence unchanged, field differences
//                      in the capture-flicker class (36/68 m RMS at 512).
//   DUMP_FILLED=<f>  → write the first filled surface to <f> and exit (the
//                      instrument that proved the flood exact).
// <lithoFile> comes from erosion-v2-litho.mts (the one repo-TS dependency,
// baked out because workers cannot load TS).
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WORLD_W_M = 2048 * 7800
const H_M = 9000
const P = {
  m: 0.5, kappaDt: 0.009, baseAreaKm2: 500, thetaC: 0, upliftDt: 2.2e-3,
  settleXiKm: 1.0, settleFloorKm: 20, settleMarineKm: 8, marineFreeboardM: 2,
  hillDiffKm2: 0.5, criticalSlope: 0.65, marineDiffDt: 0.25, epsM: 0.35,
}
const EPS = 1e-7
const SQRT2 = Math.SQRT2
const QT = Math.PI / 4
const D8 = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]]
const LTD_FACETS = [
  [0, 1, +1], [2, 1, -1], [2, 3, +1], [4, 3, -1],
  [4, 5, +1], [6, 5, -1], [6, 7, +1], [0, 7, -1],
]

// Job ids (ctrl[1]).
const J_EXIT = 0
const J_UPLIFT = 1
const J_LTD_SCAN = 2
const J_MFD = 3
const J_HILL_MOVES = 4
const J_HILL_APPLY = 5
const J_MARINE_MOVES = 6
const J_MARINE_APPLY = 7
const J_FLOOD_P1 = 8
const J_FLOOD_P2 = 9

// The flood is decomposed into a FIXED number of strips, deliberately
// independent of the worker count: the epsilon-chains in `filled` are
// path-length-dependent, so the decomposition itself is part of the result.
// With strips pinned, output is byte-identical for ANY worker count; workers
// just pick up strips round-robin.
const STRIPS = 16
const EDGES_PER_STRIP_FACTOR = 16 // edge buffer per strip = 16*W entries

// ---------------------------------------------------------------------------
// Shared state — identical construction on main and in workers.
function makeViews(sab, W, H) {
  const n = W * H
  let off = 0
  const take = (Type, count) => {
    const v = new Type(sab, off, count)
    off += count * Type.BYTES_PER_ELEMENT
    off = (off + 7) & ~7
    return v
  }
  return {
    z: take(Float32Array, n),
    filled: take(Float32Array, n),
    prevFilled: take(Float32Array, n),
    uplift: take(Float32Array, n),
    litho: take(Float32Array, n),
    acc: take(Float32Array, n),
    moveE: take(Float32Array, n),
    moveS: take(Float32Array, n),
    ltdDelC: take(Float32Array, n),
    ltdDelD: take(Float32Array, n),
    outW: take(Float32Array, 8 * n),
    popOrder: take(Int32Array, n),
    flowTarget: take(Int32Array, n),
    ltdC: take(Int32Array, n),
    ltdD: take(Int32Array, n),
    ltdFall: take(Int32Array, n),
    ltdMode: take(Uint8Array, n),
    seedMask: take(Uint8Array, n),
    outDegree: take(Uint8Array, n),
    outDir: take(Uint8Array, 8 * n),
    maxStepW: take(Float64Array, 64),
    stripPopped: take(Int32Array, 64),
    stripChanged: take(Int32Array, 64),
    stripDirty: take(Int32Array, 64),
    borderFill: take(Float32Array, 2 * W * STRIPS),
    edgeA: take(Int32Array, EDGES_PER_STRIP_FACTOR * W * STRIPS),
    edgeB: take(Int32Array, EDGES_PER_STRIP_FACTOR * W * STRIPS),
    edgeW: take(Float32Array, EDGES_PER_STRIP_FACTOR * W * STRIPS),
    edgeCount: take(Int32Array, 64),
    bytes: off,
  }
}
const sabSize = (W, H) => {
  const n = W * H
  return (11 * 4 + 8 * 4 + 5 * 4 + 3 + 8) * n + 64 * 8 + 4 * 64 * 4
    + 2 * W * STRIPS * 4 + EDGES_PER_STRIP_FACTOR * W * STRIPS * 12 + 16384
}

// ---------------------------------------------------------------------------
// Worker-local scratch for the strip floods (persists across jobs).
let floodScratch = null
function ensureFloodScratch(W, stripRows) {
  const cap = (stripRows + 2) * W
  if (floodScratch && floodScratch.cap >= cap) return floodScratch
  floodScratch = {
    cap,
    visited: new Uint8Array(cap),
    labels: new Int32Array(cap),
    lf: new Float32Array(cap), // local filled, f32 like the shared array
    hk: new Float64Array(cap),
    hi: new Int32Array(cap),
  }
  return floodScratch
}

// BARNES-STYLE TWO-PHASE PARALLEL FLOOD (Barnes 2016/17, adapted to torus
// strips). Phase 1: every strip priority-floods its OWN rows independently,
// seeded by its world-ocean cells (label OCEAN) and its two border rows at
// raw z (open-boundary assumption), each border cell its own label; where two
// differently-labelled regions meet, the min spill level between them is
// recorded. The global step (main thread) runs a min-max Dijkstra from the
// ocean over the border-cell graph, giving every border cell its TRUE fill
// level. Phase 2: every strip floods once more with its borders and ghosts
// pinned to those true levels — one pass, exact.
//
// The filled surface differs from the serial flood only in the epsilon
// chains (path lengths differ), i.e. at the ~metre level on lake surfaces;
// filled is routing-only and never feeds z, so that is presentation-free.
// Deterministic for any worker count, since STRIPS is fixed.
function runFloodP1(v, W, H, wid, nw) {
  const stripRows = H / STRIPS
  const st = ensureFloodScratch(W, stripRows)
  const { z, seedMask, edgeA, edgeB, edgeW, edgeCount } = v
  const workers = Math.max(1, nw)
  const EC = EDGES_PER_STRIP_FACTOR * W
  const keyBase = 2 * W + 1
  for (let s = wid; s < STRIPS; s += workers) {
    const gr0 = s * stripRows
    const cap = stripRows * W
    const vis = st.visited
    vis.fill(0, 0, cap)
    const lab = st.labels
    const lf = st.lf
    const hk = st.hk
    const hi = st.hi
    let hs = 0
    const push = (key, idx) => {
      let i = hs++
      hk[i] = key
      hi[i] = idx
      while (i > 0) {
        const pr = (i - 1) >> 1
        if (hk[pr] <= hk[i]) break
        const tk = hk[pr]; hk[pr] = hk[i]; hk[i] = tk
        const ti = hi[pr]; hi[pr] = hi[i]; hi[i] = ti
        i = pr
      }
    }
    for (let l = 0; l < stripRows; l++) {
      const g0 = (gr0 + l) * W
      const isBorder = l === 0 || l === stripRows - 1
      for (let x = 0; x < W; x++) {
        const local = l * W + x
        const g = g0 + x
        if (seedMask[g]) {
          lf[local] = z[g]
          lab[local] = -1 // OCEAN
          vis[local] = 1
          push(lf[local], local)
        } else if (isBorder) {
          lf[local] = z[g]
          lab[local] = l === 0 ? x : W + x
          vis[local] = 1
          push(lf[local], local)
        }
      }
    }
    const edges = new Map()
    while (hs > 0) {
      const current = hi[0]
      hs--
      if (hs > 0) {
        hk[0] = hk[hs]
        hi[0] = hi[hs]
        let i = 0
        for (;;) {
          const left = i * 2 + 1
          const right = i * 2 + 2
          let smallest = i
          if (left < hs && hk[left] < hk[smallest]) smallest = left
          if (right < hs && hk[right] < hk[smallest]) smallest = right
          if (smallest === i) break
          const tk = hk[smallest]; hk[smallest] = hk[i]; hk[i] = tk
          const ti = hi[smallest]; hi[smallest] = hi[i]; hi[i] = ti
          i = smallest
        }
      }
      const ly = (current / W) | 0
      const lx = current - ly * W
      const myLab = lab[current]
      for (const [dx, dy] of D8) {
        const ny = ly + dy
        if (ny < 0 || ny >= stripRows) continue
        const nx = (lx + dx + W) % W
        const local2 = ny * W + nx
        if (vis[local2]) {
          const oLab = lab[local2]
          if (oLab !== myLab) {
            const wSpill = Math.max(lf[current], lf[local2])
            let a = myLab, b = oLab
            if (a > b) { const t = a; a = b; b = t }
            const key = (a + 1) * keyBase + (b + 1)
            const prev = edges.get(key)
            if (prev === undefined || wSpill < prev) edges.set(key, wSpill)
          }
          continue
        }
        vis[local2] = 1
        lab[local2] = myLab
        const g2 = (gr0 + ny) * W + nx
        const stepDistance = dx !== 0 && dy !== 0 ? SQRT2 : 1
        lf[local2] = Math.max(z[g2], lf[current]) + EPS * stepDistance
        push(lf[local2], local2)
      }
    }
    const base = s * EC
    let c = 0
    for (const [key, wv] of edges) {
      if (c >= EC) break // overflow guard; EC is far above planar-graph reality
      const a = Math.floor(key / keyBase) - 1
      const b = (key % keyBase) - 1
      edgeA[base + c] = a < 0 ? -1 : s * 2 * W + a
      edgeB[base + c] = s * 2 * W + b
      edgeW[base + c] = wv
      c++
    }
    edgeCount[s] = c
  }
}

function runFloodP2(v, W, H, wid, nw) {
  const stripRows = H / STRIPS
  const st = ensureFloodScratch(W, stripRows)
  const { z, filled, seedMask, popOrder, stripPopped, borderFill } = v
  const workers = Math.max(1, nw)
  const rowsL = stripRows + 2
  for (let s = wid; s < STRIPS; s += workers) {
    const gr0 = s * stripRows
    const gTop = (gr0 - 1 + H) % H
    const gBot = (gr0 + stripRows) % H
    const globalRow = (l) => (l === 0 ? gTop : l === rowsL - 1 ? gBot : gr0 + l - 1)
    const cap = rowsL * W
    const vis = st.visited
    vis.fill(0, 0, cap)
    const lf = st.lf
    const hk = st.hk
    const hi = st.hi
    let hs = 0
    const push = (key, idx) => {
      let i = hs++
      hk[i] = key
      hi[i] = idx
      while (i > 0) {
        const pr = (i - 1) >> 1
        if (hk[pr] <= hk[i]) break
        const tk = hk[pr]; hk[pr] = hk[i]; hk[i] = tk
        const ti = hi[pr]; hi[pr] = hi[i]; hi[i] = ti
        i = pr
      }
    }
    // Ghost rows: the previous strip's bottom border and the next strip's top
    // border, pinned at their true (Dijkstra) levels. Never expanded into.
    const sPrev = (s - 1 + STRIPS) % STRIPS
    const sNext = (s + 1) % STRIPS
    for (const [l, nodeBase] of [[0, sPrev * 2 * W + W], [rowsL - 1, sNext * 2 * W]]) {
      for (let x = 0; x < W; x++) {
        const local = l * W + x
        vis[local] = 1
        const bf = borderFill[nodeBase + x]
        if (bf < Infinity) {
          lf[local] = bf
          push(bf, local)
        }
      }
    }
    // Own rows: border cells pinned at their true levels, interior ocean at z.
    for (let l = 1; l < rowsL - 1; l++) {
      const g0 = globalRow(l) * W
      const isTop = l === 1
      const isBottom = l === rowsL - 2
      for (let x = 0; x < W; x++) {
        const local = l * W + x
        if (isTop || isBottom) {
          const bf = borderFill[s * 2 * W + (isTop ? x : W + x)]
          if (bf < Infinity) {
            lf[local] = bf
            vis[local] = 1
            push(bf, local)
          }
        } else if (seedMask[g0 + x]) {
          lf[local] = z[g0 + x]
          vis[local] = 1
          push(lf[local], local)
        }
      }
    }
    let popped = 0
    const segBase = gr0 * W
    while (hs > 0) {
      const current = hi[0]
      hs--
      if (hs > 0) {
        hk[0] = hk[hs]
        hi[0] = hi[hs]
        let i = 0
        for (;;) {
          const left = i * 2 + 1
          const right = i * 2 + 2
          let smallest = i
          if (left < hs && hk[left] < hk[smallest]) smallest = left
          if (right < hs && hk[right] < hk[smallest]) smallest = right
          if (smallest === i) break
          const tk = hk[smallest]; hk[smallest] = hk[i]; hk[i] = tk
          const ti = hi[smallest]; hi[smallest] = hi[i]; hi[i] = ti
          i = smallest
        }
      }
      const ly = (current / W) | 0
      const lx = current - ly * W
      if (ly > 0 && ly < rowsL - 1) {
        const g = globalRow(ly) * W + lx
        filled[g] = lf[current]
        popOrder[segBase + popped++] = g
      }
      for (const [dx, dy] of D8) {
        const ny = ly + dy
        if (ny < 0 || ny >= rowsL) continue
        const nx = (lx + dx + W) % W
        const local2 = ny * W + nx
        if (vis[local2]) continue
        vis[local2] = 1
        const g2 = globalRow(ny) * W + nx
        const stepDistance = dx !== 0 && dy !== 0 ? SQRT2 : 1
        lf[local2] = Math.max(z[g2], lf[current]) + EPS * stepDistance
        push(lf[local2], local2)
      }
    }
    // Own cells never reached stay unknown.
    for (let l = 1; l < rowsL - 1; l++) {
      const g0 = globalRow(l) * W
      for (let x = 0; x < W; x++) {
        if (!vis[l * W + x]) filled[g0 + x] = Infinity
      }
    }
    stripPopped[s] = popped
  }
}

// ---------------------------------------------------------------------------
// The jobs. Each runs on rows [r0, r1) and writes ONLY cells it owns (plus,
// for moves/apply, per-cell slots of its own rows) — reads may cross rows.
function runJob(type, v, W, H, r0, r1, wid, nw) {
  const n = W * H
  const cellM = WORLD_W_M / W
  const cellKm2 = (cellM / 1000) * (cellM / 1000)
  const { z, filled, uplift, moveE, moveS } = v

  if (type === J_UPLIFT) {
    for (let i = r0 * W; i < r1 * W; i++) {
      if (z[i] > 0) z[i] += P.upliftDt * uplift[i]
    }
  } else if (type === J_LTD_SCAN) {
    const { ltdC, ltdD, ltdDelC, ltdDelD, ltdFall, ltdMode } = v
    for (let y = r0; y < r1; y++) {
      for (let x = 0; x < W; x++) {
        const cell = y * W + x
        const own = filled[cell]
        let bestSlope = 0, bestFacet = -1, bestS1 = 0, bestS2 = 0, bestGradient = 0, fallback = -1
        let bnc = -1, bnd = -1
        for (let f = 0; f < 8; f++) {
          const facet = LTD_FACETS[f]
          const co = D8[facet[0]]
          const dd = D8[facet[1]]
          const nc = ((y + co[1] + H) % H) * W + ((x + co[0] + W) % W)
          const g1 = own - filled[nc]
          if (g1 > bestGradient) { bestGradient = g1; fallback = nc }
          const nd = ((y + dd[1] + H) % H) * W + ((x + dd[0] + W) % W)
          if (f % 2 === 0) {
            const g2 = (own - filled[nd]) / SQRT2
            if (g2 > bestGradient) { bestGradient = g2; fallback = nd }
          }
          const s1 = own - filled[nc]
          const s2 = filled[nc] - filled[nd]
          let slope
          if (s2 <= 0) slope = s1
          else if (s2 >= s1) slope = (own - filled[nd]) / SQRT2
          else slope = Math.hypot(s1, s2)
          if (slope > bestSlope) { bestSlope = slope; bestFacet = f; bestS1 = s1; bestS2 = s2; bnc = nc; bnd = nd }
        }
        ltdFall[cell] = fallback
        if (bestFacet >= 0) {
          const orient = LTD_FACETS[bestFacet][2]
          const alpha = bestS2 <= 0 ? 0 : bestS2 >= bestS1 ? QT : Math.atan2(bestS2, bestS1)
          ltdC[cell] = bnc
          ltdD[cell] = bnd
          ltdDelC[cell] = -orient * Math.sin(alpha)
          ltdDelD[cell] = orient * SQRT2 * Math.sin(QT - alpha)
          ltdMode[cell] = 4 | (filled[bnc] < own ? 1 : 0) | (filled[bnd] < own ? 2 : 0)
        } else {
          ltdMode[cell] = 0
        }
      }
    }
  } else if (type === J_MFD) {
    const { outDegree, outDir, outW } = v
    for (let y = r0; y < r1; y++) {
      for (let x = 0; x < W; x++) {
        const cell = y * W + x
        const own = filled[cell]
        let count = 0
        let wsum = 0
        const base = cell * 8
        for (let dir = 0; dir < 8; dir++) {
          const dxy = D8[dir]
          const neighbor = ((y + dxy[1] + H) % H) * W + ((x + dxy[0] + W) % W)
          const drop = own - filled[neighbor]
          if (drop <= 0) continue
          const weight = drop / (dxy[0] !== 0 && dxy[1] !== 0 ? SQRT2 : 1)
          outDir[base + count] = dir
          outW[base + count] = weight
          wsum += weight
          count++
        }
        for (let i = 0; i < count; i++) outW[base + i] /= wsum
        outDegree[cell] = count
      }
    }
  } else if (type === J_HILL_MOVES) {
    for (let y = r0; y < r1; y++) {
      for (let x = 0; x < W; x++) {
        const cell = y * W + x
        let mE = 0, mS = 0
        if (z[cell] > 0) {
          const dxKm2 = (cellM / 1000) * (cellM / 1000)
          const east = y * W + ((x + 1) % W)
          const south = ((y + 1) % H) * W + x
          for (const [nb, isE] of [[east, 1], [south, 0]]) {
            const dzn = z[cell] - z[nb]
            if (dzn === 0) continue
            const slope = (Math.abs(dzn) * H_M) / cellM
            const ratio = Math.min(0.95, slope / P.criticalSlope)
            const boost = 1 / (1 - ratio * ratio)
            const frac = Math.min(0.2, (P.hillDiffKm2 / dxKm2) * Math.min(boost, 12))
            const move = frac * dzn
            if (isE) mE = move
            else mS = move
          }
        }
        moveE[cell] = mE
        moveS[cell] = mS
      }
    }
  } else if (type === J_HILL_APPLY) {
    let maxStep = 0
    for (let y = r0; y < r1; y++) {
      const north = (y - 1 + H) % H
      for (let x = 0; x < W; x++) {
        const cell = y * W + x
        const west = y * W + ((x - 1 + W) % W)
        const delta = -(moveE[cell] + moveS[cell]) + moveE[west] + moveS[north * W + x]
        if (delta !== 0) {
          z[cell] += delta
          const s = Math.abs(delta)
          if (z[cell] > 0 && s > maxStep) maxStep = s
        }
      }
    }
    v.maxStepW[wid] = maxStep
  } else if (type === J_MARINE_MOVES) {
    for (let y = r0; y < r1; y++) {
      for (let x = 0; x < W; x++) {
        const cell = y * W + x
        let mE = 0, mS = 0
        if (z[cell] <= 0) {
          const east = y * W + ((x + 1) % W)
          const south = ((y + 1) % H) * W + x
          if (z[east] <= 0) mE = P.marineDiffDt * (z[cell] - z[east]) * 0.1
          if (z[south] <= 0) mS = P.marineDiffDt * (z[cell] - z[south]) * 0.1
        }
        moveE[cell] = mE
        moveS[cell] = mS
      }
    }
  } else if (type === J_MARINE_APPLY) {
    for (let y = r0; y < r1; y++) {
      const north = (y - 1 + H) % H
      for (let x = 0; x < W; x++) {
        const cell = y * W + x
        const west = y * W + ((x - 1 + W) % W)
        z[cell] += -(moveE[cell] + moveS[cell]) + moveE[west] + moveS[north * W + x]
      }
    }
  } else if (type === J_FLOOD_P1) {
    runFloodP1(v, W, H, wid, nw)
  } else if (type === J_FLOOD_P2) {
    runFloodP2(v, W, H, wid, nw)
  }
}

// ---------------------------------------------------------------------------
// Worker side: wait for a job seq bump, run, report done.
if (!isMainThread) {
  const { sab, ctrl, done, W, H, r0, r1, wid, nw } = workerData
  const v = makeViews(sab, W, H)
  const c = new Int32Array(ctrl)
  const d = new Int32Array(done)
  let seen = 0
  for (;;) {
    Atomics.wait(c, 0, seen)
    seen = Atomics.load(c, 0)
    const type = Atomics.load(c, 1)
    if (type === J_EXIT) break
    runJob(type, v, W, H, r0, r1, wid, nw)
    Atomics.add(d, 0, 1)
    Atomics.notify(d, 0)
  }
  parentPort?.close()
}

// ---------------------------------------------------------------------------
// Main side.
if (isMainThread) {
  const [artifactDir, lithoFile, resArg, itersArg, workersArg, outDir, routingEveryArg] = process.argv.slice(2)
  const ROUTING_EVERY = Math.max(1, Number(routingEveryArg ?? 1))
  const W = Number(resArg)
  const H = W / 2
  const ITERS = Number(itersArg)
  const NW = Number(workersArg)
  const n = W * H
  const cellM = WORLD_W_M / W
  const cellKm2 = (cellM / 1000) * (cellM / 1000)

  const sab = new SharedArrayBuffer(sabSize(W, H))
  const v = makeViews(sab, W, H)

  // --- inputs
  const meta = JSON.parse(readFileSync(join(artifactDir, 'meta.json'), 'utf8'))
  const srcW = meta.width
  const raw = new Uint16Array(readFileSync(join(artifactDir, 'elevation.u16')).buffer.slice(0))
  const factor = srcW / W
  if (!Number.isInteger(factor)) throw new Error(`source ${srcW} not divisible by ${W}`)
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) s += raw[(y * factor + dy) * srcW + x * factor + dx]
      }
      v.z[y * W + x] = (s / (factor * factor)) * (2 / 65535) - 1
    }
  }
  const lithoRaw = new Float32Array(readFileSync(lithoFile).buffer.slice(0))
  if (lithoRaw.length !== n) throw new Error(`litho ${lithoRaw.length} != ${n}`)
  v.litho.set(lithoRaw)
  // U forcing from the common 256×128 frame (identical to p0-engine).
  const FW = 256, FH = 128
  const uCoarse = new Float32Array(FW * FH)
  {
    const f2 = srcW / FW
    for (let y = 0; y < FH; y++) {
      for (let x = 0; x < FW; x++) {
        let s = 0
        for (let dy = 0; dy < f2; dy++) {
          for (let dx = 0; dx < f2; dx++) s += raw[(y * f2 + dy) * srcW + x * f2 + dx]
        }
        const val = (s / (f2 * f2)) * (2 / 65535) - 1
        uCoarse[y * FW + x] = Math.pow(Math.max(0, val), 1.5)
      }
    }
    const tmp = uCoarse.slice()
    for (let y = 0; y < FH; y++) {
      for (let x = 0; x < FW; x++) {
        let s = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) s += tmp[((y + dy + FH) % FH) * FW + ((x + dx + FW) % FW)]
        }
        uCoarse[y * FW + x] = s / 9
      }
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x / W) * FW
      const vv = (y / H) * FH
      const x0 = Math.floor(u), y0 = Math.floor(vv)
      const fx = u - x0, fy = vv - y0
      const at = (xx, yy) => uCoarse[(((yy % FH) + FH) % FH) * FW + (((xx % FW) + FW) % FW)]
      v.uplift[y * W + x] = (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy
    }
  }

  // --- worker pool
  const ctrl = new SharedArrayBuffer(64)
  const done = new SharedArrayBuffer(64)
  const c = new Int32Array(ctrl)
  const d = new Int32Array(done)
  const workers = []
  const rowsFor = (wid, count) => {
    const per = Math.ceil(H / count)
    return [Math.min(H, wid * per), Math.min(H, (wid + 1) * per)]
  }
  for (let w = 0; w < NW; w++) {
    const [r0, r1] = rowsFor(w, NW)
    workers.push(new Worker(fileURLToPath(import.meta.url), {
      workerData: { sab, ctrl, done, W, H, r0, r1, wid: w, nw: NW },
    }))
  }
  const dispatch = (type) => {
    if (NW === 0) {
      runJob(type, v, W, H, 0, H, 0, 0)
      return
    }
    Atomics.store(d, 0, 0)
    Atomics.store(c, 1, type)
    Atomics.add(c, 0, 1)
    Atomics.notify(c, 0)
    let seen
    while ((seen = Atomics.load(d, 0)) < NW) Atomics.wait(d, 0, seen)
  }

  // --- serial pieces (main thread)
  // Min-heap, same layout as core/minHeap.ts (float64 keys, int32 indices).
  const heapKeys = new Float64Array(n)
  const heapIdx = new Int32Array(n)
  let heapSize = 0
  const heapPush = (key, index) => {
    let i = heapSize++
    heapKeys[i] = key
    heapIdx[i] = index
    while (i > 0) {
      const p = (i - 1) >> 1
      if (heapKeys[p] <= heapKeys[i]) break
      const tk = heapKeys[p]; heapKeys[p] = heapKeys[i]; heapKeys[i] = tk
      const ti = heapIdx[p]; heapIdx[p] = heapIdx[i]; heapIdx[i] = ti
      i = p
    }
  }
  let poppedIdx = -1
  const heapPop = () => {
    poppedIdx = heapIdx[0]
    heapSize--
    if (heapSize > 0) {
      heapKeys[0] = heapKeys[heapSize]
      heapIdx[0] = heapIdx[heapSize]
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        if (l >= heapSize) break
        const r = l + 1
        const m = r < heapSize && heapKeys[r] < heapKeys[l] ? r : l
        if (heapKeys[i] <= heapKeys[m]) break
        const tk = heapKeys[i]; heapKeys[i] = heapKeys[m]; heapKeys[m] = tk
        const ti = heapIdx[i]; heapIdx[i] = heapIdx[m]; heapIdx[m] = ti
        i = m
      }
    }
  }

  const label = new Int32Array(n)
  const stack = new Int32Array(n)
  function oceanSeed() {
    const seedMask = v.seedMask
    label.fill(-1)
    seedMask.fill(0)
    const sizes = []
    let sp = 0
    for (let s = 0; s < n; s++) {
      if (v.z[s] > 0 || label[s] !== -1) continue
      const id = sizes.length
      let size = 0
      stack[sp++] = s
      label[s] = id
      while (sp > 0) {
        const i = stack[--sp]
        size++
        const y = (i / W) | 0, x = i - y * W
        const nbs = [y * W + ((x + 1) % W), y * W + ((x + W - 1) % W), ((y + 1) % H) * W + x, ((y + H - 1) % H) * W + x]
        for (const nb of nbs) {
          if (v.z[nb] <= 0 && label[nb] === -1) { label[nb] = id; stack[sp++] = nb }
        }
      }
      sizes.push(size)
    }
    if (!sizes.length) return false
    let best = 0
    for (let i = 1; i < sizes.length; i++) if (sizes[i] > sizes[best]) best = i
    for (let i = 0; i < n; i++) if (label[i] === best) seedMask[i] = 1
    return true
  }

  // Parallel strip flood: rounds of independent strip floods against the
  // previous round's ghosts, until no strip changes; then a 16-way merge of
  // the per-strip pop segments (each sorted by filled) into one global
  // topological order. Any order sorted by filled ascending is valid for
  // every walk (receivers are STRICTLY lower in filled).
  const popOrderM = new Int32Array(n)
  let floodP1Ms = 0
  let floodGraphMs = 0
  let floodP2Ms = 0
  let floodMergeMs = 0
  // Min-max Dijkstra state over the border-cell graph (NN nodes + ocean).
  const NN = STRIPS * 2 * W
  const dist = new Float64Array(NN)
  const nodeDeg = new Int32Array(NN + 1)
  function flood() {
    let t = performance.now()
    dispatch(J_FLOOD_P1)
    floodP1Ms += performance.now() - t
    t = performance.now()

    // --- build the undirected border graph: collected spill edges + the
    // structural adjacency between each strip's bottom row and the next
    // strip's top row (weight = max of the two raw elevations).
    const stripRows = H / STRIPS
    const EC = EDGES_PER_STRIP_FACTOR * W
    const { edgeA, edgeB, edgeW, edgeCount, borderFill } = v
    let mCollected = 0
    for (let s = 0; s < STRIPS; s++) mCollected += edgeCount[s]
    const mStructural = STRIPS * W * 3
    // Adjacency (CSR, undirected — ocean edges (a = -1) are kept OUT of the
    // CSR and used as Dijkstra initialisation instead.)
    nodeDeg.fill(0)
    let mReal = 0
    for (let s = 0; s < STRIPS; s++) {
      const base = s * EC
      for (let e = 0; e < edgeCount[s]; e++) {
        const a = edgeA[base + e]
        if (a < 0) continue
        nodeDeg[a + 1]++
        nodeDeg[edgeB[base + e] + 1]++
        mReal++
      }
    }
    for (let s = 0; s < STRIPS; s++) {
      const rowA = ((s + 1) * stripRows - 1)
      const t2 = (s + 1) % STRIPS
      const rowB = t2 * stripRows
      for (let x = 0; x < W; x++) {
        const a = s * 2 * W + W + x
        for (let dx = -1; dx <= 1; dx++) {
          const b = t2 * 2 * W + ((x + dx + W) % W)
          nodeDeg[a + 1]++
          nodeDeg[b + 1]++
          mReal++
        }
      }
    }
    for (let i = 0; i < NN; i++) nodeDeg[i + 1] += nodeDeg[i]
    const adjTo = new Int32Array(2 * mReal)
    const adjW = new Float64Array(2 * mReal)
    const fill = nodeDeg.slice(0, NN)
    const addEdge = (a, b, w) => {
      adjTo[fill[a]] = b; adjW[fill[a]++] = w
      adjTo[fill[b]] = a; adjW[fill[b]++] = w
    }
    dist.fill(Infinity)
    heapSize = 0
    for (let s = 0; s < STRIPS; s++) {
      const base = s * EC
      for (let e = 0; e < edgeCount[s]; e++) {
        const a = edgeA[base + e]
        const b = edgeB[base + e]
        const w = edgeW[base + e]
        if (a < 0) {
          if (w < dist[b]) { dist[b] = w; heapPush(w, b) }
        } else {
          addEdge(a, b, w)
        }
      }
    }
    for (let s = 0; s < STRIPS; s++) {
      const rowA = ((s + 1) * stripRows - 1)
      const t2 = (s + 1) % STRIPS
      const rowB = t2 * stripRows
      for (let x = 0; x < W; x++) {
        const a = s * 2 * W + W + x
        const za = v.z[rowA * W + x]
        for (let dx = -1; dx <= 1; dx++) {
          const xb = (x + dx + W) % W
          addEdge(a, t2 * 2 * W + xb, Math.max(za, v.z[rowB * W + xb]))
        }
      }
    }
    // Ocean-mask border cells sit at the drain itself.
    for (let s = 0; s < STRIPS; s++) {
      const gTopRow = s * stripRows * W
      const gBotRow = ((s + 1) * stripRows - 1) * W
      for (let x = 0; x < W; x++) {
        if (v.seedMask[gTopRow + x]) {
          const nd = s * 2 * W + x
          const zv = v.z[gTopRow + x]
          if (zv < dist[nd]) { dist[nd] = zv; heapPush(zv, nd) }
        }
        if (v.seedMask[gBotRow + x]) {
          const nd = s * 2 * W + W + x
          const zv = v.z[gBotRow + x]
          if (zv < dist[nd]) { dist[nd] = zv; heapPush(zv, nd) }
        }
      }
    }
    // Lazy min-max Dijkstra.
    while (heapSize > 0) {
      const key = heapKeys[0]
      heapPop()
      const u = poppedIdx
      if (key > dist[u]) continue
      for (let e = nodeDeg[u]; e < fill[u]; e++) {
        const vtx = adjTo[e]
        const nd = Math.max(key, adjW[e])
        if (nd < dist[vtx]) { dist[vtx] = nd; heapPush(nd, vtx) }
      }
    }
    // True level of a border cell: its own ground or its spill path level.
    for (let s = 0; s < STRIPS; s++) {
      const gTopRow = s * stripRows * W
      const gBotRow = ((s + 1) * stripRows - 1) * W
      for (let x = 0; x < W; x++) {
        const a = s * 2 * W + x
        const b = s * 2 * W + W + x
        borderFill[a] = dist[a] === Infinity ? Infinity : Math.max(v.z[gTopRow + x], dist[a])
        borderFill[b] = dist[b] === Infinity ? Infinity : Math.max(v.z[gBotRow + x], dist[b])
      }
    }
    floodGraphMs += performance.now() - t
    t = performance.now()

    dispatch(J_FLOOD_P2)
    floodP2Ms += performance.now() - t
    t = performance.now()

    // merge
    const heads = new Int32Array(STRIPS)
    let total = 0
    for (let s = 0; s < STRIPS; s++) total += v.stripPopped[s]
    const { filled, popOrder } = v
    for (let k = 0; k < total; k++) {
      let best = -1
      let bestKey = Infinity
      for (let s = 0; s < STRIPS; s++) {
        const h = heads[s]
        if (h >= v.stripPopped[s]) continue
        const key = filled[popOrder[s * stripRows * W + h]]
        if (key < bestKey) { bestKey = key; best = s }
      }
      popOrderM[k] = popOrder[best * stripRows * W + heads[best]++]
    }
    floodMergeMs += performance.now() - t
    return total
  }

  const lambda = new Float32Array(n)
  const contrib = new Uint32Array(n)
  const bestInflow = new Uint32Array(n)
  function lambdaWalk(popped) {
    lambda.fill(0); contrib.fill(0); bestInflow.fill(0)
    const { flowTarget, ltdC, ltdD, ltdDelC, ltdDelD, ltdFall, ltdMode } = v
    for (let i = popped - 1; i >= 0; i--) {
      const cell = popOrderM[i]
      let target = ltdFall[cell]
      let delta = 0
      const mode = ltdMode[cell]
      if (mode & 4) {
        const cDown = (mode & 1) !== 0
        const dDown = (mode & 2) !== 0
        if (cDown && dDown) {
          const lam = lambda[cell]
          if (Math.abs(lam + ltdDelC[cell]) <= Math.abs(lam + ltdDelD[cell])) { target = ltdC[cell]; delta = ltdDelC[cell] }
          else { target = ltdD[cell]; delta = ltdDelD[cell] }
        } else if (cDown) { target = ltdC[cell]; delta = ltdDelC[cell] }
        else if (dDown) { target = ltdD[cell]; delta = ltdDelD[cell] }
      }
      flowTarget[cell] = target
      if (target < 0) continue
      const area = contrib[cell] + 1
      contrib[target] += area
      if (area > bestInflow[target]) {
        bestInflow[target] = area
        lambda[target] = lambda[cell] + delta
      }
    }
  }

  function accumulate(popped) {
    const { outDegree, outDir, outW, acc } = v
    acc.fill(1)
    for (let i = popped - 1; i >= 0; i--) {
      const cell = popOrderM[i]
      const a = acc[cell]
      const x = cell % W
      const y = (cell - x) / W
      const base = cell * 8
      const deg = outDegree[cell]
      for (let e = 0; e < deg; e++) {
        const dxy = D8[outDir[base + e]]
        acc[((y + dxy[1] + H) % H) * W + ((x + dxy[0] + W) % W)] += a * outW[base + e]
      }
    }
  }

  const erosionVol = new Float32Array(n)
  const flux = new Float32Array(n)
  const donorMin = new Float32Array(n)
  function fluvial(popped) {
    const { flowTarget, acc, z, litho } = v
    let maxStep = 0
    for (let i = 0; i < popped; i++) {
      const cell = popOrderM[i]
      erosionVol[cell] = 0
      const old = z[cell]
      if (old <= 0) continue
      const target = flowTarget[cell]
      if (target < 0) continue
      const zr = z[target]
      if (zr >= old) continue
      const x = cell % W
      const tx = target % W
      let ddx = Math.abs(tx - x); if (ddx > 1) ddx = 1
      let ddy = Math.abs(((target - tx) / W) - ((cell - x) / W)); if (ddy > 1) ddy = 1
      const distKm = (cellM / 1000) * (ddx && ddy ? SQRT2 : 1)
      const qKm2 = acc[cell] * cellKm2 + P.baseAreaKm2
      const F = Math.max(0, (P.kappaDt * litho[cell] * Math.pow(qKm2, P.m)) / distKm - P.thetaC)
      const znew = (old + F * zr) / (1 + F)
      const cut = old - znew
      z[cell] = znew
      erosionVol[cell] = cut * H_M * cellKm2 * 1e6
      if (cut > maxStep) maxStep = cut
    }
    return maxStep
  }

  function sediment(popped) {
    const { flowTarget, acc, z } = v
    let maxStep = 0
    flux.fill(0)
    donorMin.fill(Infinity)
    for (let i = popped - 1; i >= 0; i--) {
      const cell = popOrderM[i]
      const target = flowTarget[cell]
      let carrying = flux[cell] + erosionVol[cell]
      if (carrying > 0) {
        const land = z[cell] > 0
        const settle = land
          ? Math.max(P.settleFloorKm, P.settleXiKm * Math.sqrt(acc[cell] * cellKm2 + P.baseAreaKm2))
          : P.settleMarineKm
        const dropFrac = 1 - Math.exp(-(cellM / 1000) / settle)
        let deposit = carrying * dropFrac
        const donorCap = donorMin[cell] - 1e-5
        const cap = land ? donorCap : Math.min(donorCap, P.marineFreeboardM / H_M)
        const room = (cap - z[cell]) * H_M * cellKm2 * 1e6
        if (deposit > room) deposit = Math.max(0, room)
        const capM3 = (land ? 10 : 30) * cellKm2 * 1e6
        if (deposit > capM3) deposit = capM3
        if (deposit > 0) {
          const dz = deposit / (H_M * cellKm2 * 1e6)
          z[cell] += dz
          carrying -= deposit
          if (land && dz > maxStep) maxStep = dz
        }
      }
      if (target >= 0) {
        flux[target] += carrying
        if (z[cell] < donorMin[target]) donorMin[target] = z[cell]
      }
    }
    return maxStep
  }

  // --- the loop, timed --------------------------------------------------------
  const clock = { ocean: 0, flood: 0, ltdScan: 0, lambda: 0, mfd: 0, accum: 0, uplift: 0, fluvial: 0, sediment: 0, hill: 0, marine: 0 }
  let mark = 0
  const tick = () => { mark = performance.now() }
  const tock = (k) => { clock[k] += performance.now() - mark; mark = performance.now() }

  const t0 = performance.now()
  let residual = Infinity
  let calmStreak = 0
  let iterDone = 0
  let popped = 0
  for (let iter = 0; iter < ITERS; iter++) {
    tick()
    if (iter % ROUTING_EVERY === 0) {
      oceanSeed()
      tock('ocean')
      popped = flood()
      tock('flood')
      if (process.env.DUMP_FILLED && iter === 0) {
        writeFileSync(process.env.DUMP_FILLED, Buffer.from(v.filled.buffer, v.filled.byteOffset, n * 4))
        process.exit(0)
      }
      dispatch(J_LTD_SCAN)
      tock('ltdScan')
      lambdaWalk(popped)
      tock('lambda')
      dispatch(J_MFD)
      tock('mfd')
      accumulate(popped)
      tock('accum')
    }

    let maxStep = 0
    dispatch(J_UPLIFT)
    tock('uplift')
    maxStep = Math.max(maxStep, fluvial(popped))
    tock('fluvial')
    maxStep = Math.max(maxStep, sediment(popped))
    tock('sediment')
    v.maxStepW.fill(0)
    dispatch(J_HILL_MOVES)
    dispatch(J_HILL_APPLY)
    for (let w = 0; w < Math.max(1, NW); w++) maxStep = Math.max(maxStep, v.maxStepW[w])
    tock('hill')
    dispatch(J_MARINE_MOVES)
    dispatch(J_MARINE_APPLY)
    tock('marine')

    residual = maxStep * H_M
    calmStreak = residual < P.epsM ? calmStreak + 1 : 0
    iterDone = iter + 1
    if (iter % 25 === 0 || calmStreak >= 3) {
      process.stderr.write(`iter ${iter}  residual ${residual.toFixed(2)} m\n`)
    }
    if (calmStreak >= 3) break
  }
  const total = performance.now() - t0

  for (const w of workers) {
    Atomics.store(c, 1, J_EXIT)
    Atomics.add(c, 0, 1)
    Atomics.notify(c, 0)
  }
  await Promise.all(workers.map((w) => w.terminate()))

  console.log(`${W}×${H}, ${iterDone} iters, ${NW} workers: ${(total / iterDone).toFixed(1)} ms/iter, residual ${residual.toFixed(2)} m`)
  const floods = Math.max(1, Math.ceil(iterDone / ROUTING_EVERY))
  console.log(`  [flood detail] per flood: P1 ${(floodP1Ms / floods).toFixed(1)} ms, graph ${(floodGraphMs / floods).toFixed(1)} ms, P2 ${(floodP2Ms / floods).toFixed(1)} ms, merge ${(floodMergeMs / floods).toFixed(1)} ms`)
  for (const [k, ms] of Object.entries(clock).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(9)} ${(ms / iterDone).toFixed(1).padStart(7)} ms/iter  ${(100 * ms / total).toFixed(1).padStart(5)} %`)
  }

  if (outDir) {
    mkdirSync(outDir, { recursive: true })
    const u16 = new Uint16Array(n)
    for (let i = 0; i < n; i++) {
      const val = Math.round(((v.z[i] + 1) / 2) * 65535)
      u16[i] = val < 0 ? 0 : val > 65535 ? 65535 : val
    }
    writeFileSync(join(outDir, 'elevation.u16'), Buffer.from(u16.buffer))
    let landCells = 0
    for (let i = 0; i < n; i++) if (v.z[i] > 0) landCells++
    writeFileSync(join(outDir, 'meta.json'), JSON.stringify({
      key: { worldUid: 'p1', worldId: meta.key.worldId, pipelineVersion: 'v2-p1', stage: `${W}` },
      width: W, height: H, engine: 'erosion-v2-p1-spike', workers: NW,
      params: P, iters: iterDone, residualM: residual, landFraction: landCells / n,
    }))
  }
}
