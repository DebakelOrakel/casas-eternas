// Shared between worldgen.worker.ts (which sizes the generated pixel
// buffer) and WorldGenScreen.ts (which sizes the initial placeholder
// texture) so the two can't drift out of sync.
export const TEXTURE_WIDTH = 1024
export const TEXTURE_HEIGHT = 512
