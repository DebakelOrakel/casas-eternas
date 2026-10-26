---
id: DES-0031
title.en: The incubator's chronicle
title.de: Die Chronik des Inkubators
summary.en: A timeline panel for the incubator's playback — the time, the
  play controls, a few counts and a list of events that a click travels
  to. The events come from the settlement's data, which is deterministic,
  so the chronicle is derived, not recorded. A first form shows the
  farming, the herding and the boats only.
summary.de: Eine Zeitleiste für die Wiedergabe des Inkubators — die Zeit, die
  Bedienung, einige Kennzahlen und eine Liste von Ereignissen, zu denen ein
  Klick reist. Die Ereignisse kommen aus den Daten der Besiedlung, die
  deterministisch sind; die Chronik wird abgeleitet, nicht aufgezeichnet.
  Eine erste Form zeigt nur Ackerbau, Viehzucht und Boote.
area: ui
stage: building
createdAt: 2026-10-26
related: [DES-0023, DES-0032]
---

## Where this starts

The incubator plays its three steps (flora, fauna, people) over 65 000
years: a slider, a play button and a speed button at the foot of the left
column. Many things happen in that time (the farming and the herding
begin at their centres, people cross the sea, animals die out), but the
screen shows only the state at the time on the slider. To find a moment,
the user must search for it with the slider.

The design canvas (Weltgenerator, `project/Inkubator.dc.html`) shows a
timeline as a right sidebar, in two variants: A, the simulation runs; B,
the user travelled back.

## The panel in the canvas

From the top down, 392 px wide:

- A head: "Zeitlinie" and the number of events.
- The present: the epoch's name, the year in large type; one event back,
  play or stop, one event forward; the speed 1× / 4× / 16×.
- Three counts: people, settlements, centres.
- A filter by kind (all, subsistence, settlement, trade, crisis) and a
  search.
- The events from the top down: a dot, the year, an icon, a title and a
  line below it (a place, a number). The event at the time shown is marked
  "now", the events after it "later". At the left, an axis with the
  epochs as bands, the population as a curve and a handle at the time
  shown. A click on an event travels to it.
- A foot: a hint and an export button.
- Variant B only: a banner "an earlier state, the simulation stopped" with
  "back to the present".

## Direction

**Derived, not recorded.** The settlement is a function of the time
(`settleShared.ts`: every cell has its times, the state at a time comes
from them). So each event is a time and a cell, found in the result of
`settle.ts`, and the chronicle is made again with it. There is no log to
keep and no present that a travel back leaves: variant B's banner does not
apply. The events after the time shown are still marked "later".

**Kept from the canvas:** the present with the controls, the counts, the
list, a click that travels to an event.

**Changed from the canvas:**

- The light theme, as the generator and the incubator have.
- The time counted up from the people's departure, year 0, to the span's
  end, year 65 000, as the canvas counts ("year 2 840"). The settlement
  already counts so (`t`, years after the departure); the slider shows
  "years ago" now and goes over to it, so the screen has one count.
- The speed 1× / 4× / 16× with 1× = 100 years a second. It replaces the
  speed button.

**The first events: the farming, the herding, the boats.** No more until
these work:

| Kind | Event | From |
|---|---|---|
| Farming | A farming centre begins | `centres` (LIFEWAY.farmers) |
| Herding | A herding centre begins | `centres` (LIFEWAY.herders) |
| Boats | People cross to a landmass by boat | `people.ts` (the crossings) |

A place has no name yet: the text uses a number ("Village 1", "Village
839"). Names come later.

## Not yet

- **More events:** the land bridges under the sea.
- **Events without a model:** pottery, walls, droughts.
- **The search and the export.**

## Answered (2026-10-26)

1. **The playback** moved from the left column's foot into the chronicle,
   which shows in every step. Its slider stays under the year.
2. **A click on an event** goes to its time, and the view turns or pans to
   its cell (`WorldView.lookAt`: the globe's rig turns as a drag would,
   `solveGrab`; the flat map pans the shorter way round).
3. **The crossings**: `people.ts` gives, per landmass first reached over
   open water, the cell landed on, the time and the widest stretch of open
   water on the way (`crossings`). A landmass first reached over land or a
   land bridge has none. On Morvane 54 landmasses; the chronicle names those
   of CROSSING_LEAST_KM2 (100 000 km²) or more, 8.
4. **No filter, no search, no export** while there are so few kinds.

A fourth kind came the same day: **a species dies out** on a landmass of
100 000 km² or more (`settle.ts`, the big game's loss), at the time its
last tenth goes, at the cell it went from last; the icon of its animal
group. On Morvane 15.

**The departure** in year 0, at the origin. **The epochs** (2026-10-26),
two, from the events: the Palaeolithic to the first farming centre, the
Neolithic from it (none on a world without one); bands on the axis, the
name over the year, a heading over the epoch's events in the list (a click
goes to its start). The epoch's start is no event of its own: it is the
first farming centre's.

More the same day: **the first village** (the villages numbered by when
they began), **the first trade route** (the first link that carries goods,
once both its villages stand, placed at its middle), **the population
over 100 000, 1 M and 10 M** (from the curve, between its samples
linearly; no place). On Morvane: year 4 714 (a fishing village), 42 199,
819, 58 019, 62 666.

A fifth: **a plant or an animal domesticated** at a centre (`settle.ts`,
the domesticates), at the centre's cell — its first taming only: in a
history each centre tames its own, and the chronicle held some 25 tamings
(2026-10-26). On Morvane 14 by the rules.

A sixth, a history's only: **a famine** (simulation.ts, the droughts)
that cost 30 % of its square's people and 10 000 or more, the ones on a
landmass within 1 000 years of each other as one, at the most costly's
cell, with the people they cost and the villages given up.

A landmass is named by its rank by area, 1 the largest. The axis carries
the people over the span (`settle.ts` population, every 500 years, on a
logarithmic scale), the handle and the epochs.

## Status

Building, 2026-10-26: the panel, five kinds of events, the travel to
them.
