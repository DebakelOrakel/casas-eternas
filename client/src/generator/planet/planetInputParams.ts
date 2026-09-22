import type { InputParam } from '../core/inputParams'

// THE PLANET STAGE's controls (ADAPTIVE_MESH_PLAN.md F2, decision 13 of
// adaptive-mesh.md): what depends on the planet and not on the relief, set
// before the genesis. `greenhouse` moved here from the climate panel and
// keeps its model semantics; its old spec path is read as an alias
// (worldSpec.ts). The water stayed with the genesis, whose Archean it feeds
// (it sat here for an hour on 2026-09-22 and left the mantle panel
// orphaned). The astronomical
// controls act through planet/planetForcing.ts on the final climate only —
// the per-epoch climate of phase 5 reads the same values.
//
// Defaults are Earth's, and every effect is normalised to the default, so
// a world built before the stage existed reads back byte-identical.
//
// NOT controls, by decision 2026-09-22: the orbit's eccentricity and
// perihelion (they bias one hemisphere's seasons by 2e — 3 % at Earth's
// value, invisible — and matter only as the cycles of phase 5's climate
// history) and the solar constant (a mean shift the greenhouse control
// already gives; it returns as the planet's fixed property when phase 5
// makes the greenhouse a schedule). Both sit in planetForcing.ts at
// Earth's values until then.
export const PLANET_INPUTS = {
  // Axial tilt, degrees. Sets how sharply the annual insolation falls from
  // the equator to the poles (flat at 54.7°, reversed beyond) and how strong
  // the seasons are (none at 0). On the torus the axis is the declared
  // latitude mapping (core/domain.ts): the tilt says how far the sun wanders
  // between the bands over the year, as it does on the sphere. The range is
  // the window the climate chain is calibrated for (2026-09-22): under 10°
  // the seasons and with them the monsoon vanish, above 40° the seasonal
  // swing leaves the calibrated band (seasonMaxAmplitude 42 °C becomes
  // 68 °C at 40°, 91 °C at 60°) and from 54.7° the gradient reverses — a
  // Uranus, not a world to play on.
  obliquity: {
    min: 10, max: 40, step: 0.5, default: 23.5,
    i18n: 'generator.panel.planet.obliquity',
    unit: 'common.unit.degrees',
    inSpec: true,
  },
  // Greenhouse warming, °C added everywhere — the climate panel's former
  // temperature offset, unchanged in effect.
  greenhouse: {
    min: -20, max: 20, step: 1, default: 0,
    i18n: 'generator.panel.planet.greenhouse',
    unit: 'common.unit.celsius',
    inSpec: true,
  },
  // Rotation period, hours: a slower spin widens the Hadley cell, a faster
  // one narrows the bands. 16–36 h (2026-09-22): the trade-wind belt ends
  // at 20° or at 45° at the ends, two latitude bands of desert shift each
  // way, and the window keeps an Earth-like day; 72 h would be one cell to
  // the pole (Venus), 6 h Jupiter's stripes.
  rotation: {
    min: 16, max: 36, step: 1, default: 24,
    i18n: 'generator.panel.planet.rotation',
    unit: 'common.unit.hours',
    inSpec: true,
  },
} satisfies Record<string, InputParam>
