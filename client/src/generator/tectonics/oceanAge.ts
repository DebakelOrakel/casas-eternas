import type { Domain } from '../core/domain'
import { sharedFieldMesh } from '../fields/fieldMesh'

// Ocean-floor age as a coarse full-surface field (Phase 3, see
// docs/decisions/continental-crust-rafts.md). Oceanic crust deepens as it ages
// away from the ridge that formed it (the real √age depth law), so the ocean
// baseline follows GDH1's age-depth curve (the engine's elevation_field.rs,
// the gdh1* entries of elevation_tune_params.rs). This is a
// deliberate, bounded exception to the "no full-surface accumulator" stance:
// it's only the ocean-age scalar, which is smooth and large-scale, so a coarse
// field is plenty. The field is carried with plate motion each epoch; the
// crust the plates open at a divergent boundary starts at half an epoch
// (the engine's `advect_ocean_age`).
//
// ON A FIELD MESH (DEC-0036 phase 2, docs/decisions/fields-on-meshes.md):
// one Float64 value per cell of the ocean age's field mesh (fields/
// fieldMesh.ts — Goldberg cells on the sphere, hexagons on the torus), in
// epochs. One code for both shapes: no pole rows, no disc boxes. The
// 256 × 128 chart raster it had until 2026-10-11 survives only as the
// engine render's lookup; readers per point go through the
// sampler (the engine's `ocean_age_at`), the save holds the mesh's own values.

// The spacing as a raster's: the domain's width over OCEAN_AGE_RES_X — a
// cell as wide as the former 256 × 128 raster's at the equator (62.4 km on
// the torus at 2048 × 1024, 78.1 km on the 20 000 km sphere). Counted on
// the width as the raster was, so a harness world narrower than 2048 has
// the same number of cells, each smaller.
export const OCEAN_AGE_RES_X = 256

// Whether a save's ocean age belongs to this domain's field mesh: its cell
// count and its spacing, as the engine's `ocean_age_fits` checks them. The
// field itself is the engine's — the walk, the transport and the saved
// values (`EngineWorld.savedFields`, in the Archean too).
export function oceanAgeFits(domain: Domain, cells: number, spacingM: number): boolean {
  const cellM = (domain.width / OCEAN_AGE_RES_X) * domain.metresPerUnit
  return cells === sharedFieldMesh(domain, cellM).mesh.count && spacingM === cellM
}
