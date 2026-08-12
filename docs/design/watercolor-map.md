---
summary: Design direction for the world map's look — watercolour rendering, and the discovery that the game's three knowledge states (unexplored / explored / active) map onto the stages of an actual watercolour painting, so the medium carries the state readout without a legend.
date: 2026-08-11
area: ui
stage: building
status: all three prototype stages BUILT 2026-08-11 (knowledge registers on the CPU, the paper post-process, edge darkening) — with two of the plan's calls reversed on contact, see the "Revised on contact" boxes. The knowledge field itself is still a debug stand-in: exploration does not exist
---

# The Watercolour Map

Captures a design discussion (2026-08-11) that started as a look question —
"can the map be painted rather than rendered?" — and turned out to answer a
second, unrelated one: how the game shows what the player knows.

Nothing here is decided. The two questions are written up together because
their answer is the same mechanism, and separating them again would lose the
reason the direction is attractive at all.

## The medium

Watercolour NPR is a solved research area, not something to invent. The
reference paper is Curtis et al. 1997 ("Computer-Generated Watercolor", the
full fluid model); the real-time treatment is Bousseau et al. 2006
("Interactive watercolor rendering with temporal coherence and abstraction"),
which addresses exactly the case here — a moving camera over painted content.

The look decomposes into five independent ingredients, each a few lines of
fragment shader:

- **Pigment density instead of alpha.** Watercolour layers subtractively.
  Fading a wash out with alpha reads as "opacity turned down", never as paint
  running out. A Kubelka-Munk approximation (`c' = c·(1−(1−c)·d)`, `d` =
  density) is enough.
- **Edge darkening.** The signature feature: pigment collects at the drying
  rim. `1 − exp(−k·‖∇mask‖)` as a multiplier.
- **Granulation.** Pigment settles into the paper's tooth — a noise field
  modulating density.
- **Ragged boundaries.** Not circles, lobes. Radius plus fBm on direction.
  This one already exists in the codebase, on the CPU: `expandBiomeIds` in
  `ui/mapOverlay/biomePaper.ts` warps its sample coordinate through periodic
  value noise for precisely this reason, and the note there about wavelength
  (`WARP_LATTICE_MIN_PIXELS`) is the same lesson a shader version would have
  to learn again.
- **Droplets and runs.** Procedural hashed discs for spatter; noise stretched
  along one axis for the drips.

### What Babylon gives us (9.17)

- **`PostProcess` + `Effect.ShadersStore`** — a free full-screen fragment
  pass after the scene. The natural home for anything that belongs to the
  *sheet*: vignette falloff, paper fibre, spatter.
- **`MaterialPluginBase`** — fragment code injected into an existing
  material. Already proven here by `map/hexGridMaterialPlugin.ts`, which
  carries world XZ per fragment as its own varying (`vHexWorldPos`) — exactly
  what world-anchored pigment needs, already computed.
- **`CustomProceduralTexture`** — bake the paper grain once instead of
  evaluating it per frame.
- **`DefaultRenderingPipeline.imageProcessing.vignette*`** — too round and
  too clean to be the answer, but a five-line way to test whether the
  direction appeals at all.
- The background is already paper-coloured: `WorldMapScreen` clears to pure
  white. It should become a slightly warm off-white — pure white reads as
  *absence*, not as a sheet.

## The core idea: knowledge is paint completeness

A watercolour is built in stages: blank paper → a first pale wash laid
wet-in-wet → glazes on dry paper, edge darkening, pen work on top. That is a
single ordered axis, and it is legible without being taught. Nobody has to
learn that "purple means explored"; that a region looks *unfinished* is
understood on sight. The ordering is also physically honest — you cannot glaze
what has not been washed.

The game's three knowledge states are three stops on that one axis.

