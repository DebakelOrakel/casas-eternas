---
summary: PROTO — the human layer of world-gen, after the Ecology layer. Seeds pre-state proto-settlements (Neolithic→Iron Age) via a bounded dispersal model over the Ecology suitability field, producing settlements + a contact/trade graph as the game's starting condition. Direction (dispersal) decided; the rest to design later.
date: 2026-07-26
status: proto / brainstorming — comes AFTER the Ecology panel is built
---

# Anthropology panel (proto)

The human layer of world-gen. Follows tectonics → erosion → climate → hydrology →
**ecology** (see `ecology.md`, which produces the resource/suitability fields
this consumes). Turns the finished world into a plausible **pre-state human
starting condition** for the game: where people are, what they have, who is in
contact with whom.

**Deferred:** this panel is designed/built *after* Ecology. This doc is a rough
capture of the current thinking, not a spec — revisit every section.

## Guiding split (with Ecology)

**Ecology = *what is on the land*; Anthropology = *how people respond*.** So the
knobs about human response live here (not in Ecology):

- **Settle threshold** — how marginal a place people will still settle
  (a dispersal parameter; lets carrying-capacity in Ecology stay a pure level
  scalar).
- **Marine ↔ terrestrial bias** — coastal/fish economy vs inland agriculture;
  *where* people settle.
- **Wild ↔ cultivated (domestication potential)** — how strongly the world
  rewards the sedentary farming package vs mobile hunting/gathering; gates
  whether villages even form (Guns-Germs-Steel-ish).

## Scope: Neolithic → Iron Age

Deliberately **pre-civilisation / early**. Output is *seed*, not finished
empires: scattered villages, a few proto-centres at good nodes, resource
gradients, and a contact/trade graph. The Bronze/Iron transition is what the
*player* drives, not what the generator produces.

- The human *time span* starts Neolithic. **Metals/ore are generated upstream in
  the Ecology layer** (decided; they're derived resources) — the Anthropology
  time axis just decides *when* they come into play. So starting Neolithic
  doesn't mean "no metals in the world," it means metals aren't *used* yet at
  t=0.

## Architecture decision: dispersal, not snapshot placement

Two candidate models were weighed:

- **A — Suitability snapshot:** compute a habitability field, drop villages on
  local maxima with spacing. Cheap, static. **Rejected as the primary model:**
  always reads as *optimised*, never anthropological — it fills the globally
  best tiles, so good land is never empty and there is no history for
  "interaction" to act on.
- **B — Dispersal (chosen):** one or few origin points; people spread over a
  **short, bounded time axis** via least-cost movement weighted by the Ecology
  suitability field, settling as they go, spawning daughter settlements. Leaves
  good-but-unreached land empty (path dependence), and produces the contact
  graph, frontier zones, and isolation **for free**.

### Bounded dispersal sketch (to flesh out later)

> **The first step of this is now being designed in detail as the "initial
> migration" — see `anthropology-initial-migration.md`.** That refines Origin +
> Spread below into: **user-placed origins, one per ~3 toggleable races**, a
> **multi-source least-cost (Dijkstra) spread** whose **predecessor tree +
> population-flow accumulation** render as a **migration arrow-tree** (width =
> flow, colour = race) over a coarse density background. Steerable-deterministic
> (user places origins, spread is deterministic). Settlements / densification /
> contact graph (steps below) come after.

Keep it a few coarse epochs, **not** an agent sim:

1. **Origin(s).** One or a handful of seed points. *(Initial-migration doc:
   USER-PLACED, one per race, snapped to land.)*
2. **Spread.** Least-cost expansion across the suitability field. Terrain cost:
   coast + river cheap (highways), mountain/desert/ice expensive. Settlements
   founded where local suitability clears the **settle threshold** *and*
   spacing/territory rules allow (Poisson-disk-ish exclusion so villages don't
   pile up).
3. **Densification.** Settlements at trade/confluence/coast nodes grow into
   proto-centres; a light pass promotes the best-connected nodes. Prestige goods
   (Ecology) feed the inequality/centre signal here.
4. **Contact graph.** Edges = traversable neighbours weighted by terrain cost
   (rivers/coasts cheap). Trade / contact / isolation read straight off the
   graph — this is the whole "how much do proto-settlements interact" question,
   answered as graph proximity, deterministically.

## Leitplanken (firm)

- **Deterministic + seeded**, like everything else → dispersal is a
  deterministic least-cost spread, no stochastic-feeling agents.
- **Architecture fit:** at ~8 km/cell a settlement is a **point**, not a cell.
  Settlements = markers; territories = Voronoi/claim over the raster; trade =
  **graph** (edges weighted by terrain cost). This is exactly the existing
  vector-overlay pattern (river ribbons → trade-route ribbons, labels → town
  markers).

## Tech-dependent fertility (link to Ecology)

Neolithic farmers favour light, easily-worked soils (loess, riverbanks); heavy
floodplain clay and dense forest only "unlock" with later tech (iron plough,
clearing). If the dispersal time axis exists, the Ecology suitability field
should **evolve with the tech epoch** — floodplains/forests unlock over time. A
genuine link between the two panels; see the same note in `ecology.md`.

## Open questions (parking lot)

- One origin or several cradles?
- How many bounded epochs, and does the world get re-read each epoch (evolving
  fertility)?
- What exactly does the game receive at t=0 — points + gradients, or points +
  contact/trade graph?
- Panel naming: "Anthropology" vs "Peoples" vs "Settlement" (UI is English).
