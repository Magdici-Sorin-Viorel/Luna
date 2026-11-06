# Luna

A simple menstrual cycle calendar (PWA). The interface is in Romanian.

- Logs the first day of each period (the last day is optional; the typical duration comes from Settings or from recorded last days). Predicts the next first day with a recency-weighted mean of the last 12 cycles, median/MAD outlier rejection and a confidence window that narrows as more cycles are recorded.
- Shows 3 preparation days before each predicted period, with short practical tips.
- Installable on the phone (works offline).
- Exports upcoming cycles to the phone calendar (.ics), so the calendar app sends the reminders.
- All data stays on the device (`localStorage`). Export/import backup as JSON.

## Project structure

```
index.html            App markup
css/style.css         Styles (light and dark theme)
js/storage.js         Local persistence, export/import
js/cycle.js           Cycle logic: periods, robust statistics, status, predictions
js/ics.js             Calendar export (.ics) for phone reminders
js/qr.js              QR code encoder for the share screen (no dependencies)
js/app.js             UI rendering and events
sw.js                 Service worker (offline cache)
manifest.webmanifest  PWA manifest
icons/                App icons
```

## Run locally

Any static server works, for example:

```
python3 -m http.server 8080
```

Then open http://localhost:8080.

## Deploy on GitHub Pages

1. Push the files to a GitHub repository (root of the `main` branch).
2. Settings → Pages → Source: *Deploy from a branch* → `main` / root.
3. Open the published URL on the phone and choose *Add to Home Screen*.

When you change app files, bump `CACHE_NAME` in `sw.js` so installed copies update.

## Disclaimer

Predictions are estimates. Luna is not a contraception method and does not replace medical advice.
