---
summary: The three foundational forks for hex tiling, decided together — rivers run THROUGH the tile anchored at edge ports (not along edges), the hex is 300 m flat-to-flat and defined as identical to the shader lattice, and zoom stays one continuous axis where "stages" are thresholds, never detents.
date: 2026-08-13
area: ui
stage: decided
status: decided 2026-08-13; nothing built yet — the staged build plan lives in docs/design/hex-world-view.md
---

# Hex Tiling: The Foundational Forks

[design/hex-world-view.md](../design/hex-world-view.md) sketched the hex
world view and named its open forks. The three that everything else hangs
on were decided on 2026-08-13; this doc records them. The remaining open
questions (developability grades, rewilding pace, the organic/geometric
register boundary) stay in the design doc — they are tuning, not forks.

## Fork 1 — Rivers: through the tile, anchored at ports

**Options.** (a) Rivers cross a tile as a spline between edge ports;
(b) rivers live *on* hex edges, tiles stay whole.

**Answer: (a), through the tile, connected via the ports.**

**Why.** The design doc flagged this as the one hard-to-reverse choice in
the port design, so it is decided first. Through-tile wins on the facts:
the existing pure-D8 river routing hands the port topology over for free
(every river tile has n in-ports and at most one out-port — confluences
are "two splines merge"); almost all real rivers are narrower than a
300 m tile, so one-tile-wide rivers are honest; and edge-based rivers
would quantise the network to 60° turns and fight the vector data the
save already carries. The ⅓/⅔ edge ports (never corners) remain the seam
contract exactly as designed — reservation, tangent rule, width
attribute.

## Fork 2 — Hex size: 300 m flat-to-flat, final

**Options.** The 250–350 m band from the design discussion.

**Answer: 300 m, no longer a candidate.**

**Why.** The three independent constraints that landed on the same number
hold: 1/26 of a 7.8 km macro cell (one cell refines into a clean ~26×26
hex chunk), one hex ≈ 7.8 ha ≈ one historical Hufe (a farm is one tile,
nearly literally), and a river plus a road pass one edge side by side
(ports ~58 m apart). The deciding extra fact: the rendered grid is
already torus-snapped at exactly this size — `HEX_COL_SPACING =
world width / 53248` in `map/mapSceneSettings.ts` gives exact 300 m
columns. **The logical grid is defined as identical to that shader
lattice**; `mapSceneSettings` is the single source of truth, and any hex
math module must derive from those constants rather than restate them.

## Fork 3 — Zoom: one continuous axis; thresholds, not detents

**Options.** (A) Keep the continuous exponential zoom and express
"stages" purely as altitude thresholds; (B) discrete zoom stages the
camera snaps between.

**Answer: (A). Explicitly no snapping.**

**Why.** The built camera ladder is deliberately ONE continuous descent
(map → relief → perspective near-ground), and detents would break it and
turn the existing fades into jumps. Excess detail at distance is already
handled the threshold way: the hex grid only fades in below ~40 km
altitude (fully visible ~16 km, `HEXGRID_FADE`) plus a near-field
distance fade against moiré. Hex *interaction* (hover, pick, later
develop) follows the same pattern — it arms below full grid visibility
as a threshold on the continuous axis, not as a mode switch. This also
resolves the open "zoom levels" question raised 2026-08-08.
