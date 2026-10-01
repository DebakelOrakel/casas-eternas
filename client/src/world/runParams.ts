import { ARCHEAN_INPUTS } from '../generator/archean/archeanInputParams'
import { CLIMATE_INPUTS } from '../generator/climate/climateInputParams'
import type { WeatherParams } from '../generator/climate/weather'
import { metersToElevation, waterSliderToOffsetM } from '../generator/elevation/elevationScale'
import { DEFAULT_PLANET_FORCING } from '../generator/planet/planetForcing'

// A WORLD'S RECORDED VALUES AS ITS RUNS TAKE THEM. The spec and the
// history (world/save) hold the controls' values by path; the generator's
// runs take model parameters. The mapping between them stood in the
// generator screen, and a replay of the history (docs/decisions/
// detail-ladder.md, fork 2) had to copy it (measured 2026-10-01). One home
// for the screen and the replay, so a change to a mapping changes both.

// Mantle vigour → mixing per epoch. Higher vigour = less stirring = finer
// field = more, smaller plates.
//
// **Quadratic, not linear**, because the response is squeezed against zero. Measured
// plate count against diffusion, mean of three seeds at 250 epochs:
//
//     diffusion   0    0.03  0.08  0.15  0.25  0.40  0.70  1.0  1.7  3.0
//     plates     24.3  22.3  19.0  18.3  13.3  10.3  11.0   10    6  6.5
//
// Half the total swing (24 → 13) happens below diffusion 0.25, and nothing at all
// happens above ~1.7. A linear slider would therefore spend a third of its travel in
// the saturated tail and cram the entire upper half of the range into its last step —
// which is exactly what the first attempt did, and why it read as a switch rather
// than a control.
const MANTLE_DIFFUSION_MAX = 2.25
const MANTLE_DIFFUSION_CURVE = 2
export function mantleDiffusionFromVigour(vigour: number): number {
  return MANTLE_DIFFUSION_MAX * ((ARCHEAN_INPUTS.mantleVigour.max - vigour) / (ARCHEAN_INPUTS.mantleVigour.max - ARCHEAN_INPUTS.mantleVigour.min)) ** MANTLE_DIFFUSION_CURVE
}

// The water control → the Archean's sea-level offset, elevation units.
export function seaLevelOffsetFromWater(water: number): number {
  return metersToElevation(waterSliderToOffsetM(water))
}

// The planet and climate controls → the weather a run computes with.
// `value` reads a control's value by its spec path.
export function weatherParamsFrom(value: (path: string) => number): WeatherParams {
  return {
    temperatureOffset: value('planet.greenhouse'),
    temperatureContrast: CLIMATE_INPUTS.contrast.toModel(value('climate.contrast')),
    humidity: CLIMATE_INPUTS.humidity.toModel(value('climate.humidity')),
    // The thermal equator sits at the map's middle since 2026-09-26 (the
    // shift slider is gone; the map draws the equator instead).
    equatorOffset: 0,
    // The Planet stage's forcing, in model units (planet/planetForcing.ts).
    planet: {
      obliquityDeg: value('planet.obliquity'),
      eccentricity: DEFAULT_PLANET_FORCING.eccentricity,
      precessionDeg: DEFAULT_PLANET_FORCING.precessionDeg,
      solarConstant: DEFAULT_PLANET_FORCING.solarConstant,
      landPlantsFromMa: DEFAULT_PLANET_FORCING.landPlantsFromMa,
      rotationHours: value('planet.rotation'),
    },
  }
}
