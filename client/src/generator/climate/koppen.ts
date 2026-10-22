// KÖPPEN–GEIGER CLIMATE CLASSES (build step 5 of
// docs/design/climate-refinement.md): the class of a place from its twelve
// months of temperature and rain, after the rules of Peel, Finlayson and
// McMahon (2007), Hydrol. Earth Syst. Sci. 11, 1633–1644. The biomes are
// derived from these classes (biomes.ts), not from the annual means alone:
// the months are what tell a dry summer from a dry winter at the same total.
//
// Ids are stable: the save and the layer store them. 0 is "no class" (sea).

export const KOPPEN_CODES = [
  '', 'Af', 'Am', 'Aw', 'As', 'BWh', 'BWk', 'BSh', 'BSk',
  'Csa', 'Csb', 'Csc', 'Cwa', 'Cwb', 'Cwc', 'Cfa', 'Cfb', 'Cfc',
  'Dsa', 'Dsb', 'Dsc', 'Dsd', 'Dwa', 'Dwb', 'Dwc', 'Dwd', 'Dfa', 'Dfb', 'Dfc', 'Dfd',
  'ET', 'EF',
] as const

export type KoppenCode = Exclude<(typeof KOPPEN_CODES)[number], ''>

const ID = new Map<string, number>(KOPPEN_CODES.map((c, i) => [c, i]))
export const koppenId = (code: KoppenCode): number => ID.get(code)!
export const koppenCode = (id: number): KoppenCode | null => (id > 0 && id < KOPPEN_CODES.length ? (KOPPEN_CODES[id] as KoppenCode) : null)

// The class's i18n key (koppen.json); the worker holds keys, not names.
// No class (the sea) has none: the readout shows no row there.
export const koppenLabelKey = (id: number): string => (koppenCode(id) ? `koppen.${koppenCode(id)}` : 'biome.unknown')

// Colours after the common Köppen map palette (Beck et al. 2018), so the
// layer reads like the maps people know.
const KOPPEN_COLORS: Record<KoppenCode, [number, number, number]> = {
  Af: [0, 0, 255], Am: [0, 120, 255], Aw: [70, 170, 250], As: [110, 195, 250],
  BWh: [255, 0, 0], BWk: [255, 150, 150], BSh: [245, 165, 0], BSk: [255, 220, 100],
  Csa: [255, 255, 0], Csb: [200, 200, 0], Csc: [150, 150, 0],
  Cwa: [150, 255, 150], Cwb: [100, 200, 100], Cwc: [50, 150, 50],
  Cfa: [200, 255, 80], Cfb: [100, 255, 80], Cfc: [50, 200, 0],
  Dsa: [255, 0, 255], Dsb: [200, 0, 200], Dsc: [150, 50, 150], Dsd: [150, 100, 150],
  Dwa: [170, 175, 255], Dwb: [90, 120, 220], Dwc: [75, 80, 180], Dwd: [50, 0, 135],
  Dfa: [0, 255, 255], Dfb: [55, 200, 255], Dfc: [0, 125, 125], Dfd: [0, 70, 95],
  ET: [178, 178, 178], EF: [102, 102, 102],
}

export function koppenColor(id: number): [number, number, number] {
  const code = koppenCode(id)
  return code ? KOPPEN_COLORS[code] : [128, 128, 128]
}
