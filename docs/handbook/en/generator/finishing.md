---
title: Finishing
anchor: generator.step.finishing
order: 5
---

Up to here the generator computes the whole world coarsely, with points
about 8 km apart, so that trying things stays fast. Finishing computes
the finished world again on the server, much denser, level by level, down
to about 125 m. That takes long and runs as a job in the background.

## What this step does {#does}

- It orders the refinement of the world from the server, up to the level
  you pick.
- It shows how far the refinement has come.
- What is done stays in the artifact store and is not computed again.

## Concepts {#concepts}

### Levels {#levels}

Each level is four times denser than the one before:

- Level 1, about 2 km: the whole world computes its history again, at
  this density. So the valleys grow with the mountains instead of being
  scratched in afterwards.
- Level 2, about 500 m: the land is cut into tiles of about 125 km, and
  each tile is refined from level 1 and eroded again.
- Level 3, about 125 m: the same from level 2, in tiles of about 62 km.

The sea is refined only in level 1; the tiles cover the land. Streams
flow on from tile to tile.

### The same world everywhere {#same-world}

Before the server refines, it checks that the saved recipe gives it
exactly the same world as your browser. So a world from an older version
of the generator can be refined only after it was made again with
today's.

### Jobs {#jobs}

A refinement is an order to the server that goes on running when you
close the window. In the menu under Jobs you see what waits, runs and is
done, how far each level is and when it should be done. You can also
cancel a job there.

## Requirements {#needs}

- A server that computes the fine simulation.
- The world must be saved on that server.
- Where the server has a sign-in, you must be signed in.

If one of these is missing, the step says which, and the button stays off.

## Controls {#controls}

### Refine up to {#generator.finishing.depth}

Up to which level the world is refined. Levels that exist stay; a higher
one builds on them. The highest level already done is picked first.

### Refine the world {#generator.finishing.refine}

Orders the refinement up to the chosen level. Above it stands how far it
is: waiting, running with a percentage, done up to which level, or why
it failed.
