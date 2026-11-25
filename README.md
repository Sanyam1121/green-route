# Green Route

A map for Jalandhar that finds the shortest way between two points with the fewest traffic signals.

- **Shortest:** least distance.
- **Balanced:** takes a detour only when it's quicker than waiting at the signals it skips. You set how many seconds one signal costs.
- **Fewest signals:** avoids red lights as hard as possible.

Pick a route and press **Navigate in Google Maps** for turn-by-turn directions along that path.

## How it works

- Road and signal data come from OpenStreetMap. A GitHub Action (`.github/workflows/update-data.yml`) downloads it every week into `data/jalandhar.json`. To refresh now, open **Actions → Update map data → Run workflow**.
- Routing runs in your browser with Dijkstra's algorithm. A traffic-signal junction counts as one stop, and the stop gets a time penalty.
- OpenStreetMap often misses signals in Indian cities. Use **Fix signals** on the map to add or remove them. Fixes are saved in your browser.
- To add another city, put its bounding box in `CITIES` in `scripts/fetch-data.mjs`.
