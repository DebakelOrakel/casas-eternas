---
title: Welt
anchor: generator.step.world
order: 0
---

Der erste Schritt legt fest, welche Welt entsteht und auf welchem Planeten
sie liegt. Er rechnet noch nichts: Die Karte zeigt eine Beispielwelt
(bei einer Kugel eine Beispielkugel), und das Klima darauf folgt jedem
Regler sofort. So siehst du, was ein Planet mit dem Wetter macht, bevor
du Zeit in seine Geschichte steckst.

## Was dieser Schritt tut {#does}

- Er gibt der Welt einen Namen und einen Seed.
- Er zeigt die Form der Welt, flach oder Kugel.
- Er stellt den Planeten ein: Achsneigung, Tageslänge, Treibhaus,
  Temperaturkontrast und Feuchtigkeit.

Diese Werte gelten für jeden späteren Schritt. Ist die Welt erzeugt,
sind sie gesperrt: Eine Änderung machte alles danach veraltet. Um sie zu
ändern, setzt du sie zuerst zurück; „Welt erzeugen“ macht die Welt dann
mit den neuen Werten neu und verwirft, was gerechnet war.

## Konzepte {#concepts}

### Seed {#generator.world.seed}

Die Zahl, aus der jede Zufallsentscheidung des Generators folgt. Gleicher
Seed und gleiche Parameter ergeben dieselbe Welt, auf jedem Rechner und in
jedem Browser. Der Würfel daneben wählt einen neuen.

### Name {#generator.world.name}

Nur ein Name: Er steht in der Titelleiste, in Speicherständen und in
Dateinamen. Er ändert an der Welt nichts.

### Topologie {#generator.world.topology}

Die Form der Welt: wie die Ränder der Karte zusammenhängen. Du wählst
sie beim Anlegen, im Menü von „Neue Welt erstellen“; danach steht sie
fest, und Schritt 0 zeigt sie nur noch. Es gibt zwei Formen.

Flach ist ein flacher Torus: Wer rechts hinausläuft, kommt links wieder
herein, und wer oben hinausläuft, unten. Platten, Winde und
Meeresströmungen laufen so ohne Rand um. Die waagrechte Mitte der Karte
ist der Äquator, der obere und der untere Rand sind zusammen der Pol.

Kugel ist ein Globus mit zwei Polen; er läuft nur in Ost-West-Richtung
um. Seine Achse folgt der Achsneigung. In diesem Schritt siehst du die
Kugel von der Seite, damit die ganze Neigung sichtbar ist; die anderen
Schritte blicken von über dem Nordpol auf sie. Eine Kugelwelt rechnet
die Schritte bis Ökologie; Feinschliff und Migration sind für sie
gesperrt.

## Parameter {#parameters}

Die Standardwerte sind die der Erde.

### Achsneigung {#generator.panel.planet.obliquity}

Wie weit die Drehachse kippt, 10° bis 40° (Erde: 23,5°). Mehr Neigung
bringt stärkere Jahreszeiten und ein flacheres Gefälle vom Äquator zu den
Polen; die mittlere Temperatur der Welt bleibt. Heissere Sommer schmelzen
mehr Eis, darum wachsen bei kleiner Neigung Eiskappen, bei grosser
schrumpfen sie. Die Skala endet bei 10°, weil darunter die Jahreszeiten und mit
ihnen der Monsun verschwinden; über 40° liegt das Klima ausserhalb dessen,
wofür das Modell abgestimmt ist. Auf einer Kugel zeigt der Globus den
Äquator und die beiden Polarkreise als Bänder; die Polarkreise wandern
mit der Neigung.

### Tageslänge {#generator.panel.planet.rotation}

Wie lange eine Umdrehung dauert, 16 bis 36 Stunden. Eine langsame Drehung
weitet den Passatgürtel bis gegen 45° Breite, eine schnelle drängt ihn auf
etwa 20° zusammen. Mit dem Gürtel wandern die Wüsten. Eine drehende
Kugel dreht sich mit der Tageslänge schneller oder langsamer.

### Treibhaus {#generator.panel.planet.greenhouse}

Erwärmt oder kühlt die ganze Welt gleichmässig, −20 °C bis +20 °C.

### Kontrast {#generator.panel.climate.contrast}

Wie stark die Temperatur vom Äquator zu den Polen abfällt, 30 % bis 170 %.
Unter 100 % wird die Welt ausgeglichener, darüber werden die Tropen heisser
und die Pole kälter. Die mittlere Temperatur der Welt bleibt; die verschiebt
das Treibhaus.

### Feuchtigkeit {#generator.panel.climate.humidity}

Skaliert den Niederschlag der ganzen Welt, 40 % bis 200 %.

Kontrast und Feuchtigkeit gehören zum Klima, stehen aber hier: Die
Erdgeschichte im Schritt Plattentektonik trägt das Land unter genau diesem
Wetter ab. Darum müssen sie vor ihr feststehen, wie der Planet selbst.

## Bedienung {#controls}

### Welt erzeugen {#generator.world.create}

Erzeugt die Welt aus dem Seed und den Werten dieses Schritts und öffnet
den Schritt Erdmantel. Gibt es schon eine Welt, fragt es zuerst: Alles,
was für sie gerechnet war, wird verworfen.

### Zurücksetzen {#generator.action.resetPlanet}

Stellt alle fünf Regler auf ihren Standard zurück. Über einer erzeugten
Welt gibt es sie damit auch zum Ändern frei.

### Zurück zu den Werten dieser Welt {#generator.action.revertPlanet}

Steht an der Stelle von Zurücksetzen, sobald die Regler freigegeben
sind. Es stellt Schritt 0 auf die Werte zurück, mit denen die Welt
erzeugt wurde, und sperrt ihn wieder.
