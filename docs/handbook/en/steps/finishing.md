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

{{concept detail-levels}}

{{concept same-world}}

{{concept jobs}}

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
