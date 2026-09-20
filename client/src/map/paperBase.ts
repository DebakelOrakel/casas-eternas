// The map's neutral "paper" base: the packed relief bytes (top bit = land,
// low 7 bits = shade 0..127 — see generator/render/reliefShade.ts) expanded
// into RGBA. Land = near-white grey, ocean = light blue, each modulated by
// the hillshade so relief reads on water too. Extracted from WorldGenScreen
// (2026-08-07) so the worldmap screen renders the identical paper from a
// saved world's elevation raster.

export function buildPaperBase(relief: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(relief.length * 4)
  for (let i = 0; i < relief.length; i++) {
    const v = relief[i]
    const shade = (v & 127) / 127
    const p = i * 4
    if (v & 128) {
      // Land: near-white, subtle grey shading.
      const b = 210 + shade * 45
      out[p] = b
      out[p + 1] = b
      out[p + 2] = b
    } else {
      // Ocean: light blue, subtle bathymetric shading.
      out[p] = 178 + shade * 30
      out[p + 1] = 206 + shade * 22
      out[p + 2] = 230 + shade * 18
    }
    out[p + 3] = 255
  }
  return out
}

// The same paper with the shade held at its maximum — for surfaces that are
// lit for REAL instead of wearing the baked hillshade (the relief preview's
// displaced meshes; see ToroidalMapView.reliefTexture).
export function buildUnshadedPaperBase(relief: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(relief.length * 4)
  for (let i = 0; i < relief.length; i++) {
    const p = i * 4
    if (relief[i] & 128) {
      out[p] = 255
      out[p + 1] = 255
      out[p + 2] = 255
    } else {
      out[p] = 208
      out[p + 1] = 228
      out[p + 2] = 248
    }
    out[p + 3] = 255
  }
  return out
}
