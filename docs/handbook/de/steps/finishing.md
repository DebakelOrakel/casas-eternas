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

{{concept detail-levels}}

{{concept same-world}}

{{concept jobs}}

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
