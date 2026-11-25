# Green Route

A route finder for Jalandhar, Ludhiana, Amritsar and Phagwara. It finds the quickest way across the city with the fewest red lights, using galiyan when that's faster.

**Open it:** https://sanyam1121.github.io/green-route/ (install it from the menu to use it like an app)

## Features
- **Four route options:** Best, Galiyan (small streets), Shortest, and Fewest red lights. Each shows time, distance, red lights and how much of the route is through galiyan.
- **Car or bike, plus traffic level:** Auto picks traffic from the time of day. Main roads slow down at rush hour, so routes move into galiyan.
- **Voice navigation inside the app** in English, Hindi or Punjabi. It gives turn-by-turn directions ("turn left into the gali"), warns about red lights, cameras and reports ahead, and re-routes automatically if you go off route.
- **Shared reports:** police naka, traffic jam, road blocked, potholes, waterlogging, red light, camera, and too narrow for a car. Reports are shared through [ntfy.sh](https://ntfy.sh) and last 12 hours. Blocked roads, potholes, waterlogging and jams change the route.
- **Saved places and recent trips:** Home, Work or any name, one tap to go.
- **Leave now or later?** Compares leaving now, in 15, 30 or 60 minutes.
- **Savings counter:** red lights skipped and minutes saved each week.
- **Dark map** for night driving. **Share** a route on WhatsApp.
- **Narrow lanes:** car routes avoid lanes mapped as narrow, and lanes closed to cars.

## How it works
- Road, signal and camera data come from OpenStreetMap. A GitHub Action (`.github/workflows/update-data.yml`) downloads it weekly into `data/v2/`. To refresh now: **Actions → Update map data → Run workflow**.
- OpenStreetMap is missing most signals, so busy main-road junctions count as **likely red lights** (amber dots). Correct them with **Fix red lights**.
- Routing (Dijkstra) runs in your browser: `js/core.js`. The app is `js/app.js`, and translations are in `js/i18n.js`.
- To add a city, add its bounding box to `CITIES` in `scripts/fetch-data.mjs` and `js/app.js`.
