# ArcivePlayer

Web-Player für Hörbücher und Audio aus dem [Internet Archive](https://archive.org) – im Stil von Apple Music.

- **Suche** über ganz archive.org (gleiche Relevanz wie die Webseite); angezeigt wird nur, was abspielbar ist (Audio oder Video mit Tonspur, nicht gesperrt). Filter: LibriVox-Hörbücher, Deutsch
- **Weiterhören auf die Sekunde**: Position wird alle paar Sekunden, beim Pausieren und beim Schließen/Neuladen der Seite gespeichert. Nach dem Neuladen steht der Player pausiert genau an der letzten Stelle.
- **Merkliste** (Herz), **Mediathek** mit Weiterhören / Gemerkt / Gehört
- Kapitelliste, ±15/30 s, Tempo 0,75–2,5×, Schlaf-Timer, Sperrbildschirm-Steuerung (Media Session)
- Installierbar als App (PWA): in Safari „Teilen → Zum Home-Bildschirm“
- **Offline hören:** Titel herunterladen (kleinste MP3-Variante), danach Wiedergabe ohne Internet/mobile Daten; Verwaltung in der Mediathek unter „Geladen“
- Konto per E-Mail (ohne Passwort): Hörstand, Merkliste und „Gehört“ auf allen Geräten
- KI-Suche (OpenRouter, Claude Haiku 5.5) über eine Supabase Edge Function

Kein Build, kein Server: reine statische Dateien (`index.html`, `js/`, `css/`).

## Lokal starten

```sh
python3 -m http.server 8000
# → http://localhost:8000
```

## Veröffentlichen

Jeder Push auf `main` wird per GitHub Actions auf GitHub Pages deployt
(`.github/workflows/pages.yml`). Einmalig in den Repo-Einstellungen unter
**Settings → Pages → Source: GitHub Actions** auswählen.
