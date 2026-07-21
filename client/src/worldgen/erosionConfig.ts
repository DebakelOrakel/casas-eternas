// Shared between worldgen.worker.ts (which sizes the erosion grid) and
// WorldGenScreen.ts (which needs the same dimensions to interpret the
// eroded elevation buffer it gets back), so the two can't drift out of
// sync — same reasoning as textureConfig.ts's own split.
//
// 2048x1024: fixed, one-shot (recomputed only when the erosion button is
// clicked, not every tectonic epoch like the color texture). Chosen to
// comfortably exceed what the render mesh can ever display (see
// WorldGenScreen.ts's planet mesh segment count) rather than for its own
// sake — a future ground-level/LOD view will need its own chunked
// generation regardless of any resolution picked here, so there's no
// point going higher just to have more numbers on hand.
export const EROSION_GRID_WIDTH = 2048
export const EROSION_GRID_HEIGHT = 1024
