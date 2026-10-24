# DiZcover – PWA v0.1

Karten-App mit Fog of War: Gebiet als Polygon verschleiern, durch Bewegen (GPS, 30 m Radius) dauerhaft aufdecken, Fortschritt in Prozent oben rechts.

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
