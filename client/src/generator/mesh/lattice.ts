import type { Domain } from '../core/domain'
import { buildFromTriangles, type PeriodicTriangulation } from './periodicDelaunay'

// The bootstrap: a hexagonal lattice over the whole domain at one spacing,
// already a closed periodic triangulation. Everything finer is inserted
// into it (meshBuild.ts), and its own points are ordinary vertices the
// density rule may later remove. Rows alternate a half-cell offset, which
// needs an even row count to close over the seam; the columns and rows
// are rounded so the lattice tiles the domain exactly. The minimum of
// eight in each direction keeps every edge far inside the one-sheet
// margin of periodicDelaunay.ts.
export function hexLattice(domain: Domain, spacing: number): PeriodicTriangulation {
  const cols = Math.max(8, Math.round(domain.width / spacing))
  let rows = Math.max(8, Math.round(domain.height / (spacing * Math.sqrt(3) / 2)))
  if (rows % 2 === 1) rows++
  const dx = domain.width / cols
  const dy = domain.height / rows
  const count = cols * rows
  const xs = new Float64Array(count)
  const ys = new Float64Array(count)
  for (let j = 0; j < rows; j++) {
    const offset = j % 2 === 0 ? 0 : 0.5
    for (let i = 0; i < cols; i++) {
      xs[j * cols + i] = (i + offset) * dx
      ys[j * cols + i] = (j + 0.5) * dy
    }
  }
  const id = (i: number, j: number): number => ((j + rows) % rows) * cols + ((i + cols) % cols)
  const tris = new Int32Array(count * 2 * 3)
  let n = 0
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      if (j % 2 === 0) {
        // Even row: the row above is shifted right by half a cell.
        tris[n++] = id(i, j); tris[n++] = id(i + 1, j); tris[n++] = id(i, j + 1)
        tris[n++] = id(i + 1, j); tris[n++] = id(i + 1, j + 1); tris[n++] = id(i, j + 1)
      } else {
        tris[n++] = id(i, j); tris[n++] = id(i + 1, j); tris[n++] = id(i + 1, j + 1)
        tris[n++] = id(i, j); tris[n++] = id(i + 1, j + 1); tris[n++] = id(i, j + 1)
      }
    }
  }
  const mesh = buildFromTriangles(domain, xs, ys, count, tris)
  mesh.legaliseAll()
  return mesh
}
