---
id: DEC-0028
title.en: Map Orientation: The Screen Is the Frame
title.de: Kartenausrichtung: der Bildschirm ist der Bezugsrahmen
summary.en: The screen is the frame of reference for direction, not the raster. The map
  raster reaches the screen mirrored vertically; anything drawn outside it
  is put into the screen's frame at the point of drawing, and the readout
  names no compass directions at all, because a flat torus has none.
summary.de: Der Bildschirm ist der Bezugsrahmen für Richtungen, nicht das Raster. Das
  Kartenraster erscheint vertikal gespiegelt; alles, was ausserhalb davon
  gezeichnet wird, wird beim Zeichnen in den Rahmen des Bildschirms gesetzt,
  und die Anzeige nennt gar keine Himmelsrichtungen, weil ein flacher Torus
  keine hat.
area: ui
stage: built
createdAt: 2026-09-20
updatedAt: 2026-09-20
related: [DEC-0015]
---

## The fork

The generator paints its layers into a MAP_WIDTH x MAP_HEIGHT raster, and that
raster reaches the screen MIRRORED VERTICALLY: +y in the raster is up on screen.
It was found empirically, by drawing text — a mirrored coastline still looks
like a plausible coastline, and the climate bands are symmetric about the
equator, so nothing else in the world made it visible.

Two renderers already compensate for it, each on its own: the volcano cones draw
their apex at +y so it points up (`drawVolcanoes`), and the continent labels turn
a further pi (`generator/render/continentLabelRenderer.ts`, which records the
discovery; its `scale(-1, 1)` is a separate matter — glyph order, noted there as
empirical, not a second geometric mirror). A third was about to be added when the
map readout gained a direction arrow, which is drawn in the page rather than into
the raster and therefore disagreed with the wind arrows on the map beside it.

Several local corrections for one global fact means no place owns the fact. The
fork: put the raster the right way up, or declare the screen to be the frame of
reference and put everything else into it.

## The answer

**The screen is the frame.** The picture is not a mistaken view of the world —
it is the world as it is seen, and that is the only sense in which this world has
an orientation at all.

Rasters are an internal buffer. Anything drawn outside one is put into the
screen's frame at the point where it is drawn, and says so where it does it. For
a direction that is one line: up on screen is +v, so a bearing is `atan2(u, v)`.

The check is cheap and it is the one to run: the readout's arrow sits beside the
map's own wind arrows, and they must agree. They did not, twice, before this was
written down — once mirrored vertically, once mirrored horizontally.

## Why the world cannot settle it

The world is a flat torus ([world-topology-torus.md](./world-topology-torus.md)).
It has no poles — the top and bottom edges are one glued seam, which
`climate/climateField.ts` says in as many words — and no meridian. There is
therefore no measurement inside the world that distinguishes the turned picture
from the unturned one. A torus turned 180 degrees is the same torus.

The wind field says the same thing exactly. A vertical mirror shows the row at
-y in place of the row at y, with its vector as (u, -v); the prescribed bands are
built so that the zonal component depends only on |latitude| and the meridional
one changes sign with the hemisphere, which makes the mirrored field IDENTICAL to
the computed one — measured across the full range of latitudes, largest
difference 0. The trades still blow equatorward and westward, so not even the
sense of the planet's turn is disturbed. There is nothing here to be right or
wrong about.

The one thing that is NOT free: a horizontal mirror would reverse the zonal
component against the meridional one, which is the signature of a planet turning
the other way. It would still be undetectable today, because this world has no
day. The moment a sun crosses this sky, that stops being true — and the day's
direction must then be derived from the picture, not from the raster.

## What follows for the interface

**No compass directions.** North, south-east and "poleward" are words borrowed
from a sphere. The readout used to name eight of them; it now draws an arrow and
nothing else. An arrow is the whole of what is true — that way, across the map in
front of you — and it needs no pole to mean it. The `readout.compass.*` keys were
deleted with it.

The measured quantities are unaffected. A height in metres is calibrated and a
reader can check it by hovering (see `generator/elevation/elevationScale.ts`); a direction is a
relation to a frame, and the frame is the screen.

## Not done

The three existing compensations still sit in their own renderers. They are
correct and they carry their reasons, so they are left alone; this document is
what a fifth one should read first.

## Status

decided; implemented for the generator's readout
