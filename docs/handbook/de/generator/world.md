---
title: Welt
anchor: generator.step.world
order: 0
---

Der erste Schritt legt fest, welche Welt entsteht und auf welchem Planeten
sie liegt. Er rechnet noch nichts: Die Karte zeigt eine Beispielwelt, und
das Klima darauf folgt jedem Regler sofort. So siehst du, was ein Planet
mit dem Wetter macht, bevor du Zeit in seine Geschichte steckst.

## Was dieser Schritt tut {#does}

- Er gibt der Welt einen Namen und einen Seed.
- Er legt die Topologie fest, also wie die Ränder der Karte zusammenhängen.
- Er stellt den Planeten ein: Achsneigung, Tageslänge, Treibhaus,
  Temperaturkontrast und Feuchtigkeit.

Diese Werte gelten für jeden späteren Schritt. Änderst du einen davon,
ist alles danach veraltet und muss neu gerechnet werden.

## Konzepte {#concepts}

### Seed {#generator.world.seed}

Die Zahl, aus der jede Zufallsentscheidung des Generators folgt. Gleicher
Seed und gleiche Parameter ergeben dieselbe Welt, auf jedem Rechner und in
jedem Browser. Der Würfel daneben wählt einen neuen.

### Name {#generator.world.name}

Nur ein Name: Er steht in der Titelleiste, in Speicherständen und in
Dateinamen. Er ändert an der Welt nichts.

### Topologie {#generator.world.topology}

Wie die Ränder der Karte zusammenhängen. Die Welt ist heute ein flacher
Torus: Wer rechts hinausläuft, kommt links wieder herein, und wer oben
hinausläuft, unten. Platten, Winde und Meeresströmungen laufen so ohne
Rand um. Die waagrechte Mitte der Karte ist der Äquator, der obere und
der untere Rand sind zusammen der Pol. Die Kugel ist vorgesehen, aber noch
nicht verfügbar.

## Parameter {#parameters}

Die Standardwerte sind die der Erde. Zurücksetzen stellt alle fünf wieder
auf sie.

### Achsneigung {#generator.panel.planet.obliquity}

Wie weit die Drehachse kippt, 10° bis 40° (Erde: 23,5°). Mehr Neigung
bringt stärkere Jahreszeiten und ein flacheres Gefälle vom Äquator zu den
Polen. Die Skala endet bei 10°, weil darunter die Jahreszeiten und mit
ihnen der Monsun verschwinden; über 40° liegt das Klima ausserhalb dessen,
wofür das Modell abgestimmt ist.

### Tageslänge {#generator.panel.planet.rotation}

Wie lange eine Umdrehung dauert, 16 bis 36 Stunden. Eine langsame Drehung
weitet den Passatgürtel bis gegen 45° Breite, eine schnelle drängt ihn auf
etwa 20° zusammen. Mit dem Gürtel wandern die Wüsten.

### Treibhaus {#generator.panel.planet.greenhouse}

Erwärmt oder kühlt die ganze Welt gleichmässig, −20 °C bis +20 °C.

### Kontrast {#generator.panel.climate.contrast}

Wie stark die Temperatur vom Äquator zu den Polen abfällt, 30 % bis 170 %.
Unter 100 % wird die Welt ausgeglichener, darüber werden die Tropen heisser
und die Pole kälter.

### Feuchtigkeit {#generator.panel.climate.humidity}

Skaliert den Niederschlag der ganzen Welt, 40 % bis 200 %.

Kontrast und Feuchtigkeit gehören zum Klima, stehen aber hier: Die
Erdgeschichte im Schritt Plattentektonik trägt das Land unter genau diesem
Wetter ab. Darum müssen sie vor ihr feststehen, wie der Planet selbst.