| | **Unexplored** | **Explored** | **Active** |
|---|---|---|---|
| Painting stage | bare paper | first wash, wet-in-wet | glaze on dry + pen work |
| Pigment density | 0 | ~30 %, heavily desaturated | 100 %, full palette |
| Boundaries | — | soft, bleeding, heavily warped | crisp, edge-darkened |
| Granulation | paper tooth bare | drowned by the wash | pigment sits in the grain |
| Relief | none | none | full hillshade + amplified fine detail |
| Line work | — | coast and rivers as single confident lines | contours, hex grid, labels, hatching |
| Detail tier | — | macro raster (2048) | bake tier (4k/8k) |

Three states separated on **four coupled axes at once** — saturation,
sharpness, detail, presence of line work. That is what makes them readable
peripherally, in greyscale, and for colour-vision deficiency. Redundant coding
is the point, not a luxury.

The content logic agrees with the medium: "explored" means *one fact per
area* ("this is savanna"), which is a flat wash — no relief, no texture,
nothing that implies you have walked it. Only people living somewhere know its
hills. Rivers and coastlines are the exception and belong in the explored
tier: they are the first things any traveller's account gets right and the
last thing terrain detail arrives for.

**The trap to design around:** desert at 30 % density on warm paper *is* the
paper. The distinction must therefore not rest on lightness but on **grain** —
bare paper shows its fibre, any wash drowns it. That survives even the palest
biome.

**The palette is the map's own** (built 2026-08-11, `map/terrainPalette.ts`).
It is keyed on the same classification as the generator's `biomeColor` and is
free to disagree with it, for the same reason the overlays below are: the
generator's palette is a DATA VIEW, tuned so twelve classes stay apart while a
simulation is being tuned, while this one is how the world LOOKS — free to
collapse a distinction the data view needs (boreal and temperate forest are
both dark conifer green from above) and to open one it does not care about.
Sharing a palette would mean neither could be tuned without damaging the other.
The colours are therefore named as pigments rather than as labels.

## The frontier

Not an edge: a **wet bleed**. Two things follow for free.

- **No fog-of-war explanation needed.** Paint running out needs no boundary,
  so there is no system edge to justify.
- **No honeycomb silhouette.** If exploration is tracked per hex (see
  [hex-world-view.md](./hex-world-view.md)), a hex-shaped frontier would be
  fatal. The same warp that already disguises biome blocks dissolves it — and
  as a bonus lets the knowledge field stay coarse (512×256 is plenty), because
  the drawn boundary meanders a cell or two regardless.

The droplets from the reference image, decoration until now, acquire a
meaning here: **spatter beyond the frontier is rumour** — places heard of,
never mapped. Free, and it gives the effect a reason to exist.

## Motion

Revealing should **run in**, not fade in: a couple of seconds of wet
spreading (larger bleed radius, no edge darkening), then it "dries" and the
rim sets. It is the most characteristic motion the medium has, and it turns
discovery into an event rather than a state change.

Which also answers how scouting and trade differ. A **bought map is another
cartographer's hand**: it appears dry and instantly, on slightly different
paper, pasted in with a visible deckle edge. Unmistakable, and it costs no
extra axis — it is the same "explored" tier with a different sheet. It also
opens the door to maps that are *wrong*: purchased knowledge that corrects
itself when you finally arrive.

## Overlays

One rule rather than a decision per overlay: **overlays are ink over paint** —
a different medium, legitimately sitting on any painting stage, but clipped by
the same knowledge field. A resource overlay over land nobody has seen has no
content; that needs no separate ruling.

The register shift worth keeping in mind: in the generator, overlays are a
**data view** (flat false colour — I am inspecting a simulation); in the game
they want to be **annotation** (hatching, symbols, marginalia — I am reading
my map). Same field, different register. This is its own discussion and
connects to the overlay rethink already flagged at the end of
[hex-world-view.md](./hex-world-view.md).

## How it would fall out in code

Two layers, because two different things are meant:

