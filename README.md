# DiZcover – PWA v0.1

Karten-App mit Fog of War: Gebiet als Polygon verschleiern, durch Bewegen (GPS, 15 m Radius) dauerhaft aufdecken, Fortschritt in Prozent oben rechts.

## Seelenrunde
Nach dem Zeichnen fragt die App, ob eine Seelenrunde gespielt werden soll. Dann werden 8 Seelen und ein Seelenfriedhof zufällig und gut verteilt im Gebiet platziert.
- Seelen sind im Nebel unsichtbar und erscheinen erst, wenn ihre Stelle aufgedeckt wird. Der Friedhof bleibt sichtbar.
- Seele aufnehmen: höchstens 5 m entfernt stehen, dann erscheint „Seele aufnehmen“.
- Sind alle 8 gesammelt: zum Friedhof (höchstens 10 m) und „Seelen abgeben“.

### Keine Seelen in Gebäuden oder Wasser
Beim Dialog „Seelenrunde?“ werden die Positionen schon ausgewürfelt und im Hintergrund geprüft: Die App liest an jeder Stelle die Farbe der OSM-Kartenkachel (Zoom 18) aus. Gebäude- oder Wasserfarbe → neu würfeln. Die Runde startet trotzdem sofort; was noch nicht geprüft ist, wird unsichtbar im Nebel umgesetzt. Kann die Karte nicht gelesen werden, bleibt alles wie es ist.

### Nachtportier, Seelenlast, Seelenkompass
- Der Nachtportier patrouilliert unsichtbar im Gebiet (0,5 m/s). Spürt er dich, folgt er dir mit 0,9–1,2 m/s (langsamer als Gehen). Bei ≤ 8 m Abstand flieht eine getragene Seele an einen neuen Ort im Nebel; danach zieht er sich 45 s zurück.
- Der Portier läuft nur auf Straßen und Wegen: Beim Start der Runde werden die Kartenkacheln des Gebiets (Zoom 17, bei großen Gebieten 16, max. 80 Kacheln) eingelesen, Straßen-/Wegfarben ergeben ein Netz, auf dem er per Breitensuche läuft. Abseits der Straße (Wiese, Platz) kann er dich nur erwischen, wenn du ≤ 8 m an seinem Weg stehst. Ohne lesbare Karte läuft er in Luftlinie.
- Seelenlast: Spürweite 30 m + 10 m pro getragener Seele.
- Bei Verfolgung: roter, pochender Bildschirmrand und Vibrations-Herzschlag, je näher desto stärker.
- Seelenkompass (Knopf unten links): 1 Ladung zum Start, +1 je 10 % aufgedecktes Gebiet. Zeigt 12 s lang die Richtung zur nächsten Seele (bzw. zum Friedhof, wenn alle getragen werden).
- Alle Werte stehen als Konstanten oben in `app.js`.

## Dateien
- `index.html` – Grundgerüst und Bedienelemente
- `style.css` – Gestaltung
- `app.js` – Karte (Leaflet + OpenStreetMap), Zeichnen, Nebel, GPS, Fortschritt
- `sw.js` – Service Worker (offline-fähig, Kartenkacheln werden zwischengespeichert)
- `manifest.webmanifest`, `icons/` – Installierbarkeit als App

## Starten
GPS im Browser funktioniert nur über **HTTPS** (oder `localhost`).

Lokal am Rechner:
```
cd dizcover
python3 -m http.server 8080
```
Dann `http://localhost:8080/?sim=1` öffnen. Im **Testmodus** (`?sim=1`) bewegst du dich per Tippen/Klicken auf die Karte.

Am Handy: Ordner auf einen HTTPS-Webspace laden (z. B. Subdomain bei Strato oder GitHub Pages), Seite öffnen, „Zum Home-Bildschirm“ wählen.

## Bekannte Grenzen
- Aufdecken nur, solange die App offen und der Bildschirm an ist (PWAs bekommen kein Hintergrund-GPS). Die App hält den Bildschirm daher wach.
- Ein Gebiet gleichzeitig. Daten liegen nur im Browser des Geräts (localStorage).
- OpenStreetMap-Kacheln sind für Privat-/Testnutzung okay; für viele Nutzer braucht es einen eigenen Kartenanbieter.
