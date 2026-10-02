import { PLANET_INPUTS } from './planetInputParams'
import { detCos, detPow, detSin, sq } from '../core/detMath'

// PLANETARY FORCING (decision 13): the four astronomical controls as the
// factors the climate chain multiplies in. Every factor is 1 at the
// default — Earth — so a world built before the Planet stage existed reads
// back unchanged, and the climate panel's own knobs (contrast, humidity,
// equator) keep meaning what they meant: contrast is now the atmosphere's
// and ocean's heat transport on top of what the orbit dictates.
export interface PlanetForcing {
  obliquityDeg: number
  // Fraction, not percent.
  eccentricity: number
  precessionDeg: number
  // Fraction of Earth's solar constant.
  solarConstant: number
  rotationHours: number
  // THE LAND-PLANTS MOMENT (phase 5.5, the Planet stage's schedule): the
  // world age in Myr from which vegetation covers the land (surface/
  // cover.ts). Zero — from the start — until the schedule is a control.
  landPlantsFromMa: number
}

// The orbit is not a control (planetInputParams.ts): Earth's eccentricity
// and a perihelion at the equinox, which biases neither hemisphere. Phase
// 5's schedule moves them over the epochs.
export const EARTH_ECCENTRICITY = 0.0167
export const EQUINOX_PERIHELION_DEG = 90
// The sun is not a control either (planetInputParams.ts): Earth's.
export const EARTH_SOLAR_CONSTANT = 1

export const DEFAULT_PLANET_FORCING: PlanetForcing = {
  obliquityDeg: PLANET_INPUTS.obliquity.default,
  eccentricity: EARTH_ECCENTRICITY,
  precessionDeg: EQUINOX_PERIHELION_DEG,
  solarConstant: EARTH_SOLAR_CONSTANT,
  rotationHours: PLANET_INPUTS.rotation.default,
  landPlantsFromMa: 0,
}

const RAD = Math.PI / 180

// The equator-to-pole gradient of the ANNUAL MEAN insolation goes with
// (2 − 3 sin²ε) — the P₂ coefficient of Ward (1974): zero at 54.7°, where
// every latitude gets the same yearly sun, negative beyond, where the poles
// get more. Relative to the default tilt.
export function obliquityContrast(obliquityDeg: number): number {
  const s = (deg: number): number => 2 - 3 * sq(detSin(deg * RAD))
  return s(obliquityDeg) / s(PLANET_INPUTS.obliquity.default)
}

// The mean temperature shift of a different sun, from the planetary energy
// balance T ∝ S^¼ at Earth's effective temperature of 255 K: +0.6 °C per
// percent, no feedbacks (the greenhouse control is the feedback knob).
export function solarTemperatureOffsetC(solarConstant: number): number {
  return 255 * (detPow(Math.max(0.01, solarConstant), 0.25) - 1)
}

// The seasonal amplitude of one hemisphere: the tilt sets the swing (none
// at 0°, relative to the default), the orbit biases it — the hemisphere
// whose summer falls at perihelion swings 2e stronger, the other 2e weaker
// (the insolation at perihelion over aphelion is (1+e)²/(1−e)² ≈ 1 + 4e,
// half of it per hemisphere). Precession 0 puts perihelion in the top
// hemisphere's summer, 180 in the bottom's, 90 at an equinox.
export function seasonalityFactor(forcing: PlanetForcing, north: boolean): number {
  const tilt = detSin(forcing.obliquityDeg * RAD) / detSin(PLANET_INPUTS.obliquity.default * RAD)
  const bias = 2 * forcing.eccentricity * detCos(forcing.precessionDeg * RAD)
  return Math.max(0, tilt * (1 + (north ? bias : -bias)))
}

// Where the Hadley cell ends, as a fraction of the equator-to-pole span:
// Held & Hou (1980) put its extent at 1/Ω, so it scales with the rotation
// period from a third of the way at 24 h; clamped so the three cells of
// wind.ts keep a band each.
export function hadleyEdge(rotationHours: number): number {
  const edge = (1 / 3) * (rotationHours / PLANET_INPUTS.rotation.default)
  return Math.min(0.9, Math.max(0.1, edge))
}