1. **The sheet — screen space, `PostProcess`.** Vignette falloff to paper,
   paper fibre, spatter, drips. The sheet is in front of you and does not move
   with the world, which is correct.
2. **The pigment — world space, material plugin on both map materials.**
   Density curve, edge darkening, granulation, keyed off `vHexWorldPos`.
   Colour sticks to the world.

Everything hangs off **one scalar world field `k ∈ [0,1]`**, with the three
states as *bands* rather than classes — classify it and the hard edges come
straight back.

The cost is low because the "explored" state is what already ships, with the
numbers turned down: `BIOME_DESATURATE` and `BIOME_ALPHA` in `WorldMapScreen`
are already exactly the two knobs that separate the tiers. They stop being
constants and become functions of `k`. "Active" is today's look plus edge
darkening and the amplified tier; "unexplored" is `k = 0`.

**Not on the CPU.** The existing compositor path (`MapOverlayCompositor`,
`applyBiomeWash`) is the wrong place: at 2048×1024 the map is ~7.8 km per
cell, so edge darkening and droplets would be mush at zoom, and any
camera-relative falloff would mean recompositing 2M pixels per pan frame.

### Known traps

- **The shower-door effect** — the field's classic failure, and half of what
  Bousseau 2006 is about: grain and spatter pinned in screen space while the
  world slides underneath. For the *fibre* of a paper map that is arguably
  correct (the sheet is the sheet); for pigment structure it is not. Hence the
  two-layer split above.
