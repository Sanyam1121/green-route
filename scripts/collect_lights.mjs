// Traffic lights marked by Green Route users. The app posts each mark ("light here" / "no light here", already
// snapped to a junction) to a public ntfy.sh topic, which keeps messages for 12 hours. This script runs every few
// hours, adds the new marks to data/v3/<city>-lights.json and keeps a running count per junction, so the marks
// last forever and reach every phone. A junction counts as a light while "light" marks outnumber "no light".
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CITIES = {
  jalandhar: [31.27, 75.52, 31.38, 75.65], // south, west, north, east
  ludhiana: [30.84, 75.76, 30.95, 75.92],
  amritsar: [31.59, 74.81, 31.68, 74.93],
  phagwara: [31.20, 75.74, 31.25, 75.80],
};
const pad = 0.05;
for (const [city, [s, w, n, e]] of Object.entries(CITIES)) {
  const file = `data/v3/${city}-lights.json`;
  const old = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { since: 0, l: [] };
  const map = new Map(old.l.map(x => [x[0].toFixed(5) + ',' + x[1].toFixed(5), x])); // [lat, lon, yes, no]
  let since = old.since || 0, added = 0;
  let text = '';
  try {
    const r = await fetch(`https://ntfy.sh/greenroute-pb7-${city}-lights/json?poll=1&since=12h`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    text = await r.text();
  } catch (err) { console.warn(city, 'could not read marks:', err.message); continue; }
  for (const line of text.split('\n')) {
    let m, d; try { m = JSON.parse(line); d = JSON.parse(m.message); } catch { continue; }
    if (m.event !== 'message' || m.time <= old.since) continue;
    if ((d.t !== 'light' && d.t !== 'nolight') || typeof d.la !== 'number' || typeof d.lo !== 'number') continue;
    if (d.la < s - pad || d.la > n + pad || d.lo < w - pad || d.lo > e + pad) continue;
    const la = +d.la.toFixed(6), lo = +d.lo.toFixed(6), k = la.toFixed(5) + ',' + lo.toFixed(5);
    const x = map.get(k) || [la, lo, 0, 0];
    if (d.t === 'light') x[2]++; else x[3]++;
    map.set(k, x); added++; since = Math.max(since, m.time);
  }
  if (!added && existsSync(file)) { console.log(`${city}: no new marks`); continue; }
  const l = [...map.values()];
  writeFileSync(file, JSON.stringify({ updated: new Date().toISOString(), since, l }));
  console.log(`${city}: ${added} new marks, ${l.filter(x => x[2] > x[3]).length} lights, ${l.filter(x => x[3] > x[2]).length} marked "no light"`);
}
