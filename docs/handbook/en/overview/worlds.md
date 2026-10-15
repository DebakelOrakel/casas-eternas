---
title: Your worlds
anchor: generator.overview.worlds
order: 1
---

A world can stay in two places: in this browser, or on the server. The
first screen, "Choose a world", lists both together, because where a
world is kept is a property of the world, not a place you go to.

## Choose a world {#choose}

- **Create new world** starts with a new seed. Its menu picks the shape,
  flat or sphere.
- **Upload a world** opens a world you downloaded as a .zip file.
- **Existing worlds** lists every world, with its shape, its name and how
  far it got (the last step accepted, or "Finished"). The filters narrow
  the list by place (all, in browser, on server, templates) and by shape.

A world kept in both places is one card. A click on it shows the facts
of each copy: where it is kept, when it was last saved, the build that
made it, its size and its progress. From there you can copy it from one
place to the other, open it, or remove it for good. If the two copies are
not the same, the card says "Differs" and marks the newer one.

Without an account you see only the worlds of this browser and the
templates of the server.

## Templates {#templates}

A template is a world the server offers to everyone as a start, also
without an account. Its card says "Template". You do not work on the
template itself: **Make a copy** makes a new world of your own from it,
with the same terrain, and asks where it goes — kept in this browser, or
stored on the server if you are signed in. The copy has the template's
name, and the template stays as it is. The levels and tiles computed for
the template are not copied; the copy computes its own.

An admin marks a server world as a template, or removes the mark, in the
world's panel.

## Saving {#save}

The Save menu in the title bar has three ways:

- **Keep in this browser.** It survives a reload, but the browser may
  clear its storage, and another device cannot see it.
- **Download as .zip.** A file you keep yourself; open it again with
  Upload a world.
- **Store on server.** Reachable from every browser you sign in from,
  with its versions kept. It needs a sign-in.

The title bar shows "Unsaved changes" as long as the world has changed
since it was last saved, loaded or made again. Accepting a step is a
change too: the progress is part of the saved world.

A world holds its recipe (the seed and every value) and what the steps
computed, so it opens where you left it. A file from an older save format
does not open; make the world again from its seed and values.
