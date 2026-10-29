# London Gameday Navigator

Offline-fähige iPhone-Web-App (PWA) für den London-Trip zu Eagles @ Jaguars, 11.–12.10.2026.

Installieren: Link in Safari öffnen → Teilen → „Zum Home-Bildschirm“ → einmal mit Internet starten.

## Weitere Apps in diesem Branch
- `travel/` – Trip Assistant (Reise-Assistent)
- `stundenplan/` – Schedule (früher Stundenplan): Master-Woche mit Blockern, Zeitstrahl für heute, Wochenübersicht mit Bearbeiten-Modus (gedrückt halten) und To-Dos. Daten nur lokal auf dem Gerät. `stundenplan/push-server/worker.js` ist der optionale Push-Server für Cloudflare Workers (kennt nur Uhrzeiten).
