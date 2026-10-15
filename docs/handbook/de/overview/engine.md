---
title: Die Engine
anchor: generator.overview.engine
order: 0
---

Der Generator malt keine Welt, er lässt eine wachsen. Er simuliert vier
Milliarden Jahre Geschichte des Planeten: erst einen Mantel ohne Platten,
dann Platten, die Kontinente tragen, während das Wetter das Land abträgt.
Das Klima, die Flüsse und was das Land hergibt, folgen aus dem Relief,
das am Ende steht.

## Wie eine Welt wächst {#grows}

1. **Welt.** Du wählst den Planeten: seine Form, Neigung, Tageslänge,
   Treibhaus, Temperaturkontrast und Feuchte, und die Saat.
2. **Mantel.** Das Archaikum, ab vor 4,0 Milliarden Jahren. Über heißem
   Mantel bildet sich Kruste und treibt mit seiner Strömung. Was bleibt,
   wird zum Kraton, bis das Land steht, das du verlangt hast.
3. **Plattentektonik.** Das Proterozoikum. Platten wandern wenige
   Zentimeter im Jahr und tragen die Kontinente. Wo Kruste zusammenläuft,
   wachsen Gebirge; wo sie auseinanderweicht, entsteht neuer Meeresboden.
   In jeder Epoche tragen Flüsse, Gletscher und Wellen das Land ab, unter
   einem groben Klima jener Zeit.
4. **Klima.** Das heutige Klima auf dem fertigen Relief, Monat für Monat:
   Luftdruck, Winde, Meeresströmungen, Temperatur und Regen. Die
   Klimaklassen, die Biome und die Flüsse folgen daraus.
5. **Ökologie.** Was das Land hergibt und wie viele Menschen es tragen
   kann.
6. **Feinschliff.** Der Server rechnet die Welt noch einmal, viel dichter.

Jeder Schritt liest nur, was die Schritte vor ihm gemacht haben. Ein
angenommener Schritt hält sein Ergebnis fest; eine Änderung an einem
früheren Schritt macht die späteren veraltet.

## Zeit {#time}

Die Geschichte läuft in Epochen. Im Archaikum ist eine Epoche 5 Millionen
Jahre lang, in der Plattentektonik 1 Million Jahre. Wie lange jedes
Zeitalter läuft, entscheidest du: Du startest und stoppst es selbst.

## Simuliert, nicht erfunden {#simulated}

Gebirge, Täler, Seen, Eis und Wüsten werden nicht platziert: Sie sind,
was die Geschichte hinterlassen hat. Darum unterscheiden sich zwei Welten
aus zwei Saaten in ihrer Art, nicht nur im Detail, und darum verändern
die Werte des Planeten die Welt als Ganzes. Ein kälterer Planet hat mehr
Eis, und sein Eis schleift seine Gebirge niedriger.

Dieselbe Saat mit denselben Werten ergibt dieselbe Welt, auf jedem Rechner
und in jedem Browser.

## Die Formen {#shapes}

Eine Welt ist flach (ein Torus ohne Rand) oder eine Kugel mit zwei Polen.
Beide rechnen dieselben Schritte mit denselben Reglern.

{{concept globe}}
