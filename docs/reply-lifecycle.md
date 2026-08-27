# Reply-Lifecycle: was in die Nachricht geschrieben werden darf

Wer `src/channel.ts` oder `src/format.ts` anfasst, sollte das hier vorher gelesen
haben. Der Vertrag ist unscheinbar und schon zweimal gebrochen worden.

## Ein Turn = eine Nachricht

`sendReplyLifecycle()` postet **einen** Platzhalter und editiert ihn in-place, bis der
Turn endet. Es gibt keinen zweiten Versuch: **die letzte Schreiboperation ist das,
was der Nutzer sieht.** Jeder Delivery-Callback konkurriert um dasselbe Feld.

Parallel dazu trägt die Auslöser-Nachricht eine Status-Reaktion: ⏳ während der
Arbeit, am Ende ✅ / ❓ / ⚠️ — je nach Marker (`[[ERLEDIGT]]`, `[[FRAGE]]`,
`[[ACHTUNG]]`), den der Agent an seine Abschlussnachricht hängt.

## `kind` sagt nicht, was der Payload ist

Naheliegende Annahme: Tool-Zeug kommt als `kind:"tool"`, Prosa als `block`/`final`.
**Stimmt nicht.** Der Host emittiert `kind:"tool"` nur, wenn verbose eingeschaltet
ist. Ist es aus, kommen dieselben Tool-Hinweise als `block`/`final` — und sie sind
gepuffert, werden also am Turn-Ende geflusst, **nach** dem finalen Antworttext.

Genau daran ist es am 26.08.2026 gescheitert: eine fertige Antwort wurde 620 ms nach
`model.completed` durch `⚠️ 🛠️ Bash failed: …` ersetzt. Weil der Hinweis als `final`
kam, setzte er zusätzlich `finalUpdated` — und deaktivierte damit die Salvage-Logik
aus `819f6103`, die genau solche Fälle auffangen sollte. Die ✅-Reaktion blieb stehen
und bewies, dass die Antwort da gewesen war.

## Die Regel

> Ein Tool-Trace ist eine Spur davon, **wie** gearbeitet wurde — nie das Ergebnis.
> Er darf keine Prosa überschreiben, nicht als `lastMeaningful` gelten und den Turn
> nicht abschließen.

Umgesetzt in `isToolTraceStub()` (`src/format.ts`) plus dem Guard am Anfang von
`update()` (`src/channel.ts`).

**Erkannt wird am Schraubenschlüssel, nicht an ⚠️.** OpenClaw-Core markiert
tool-eigene Payloads intern mit `startsWith("🛠️") || startsWith("🔧")`; Fehler tragen
ein ⚠️ davor. Würde man auf ⚠️ allein prüfen, verschwände jede Antwort, die mit
„⚠️ Achtung: …" beginnt — ein legitimer und häufiger Einstieg. Ein früherer Versuch
(`/^\s*⚠️|\bfailed\s*$/`) hatte genau diesen Fehler; er lebt noch als
`TOOL_STEP_FAILURE` auf dem `kind:"tool"`-Pfad weiter, wo der Inhalt garantiert eine
Tool-Zeile ist. Auf dem Prosa-Pfad wäre er gefährlich.

## Endzustände, die stimmen müssen

| Ablauf | Erwartetes Ergebnis |
|---|---|
| Prosa, danach Tool-Hinweis (als `block` **oder** `final`) | Prosa bleibt stehen, Marker-Reaktion greift |
| Prosa, kein `final` | Salvage schreibt die Prosa |
| Nur Tool-Hinweise, keine Prosa | Hinweis bleibt sichtbar — **nicht** löschen, Stille ist schlimmer |
| Wirklich leeres `final` | Platzhalter löschen, sonst „(no reply generated)" |
| Antwort beginnt mit ⚠️ | geht unverändert durch |

Alle fünf sind in `tests/channel.test.ts` unter *„with tool notices on the prose
path"* abgedeckt. Wer den Lifecycle ändert, lässt diese Tests zuerst rot werden.

## Host-seitige Schalter

- `agents.defaults.verboseDefault` — ohne `"on"` gibt es **keine** `kind:"tool"`-
  Deliveries und damit nie die Fortschrittsansicht. Plugin-Code ist notwendig, aber
  nicht hinreichend.
- `agents.defaults.toolProgressDetail` — `"explain"` für kompakte Labels, `"raw"` für
  rohe Kommandos.
- `messages.suppressToolErrors` — unterdrückt ⚠️-Tool-Fehler global. Wirkt als
  Notbremse, versteckt aber alle Tool-Fehler; der Plugin-Guard ist der bessere Weg.

## Nachbetrachtung

`AGENTS.md` der Agenten enthält seit längerem den Hinweis, den Abschluss lieber
aktiv als eigene Nachricht zu posten, „weil sie verloren gehen kann". Das war der
Versuch, einen Infrastruktur-Bug per Prompt zu umgehen — und er trägt nicht: aus
Sicht des Modells war die Antwort korrekt abgesetzt. Solche Defekte gehören in den
Lifecycle, nicht in die Persona.
