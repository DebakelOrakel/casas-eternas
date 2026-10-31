# Changelog — Incubator

The prehistory of a world: the old stone age, the new stone age, the peoples, the
settlement, the exchange and the chronicle. See [README](./README.md) for the format.
The incubator's controls and layout are in [ui.md](./ui.md).

## 2026-10-31
- **changed** Peoples: the made names are shorter and repeat their sounds less, and related languages keep more of their basic words while their sounds change faster. `language.world.names`
- **new** Peoples: an overlay colours the land by the peoples' languages, a colour per family, and makes a language chosen in the languages window stand out. `incubator.peopling.languages`
- **new** Peoples: the languages window compares the words of related languages and follows a place's name through its parts and its forms over time. `language.tab.compare`
- **new** Peoples: a people that takes a place keeps its old name or gives it a new one, and the peoples call their neighbours' places by names of their own; the languages window shows both. `language.world.names`
- **new** Chronicle: the landmasses have the names their first peoples gave them, and the languages window lists the names of the villages, rivers, mountains and lakes given in each language. `language.world.names`
- **new** Chronicle: the chronicle tells when languages arise and die out, and the languages panel shows the languages the peoples made. `incubator.chronicle.event.languageArises`
- **new** Peoples: a languages panel and window show the tree of the peoples' languages, with placeholder languages until the language core exists. `language.panel.title`
- **changed** New Stone Age: the fields also spread where only a part of the land is good to farm, as a river's floodplain. `incubator.step.newStoneAge`
- **changed** Chronicle: a short New Stone Age also tells the splits and merges of the large peoples that held to its end. `incubator.chronicle.event.peopleSplit`
- **changed** New Stone Age: a much stronger people moves into its neighbours and takes their land, so the peoples keep changing after the spread. `incubator.step.newStoneAge`
- **new** Chronicle: a people that a stronger people moves into and takes is told as displaced, not as merged. `incubator.chronicle.event.peopleReplaced`
- **changed** Old Stone Age: without a chosen origin, the people start on the large landmass from which they reach the most land. `incubator.step.oldStoneAge`
- **changed** New Stone Age: the land the ice sheets pushed down lies under the sea when the ice melts and rises out of it over thousands of years. `incubator.step.newStoneAge`
- **new** Chronicle: the map shows the land the ice pushed down as sea while it is under the sea, and the chronicle tells where the sea floods it and where it rises again. `incubator.chronicle.event.seaFloodsIce`
- **new** New Stone Age: large volcanic eruptions cover the land near them with ash or gas, cool the world, and the chronicle tells them. `incubator.chronicle.event.eruption`
- **changed** New Stone Age: the fields also spread over the floodplains in the deserts, where the flood waters them. `incubator.step.newStoneAge`
- **changed** New Stone Age: 20 000 years after its start, a history takes its largest town of 5 000 people or more as its first city, so a world of herders alone can end without a city. `incubator.step.newStoneAge`

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
