---
title: Plate tectonics
anchor: generator.step.tectonics
order: 2
---

The Proterozoic, 2.5 to 0.54 billion years ago. The cratons become
continents on moving plates. Where plates collide, mountains grow; where
they part, new sea floor forms. At the same time the weather works:
rivers cut valleys, glaciers grind, the surf gnaws at the coasts. The
landscape that stands at the end is the sum of this history.

## What this step does {#does}

- It moves the plates, and the land with them, epoch by epoch.
- It raises mountains where plates collide and forms new crust where they
  part.
- It places volcanoes: chains above hotspots, arcs above sinking plates.
- In every epoch it lets rivers, ice and waves wear the land down and
  lays the material down again in valleys, basins and deltas.

You start and stop the run yourself. Each epoch moves the world one
million years on.

## Concepts {#concepts}

### Plate boundaries {#boundaries}

Where two plates meet, their motion decides what happens. If they
converge, the heavier one sinks or both fold up into a mountain range. If
they diverge, the crust tears and new sea floor forms between them. If
they slide past each other, little happens.

### Hotspot {#hotspot}

A plume that stands fixed in the deep mantle. The plate moves over it, and
it burns a chain of volcanic islands into it that grow older in the
direction the plate moves.

### Erosion {#erosion}

Rain gathers into rivers, and rivers cut into the land, deeper the
steeper and the fuller they are. What they wear away they carry off and
leave where they slow down. Where it is cold enough, glaciers take over;
at the coasts the surf works. A range that is no longer lifted slowly
gets lower.

### Climate in the history {#history-climate}

Erosion needs rain, and rain depends on the relief. So every three epochs
the step computes a climate on the world as it is then, with the values
from the World step. If much ice grows, the sea level falls.

### Stopping and moving on {#stop}

Stop is a pause: a new start continues the history. The climate opens
after 30 epochs. A run stops by itself after 100 epochs at most; then you
can start it again. Reset puts the plates back to the start of this step.

## Figures {#stats}

### Land {#generator.panel.tectonics.stat.land}

How much of the world's surface lies above the sea.

### Continents {#generator.panel.tectonics.stat.continents}

How many separate continents there are. They carry names once tectonics
has begun.

### Plates {#generator.panel.tectonics.stat.plates}

How many plates divide the surface. Their number follows from the mantle
and can change in the course of the history.

### Age {#generator.panel.tectonics.stat.age}

The world's age since its beginning, the Archean included. One epoch of
tectonics is one million years.

## Parameters {#parameters}

Both sliders act over the whole history, not only at the end.

### Floodplains {#generator.panel.tectonics.alluvium}

How readily rivers drop their load, 0 to 100 (default 50). More builds
wide valley floors and large deltas; less carries the sediment out to the
sea.

### Rock contrast {#generator.panel.tectonics.rockContrast}

How differently hard and soft rock wear down, 0 to 100 (default 50). More
digs deep basins between standing ridges; at 0 erosion wears everything
down alike.
