# Changelog — Incubator

The prehistory of a world: the old stone age, the new stone age, the peoples, the
settlement, the exchange and the chronicle. See [README](./README.md) for the format.
The incubator's controls and layout are in [ui.md](./ui.md).

## 2026-10-30
- **changed** Old Stone Age: a shelf the low sea lays dry feeds the people as its own land would, not as the coast beside it. `incubator.step.oldStoneAge`
- **new** Overlays: the hover card shows the temperature of the point under the pointer over the year, as a curve. `readout.chart.temperature`
- **new** Old Stone Age: two sliders set the reach of boats over the sea and the lowest sea level. `incubator.people.reach`

## 2026-10-29
- **new** New Stone Age: the subtropics' deserts and steppes are wetter at the New Stone Age's start and dry out later, and the chronicle tells it. `incubator.chronicle.event.drying`
- **new** Chronicle: the chronicle tells when a large people splits, merges into another, vanishes or turns to farming. `incubator.chronicle.event.peopleSplit`

## 2026-10-28
- **new** Chronicle: the chronicle tells of coasts the rising sea takes and of cold spells, and large villages draw more of the far trade. `incubator.chronicle.event.drowned`
- **changed** New Stone Age: the people's history has copper, hammered and then smelted, towns that draw the people around them, and ends at its first city; it runs on from the old stone age's end, under the old stone age's routes, in one chronicle. `incubator.step.newStoneAge`
- **changed** New Stone Age: the people's history begins where the old stone age ends, with the people where it brought them, and the old stone age reaches the landmasses its boats reach by coast. `incubator.step.newStoneAge`

## 2026-10-27
- **new** History: a history shown is saved on the server by a job, and a world opens with the history saved last. `incubator.action.saveHistory`
