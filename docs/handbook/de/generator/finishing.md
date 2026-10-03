---
title: Feinschliff
anchor: generator.step.finishing
order: 5
---

Bis hierher rechnet der Generator die ganze Welt grob, mit Punkten etwa
8 km auseinander; so bleibt das Ausprobieren schnell. Der Feinschliff
rechnet die fertige Welt auf dem Server viel dichter nach, Stufe um
Stufe, bis hinunter auf etwa 125 m. Das dauert lange und läuft als Job im
Hintergrund.

## Was dieser Schritt tut {#does}

- Er bestellt beim Server die Verfeinerung der Welt bis zur gewählten
  Stufe.
- Er zeigt, wie weit die Verfeinerung ist.
- Was fertig ist, bleibt im Artefaktspeicher und wird nicht noch einmal
  gerechnet.

## Konzepte {#concepts}

### Stufen {#levels}

Jede Stufe ist viermal dichter als die vorige:

- Stufe 1, etwa 2 km: Die ganze Welt rechnet ihre Geschichte noch einmal,
  in dieser Dichte. So wachsen die Täler mit den Bergen, statt nachträglich
  eingeritzt zu werden.
- Stufe 2, etwa 500 m: Das Land wird in Kacheln von etwa 125 km geteilt,
  und jede Kachel wird aus Stufe 1 verfeinert und nacherodiert.
- Stufe 3, etwa 125 m: dasselbe aus Stufe 2, in Kacheln von etwa 62 km.

Meer wird nur in Stufe 1 verfeinert; die Kacheln decken das Land. Bäche
fliessen von Kachel zu Kachel weiter.

### Gleiche Welt überall {#same-world}

Bevor der Server verfeinert, prüft er, dass er aus dem gespeicherten Weg
genau dieselbe Welt erhält wie dein Browser. Darum lässt sich eine Welt
aus einer älteren Version des Generators erst verfeinern, wenn sie mit der
heutigen neu erstellt wurde.

### Jobs {#jobs}

Eine Verfeinerung ist ein Auftrag an den Server, der auch weiterläuft,
wenn du das Fenster schliesst. Im Menü unter Jobs siehst du, was wartet,
läuft und fertig ist, wie weit jede Stufe ist und wann sie voraussichtlich
fertig wird. Dort lässt sich ein Job auch abbrechen.

## Voraussetzungen {#needs}

- Ein Server, der Feinsimulationen rechnet.
- Die Welt muss auf diesem Server gespeichert sein.
- Wo der Server eine Anmeldung hat, musst du angemeldet sein.

Fehlt etwas davon, sagt der Schritt, was, und der Knopf bleibt aus.

## Bedienung {#controls}

### Verfeinern bis {#generator.finishing.depth}

Bis zu welcher Stufe verfeinert wird. Vorhandene Stufen bleiben; eine
höhere baut auf ihnen auf. Ausgewählt ist zuerst die höchste, die schon
fertig ist.

### Welt verfeinern {#generator.finishing.refine}

Bestellt die Verfeinerung bis zur gewählten Stufe. Darüber steht, wie
weit sie ist: wartend, laufend mit Prozent, fertig bis zu welcher Stufe,
oder warum sie fehlschlug.
