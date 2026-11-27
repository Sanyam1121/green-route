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
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(25000) });
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error('token rejected (' + r.status + ')'), { fatal: true });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) { if (e.fatal) throw e; console.warn('  retry:', e.message); await sleep(2000 * (i + 1)); }
  }
  return { data: [], failed: true };
}

mkdirSync('data/v3', { recursive: true });
const t0 = Date.now();
// quick look at what Mapillary has in central Jalandhar (photos, and every kind of detected object)
{
  const box = '75.570,31.320,75.590,31.335';
  const im = await getJSON(`https://graph.mapillary.com/images?access_token=${TOKEN}&fields=id,captured_at&bbox=${box}&limit=2000`);
  const years = {}; for (const x of im.data || []) { const y = new Date(x.captured_at).getFullYear(); years[y] = (years[y] || 0) + 1; }
  console.log('central Jalandhar photos:', (im.data || []).length, JSON.stringify(years));
  const mf = await getJSON(`https://graph.mapillary.com/map_features?access_token=${TOKEN}&fields=id,object_value&bbox=${box}&limit=2000`);
  const kinds = {}; for (const f of mf.data || []) kinds[f.object_value] = (kinds[f.object_value] || 0) + 1;
  console.log('central Jalandhar detected objects:', (mf.data || []).length, JSON.stringify(Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 25)));
  console.log('setup took', Math.round((Date.now() - t0) / 1000), 's');
}
for (const [city, [s, w, n, e]] of Object.entries(CITIES)) {
  const seen = new Map(), boxes = [];
  for (let la = s; la < n - 1e-9; la += STEP) for (let lo = w; lo < e - 1e-9; lo += STEP)
    boxes.push([lo, la, Math.min(lo + STEP, e), Math.min(la + STEP, n)].map(x => x.toFixed(5)).join(','));
  let failed = 0, next = 0;
  // a few boxes at a time; each box follows its own "next page" links
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < boxes.length) {
      const bbox = boxes[next++];
      let url = `https://graph.mapillary.com/map_features?access_token=${TOKEN}&fields=id,object_value,geometry,last_seen_at&object_values=${VALUES}&bbox=${bbox}&limit=2000`;
      while (url) {
        const j = await getJSON(url);
        if (j.failed) failed++;
        for (const f of j.data || []) {
          const [lon, lat] = f.geometry?.coordinates || [];
          if (lat == null) continue;
          seen.set(f.id, [+lat.toFixed(6), +lon.toFixed(6), f.last_seen_at ? new Date(f.last_seen_at).getFullYear() : 0]);
        }
        url = j.paging?.next || null;
      }
    }
  }));
  const list = [...seen.values()];
  writeFileSync(`data/v3/${city}-signals.json`, JSON.stringify({ updated: new Date().toISOString(), source: 'Mapillary', s: list }));
  console.log(`${city}: ${list.length} traffic lights seen in Mapillary photos (${boxes.length} boxes, ${failed} failed, ${Math.round((Date.now() - t0) / 1000)} s)`);
}
