// Traffic lights detected in Mapillary street-level photos (https://www.mapillary.com, CC BY-SA)
// → data/v3/<city>-signals.json as [[lat, lon, lastSeenYear], ...].
// Needs a free Mapillary client token in the MAPILLARY_TOKEN environment variable (a GitHub secret).
import { writeFileSync, mkdirSync } from 'node:fs';

const TOKEN = process.env.MAPILLARY_TOKEN;
if (!TOKEN) { console.log('MAPILLARY_TOKEN is not set — skipping traffic lights from Mapillary.'); process.exit(0); }

const CITIES = {
  jalandhar: [31.27, 75.52, 31.38, 75.65], // south, west, north, east
  ludhiana: [30.84, 75.76, 30.95, 75.92],
  amritsar: [31.59, 74.81, 31.68, 74.93],
  phagwara: [31.20, 75.74, 31.25, 75.80],
};
const VALUES = ['object--traffic-light--general-upright', 'object--traffic-light--general-horizontal', 'object--traffic-light--general-single',
  'object--traffic-light--pedestrians', 'object--traffic-light--other'].join(',');
const STEP = 0.02; // the API only accepts small boxes
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJSON(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error('token rejected (' + r.status + ')'), { fatal: true });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (e.fatal) throw e; console.warn('  retry:', e.message); await sleep(3000 * (i + 1)); }
  }
  return { data: [] };
}

mkdirSync('data/v3', { recursive: true });
for (const [city, [s, w, n, e]] of Object.entries(CITIES)) {
  const seen = new Map();
  for (let la = s; la < n; la += STEP) for (let lo = w; lo < e; lo += STEP) {
    const bbox = [lo, la, Math.min(lo + STEP, e), Math.min(la + STEP, n)].map(x => x.toFixed(5)).join(',');
    let url = `https://graph.mapillary.com/map_features?access_token=${TOKEN}&fields=id,object_value,geometry,last_seen_at&object_values=${VALUES}&bbox=${bbox}&limit=2000`;
    while (url) {
      const j = await getJSON(url);
      for (const f of j.data || []) {
        const [lon, lat] = f.geometry?.coordinates || [];
        if (lat == null) continue;
        seen.set(f.id, [+lat.toFixed(6), +lon.toFixed(6), f.last_seen_at ? new Date(f.last_seen_at).getFullYear() : 0]);
      }
      url = j.paging?.next || null;
    }
  }
  const list = [...seen.values()];
  writeFileSync(`data/v3/${city}-signals.json`, JSON.stringify({ updated: new Date().toISOString(), source: 'Mapillary', s: list }));
  console.log(`${city}: ${list.length} traffic lights seen in Mapillary photos`);
}