- **The near regime.** The descent switches to fog, sky and real lighting
  (`WorldMapScreen`'s near-mode handling). A watercolour vignette over a
  ground-level view would be absurd; the whole effect has to fade out along
  the same altitude ramp that already drives `getSunWorldBlend`.

## Player settings are not the tuning knobs

Decided in discussion (2026-08-11), because it is expensive to reverse later:
**a player setting may change how strongly something is shown, never what it
means.** The relative ordering and spacing of the three knowledge tiers carries
information and is not adjustable.

Density curve, edge-darkening strength, grain scale and paper tone are
therefore *art direction*, not preference. If the player can move them, the
tier legibility can never be relied on and every screenshot shows a different
game. They get tuned once and frozen.

Two things do legitimately reach the player, and they happen to use the same
shader constants for entirely different reasons:

- **Performance** — the post-process costs, grain and droplets first.
  "Painterly effects: full / reduced / off."
- **Legibility** — the explored tier is deliberately low in contrast, which is
  a real problem for some eyes and small screens. "Separate knowledge tiers
  more strongly" is an accommodation, not a taste knob.

So: a handful of NAMED settings derived from the frozen values, written after
tuning ends — never the debug panel with translated labels. That is how the
debug panel gets shipped by accident.

Two consequences:

- **The debug panel gets no catalog keys.** It is built to be deleted; keys
  are documentation anchors, and minting anchors for something temporary is
  the exact cost the i18n rule exists to prevent. Hardcoded English, clearly
  marked debug. The eventual settings panel gets real keys, proposed properly.
- **"Effects off" must still distinguish the tiers** — the fallback is a
  *different* encoding, not a missing one. Stage A below is that path, which
  makes it a permanent low-end/accessibility route rather than a throwaway
  prototype step, and worth building accordingly.

There is currently no settings surface in the app at all (the language switch
lives on the title screen). Building one is a fine thing to do eventually, but
this feature should not be the thing that invents the app's settings
architecture.

## Prototype plan

Staged 2026-08-11 and all three built the same day; each stage's box below
records what survived contact. Lives in the **worldmap screen** — paper,
biome wash, the near-mode altitude ramp and the `ElevationSurface` seam are
all already there, and the workbench should keep showing what the save
*contains*, not what a player *knows*.

The exploration mechanic does not exist, and the prototype does not need it:
it needs a scalar field `k`, not a source for it. Two stand-ins, both
throwaway — a **debug brush** (dragging paints `k` upward, which is a better
authoring tool than the real mechanic would be, because it can produce the
hard shapes on purpose: thin corridors, islands, ragged tongues) and a few
**deterministic pseudo-settlements** seeded from the world seed so something
is on screen at load. Habitability can be guessed from what the save actually
carries — elevation, temperature, precipitation, biome, lakeDepth.

The field itself stays screen-local for now. A `knowledge/` module would fix
an abstraction before the model exists; where it really belongs depends on the
exploration mechanic, which is unwritten.

### Stage A — the tiers, CPU only, no shader

Answers the expensive question: **do the three states read at a glance?**
Also the permanent fallback path (see above).

The earlier "not on the CPU" note in this doc applies to edge darkening,
droplets and the falloff under zoom — the *medium*, which lives at pixel
scale. The tier distinction lives at region scale and fits the existing
`repaintPaper` path.

- `k` at ~512×256, torus-wrapped, sampled bilinearly (it is genuinely
  continuous, unlike biome ids, so bilinear is correct here) and warped by the
  same noise that already disguises biome blocks.
- `applyBiomeWash` takes `k` as an OPTIONAL argument defaulting to 1, so the
  generator's call site is untouched. It scales pigment alpha and
  desaturation per tier.
- Relief fades in with `k` by blending `buildPaperBase` toward
  `buildUnshadedPaperBase` — both already exist, and the unshaded variant is
  exactly "no relief known yet".
- Geometry must sink with `k` too, or a lit mountain range betrays unexplored
  land through its silhouette. No change to `ToroidalMapView`: the worldmap
  wraps its `ElevationSurface` in a `k`-multiplying one and passes that to
  `setReliefSurfaces`. The seam is already there — and "land rises out of the
  sheet as you learn it" is the better image anyway.
- River ribbons need the same gating (`ToroidalRibbonOverlay` is separate
  geometry).
- Regression check with real teeth: at `k = 1` everywhere, `repaintPaper` must
  produce byte-identical output to today. Cheap, and it protects the module
  the generator shares.

Expect blocky boundaries under zoom at 7.8 km/cell. That is what B and C fix;
stage A is judged on tier legibility only.

### Stage B — the medium, post-process

Answers: **does it look painted?** Independent of A; could even run first.

- Paper (warm off-white plus fibre), granulation, the density curve, droplets
  and drips. Grain anchored to the SCREEN — the sheet is the sheet.

> **Revised on contact (2026-08-11, built).** Two of the calls above were
> wrong, and both took under a minute of looking to settle.
>
> **Everything is world-anchored, including the fibre.** "The sheet is in front
> of you" is true of a real sheet and irrelevant here. What actually decides it
> is SPATIAL FREQUENCY: fine isotropic grain pinned to the screen reads as a
> surface you look *through*, but anything larger or directional reads as an
> object, and an object that holds still while the world slides under it is
> dirt on the lens. The safe side of the shower-door line is the world. Cost:
> the noise must be periodic over the torus or a seam runs down the map.
> Benefit: the moiré guard comes free, since the derivative that detects
> sub-pixel cells is needed anyway (same argument as the hex grid's `fwidth`).
>
> **The drips are gone.** They were the only element with no meaning — carried
> over from the reference image, never given a job — while being the largest
> and highest-contrast thing on screen, drawn across the unexplored paper that
> covers most of the frame. World-anchoring could not save them either: "down"
> is not a direction a top-down map has, and drips running south would go
> diagonal the moment the camera yaws. The motion worth keeping is wet paint
> RUNNING IN as a place is revealed — an event, not a permanent feature — and
> it waits on the exploration mechanic.
>
> Consequence for stage C: granulation is already welded to the ground, so C is
> left with edge darkening alone.
- The pass needs to know where the paint ends. Rather than guessing from image
  brightness, intersect the view ray with the ground plane and sample the same
  `k` texture: exact for a plane, about ten lines, and it gives world-anchored
  droplets if they turn out to want that. Guard the degenerate case near the
  horizon.
- Fades out along the existing near-mode altitude ramp, or a watercolour
  vignette ends up over a ground-level view.

### Stage C — edge darkening

Only if A and B both land. Edge darkening and granulation that survive zoom.

- The boundary mask goes into the paper texture's **free alpha channel**
  (`buildPaperBase` writes 255 everywhere today) — no new texture, no new
  upload path, and it is rewritten exactly when the paper is. `k` does NOT go
  there: it changes for a different reason and at a different rate, so it gets
  its own much smaller texture.
- Modelled on `hexGridMaterialPlugin`, applied to both map materials.
- Known integration point, to be looked at rather than guessed: the hex grid
  plugin also writes at `CUSTOM_FRAGMENT_MAIN_END`, so the two need a defined
  order. The grid is ink ON TOP of paint.

> **Revised on contact (2026-08-11, built). There is no material plugin, and no
> alpha channel is used.** Stage C came out as ~90 lines of CPU inside
> `mapPresentation`, alongside the knowledge lerps.
>
> Two of its three reasons for existing had already dissolved. B's move to
> world-anchored noise took **granulation** with it, leaving C only edge
> darkening. And the surviving argument — "a rim that survives zoom" — turned
> out to be backwards once B had taught the lesson: a fragment shader would
> hold the rim at a constant ~1.5 px however far you zoom, which is right for
> the hex grid (an *instrument*, ink over paint) and wrong for a rim, which is
> *paint*. A physical drying edge is a property of the wash, so it must scale
> with the world and blur when the wash blurs. Baking it into the paper texture
> is not the cheap approximation of the shader version; it is the more honest
> one.
>
> The frontier's rim needs no boundary mask at all: `k` is already a smooth
> field, so `|∇k|` peaks exactly where the paint runs out and is soft for free
> — which is what keeps it affordable inside a brush stroke. Only the interior
> boundaries (biome edges plus the coastline, taken from the relief byte's top
> bit so a save without a biome layer still gets shores) need the mask-and-blur,
> and those change per tier rather than per stroke, so the blur is cached.
>
> **The identity claim is narrower now, and stated deliberately:** edge
> darkening changes the picture at `k = 1` too — it is a feature, not a
> modulation. The baseline the spec check enforces is that the KNOWLEDGE
> machinery is the identity at `k = 1` with `edgeDarkening = 0`.
>
> Measured on the synthetic world: 26.5 % of texels touched, mean drop 9 of
> 255, peak 77 — and **0 texels of rim on bare paper**, which is the one
> property that must hold. A rim without pigment under it is a pencil line, and
> that is a different medium saying a different thing.

### Gates and what is not in it

Stop after A if the tiers do not read — B and C cannot rescue that. Stop after
B if it only looks painted while standing still (the shower-door effect is the
known failure mode, and panning is the honest test).

Explicitly out of the prototype: the wet-bleed reveal animation, the
foreign-hand sheet for bought maps, rumour droplets, and overlays — all of
them wait on mechanics that do not exist yet.

## Open questions

- **Is unexplored truly blank, or does it carry a faint, deliberately WRONG
  underdrawing** — guessed from hearsay, visibly correcting itself when
  someone actually goes there? Blank is graphically stronger and more honest.
  The underdrawing is the most interesting idea in the whole discussion, but
  it is a game mechanic wearing a rendering costume, and it should not be
  decided as a side effect of picking a look. **Explicitly parked
  (2026-08-11).** Either way it is additive: a pale layer beneath `k = 0`,
  requiring no rework of the above.
- The overlay register in the game view (see above), waiting on the separate
  overlay rethink.
- Whether scouted and traded knowledge really deserve different sheets, or
  whether that is one distinction too many.
- Exactly where on the descent ramp the painterly register hands over to the
  lit world — the same seam the exaggeration fade already crosses.
