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

// The class from twelve months: temperature °C and rain mm per month,
// January first. The summer half is the warmer six months (April–September
// or October–March), whichever hemisphere the place is in.
export function classifyKoppen(t: ArrayLike<number>, p: ArrayLike<number>): number {
  let mat = 0
  let map = 0
  let thot = -Infinity
  let tcold = Infinity
  let tmon10 = 0
  let pdry = Infinity
  for (let m = 0; m < 12; m++) {
    mat += t[m] / 12
    map += p[m]
    if (t[m] > thot) thot = t[m]
    if (t[m] < tcold) tcold = t[m]
    if (t[m] > 10) tmon10++
    if (p[m] < pdry) pdry = p[m]
  }
  // April–September is summer where it is the warmer half.
  let aprSep = 0
  for (let m = 3; m < 9; m++) aprSep += t[m]
  const summerAprSep = aprSep >= mat * 6
  let psum = 0
  let psdry = Infinity
  let pswet = 0
  let pwdry = Infinity
  let pwwet = 0
  for (let m = 0; m < 12; m++) {
    const summer = (m >= 3 && m < 9) === summerAprSep
    if (summer) {
      psum += p[m]
      psdry = Math.min(psdry, p[m])
      pswet = Math.max(pswet, p[m])
    } else {
      pwdry = Math.min(pwdry, p[m])
      pwwet = Math.max(pwwet, p[m])
    }
  }

  // E before B, as Peel orders it: a cold place is polar however dry.
  if (thot < 10) return koppenId(thot > 0 ? 'ET' : 'EF')

  // B: drier than the threshold its warmth and its rain's season ask for.
  const threshold = psum >= 0.7 * map ? 2 * mat + 28 : map - psum >= 0.7 * map ? 2 * mat : 2 * mat + 14
  if (map < 10 * threshold) {
    const desert = map < 5 * threshold
    const hot = mat >= 18
    return koppenId(desert ? (hot ? 'BWh' : 'BWk') : (hot ? 'BSh' : 'BSk'))
  }

  if (tcold >= 18) {
    if (pdry >= 60) return koppenId('Af')
    if (pdry >= 100 - map / 25) return koppenId('Am')
    return koppenId(psdry < pwdry ? 'As' : 'Aw')
  }

  const group = tcold > 0 ? 'C' : 'D'
  const season = psdry < 40 && psdry < pwwet / 3 ? 's' : pwdry < pswet / 10 ? 'w' : 'f'
  const heat = thot >= 22 ? 'a' : tmon10 >= 4 ? 'b' : group === 'D' && tcold < -38 ? 'd' : 'c'
  return koppenId(`${group}${season}${heat}` as KoppenCode)
}

// Twelve months from the annual figures, where only those exist (the
// history's epochs, the climate before refinement): the temperature a
// cosine of half the seasonal range around the mean, warmest in July in the
// top hemisphere; the rain the two seasons the monsoon index was made of,
// (P_N − P_S) / (P_N + P_S + floor), with its sign as the phase. The same
// curves the hover chart draws. `t` and `p` are written, mm per month.
export function synthesizeMonths(meanC: number, rangeC: number, annualMm: number, monsoonIndex: number, north: boolean, floorMm: number, t: Float64Array, p: Float64Array): void {
  const sign = north ? 1 : -1
  const half = (monsoonIndex * (2 * annualMm + floorMm)) / 2
  for (let m = 0; m < 12; m++) {
    const c = Math.cos(((m - 6) / 12) * 2 * Math.PI) // 1 in July
    t[m] = meanC + sign * (rangeC / 2) * c
    p[m] = Math.max(0, (annualMm + half * c) / 12)
  }
}
