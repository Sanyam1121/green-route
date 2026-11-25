// Downloads drivable roads + traffic signals for each city in CITIES from OpenStreetMap (Overpass API)
// and writes a compact JSON file per city into data/. Run by the GitHub Action, or locally: node scripts/fetch-data.mjs
import { writeFileSync, mkdirSync } from 'node:fs';

const CITIES = {
  jalandhar: [31.27, 75.52, 31.38, 75.65], // south, west, north, east
};

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const HW = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
const HWCODE = HW.split('|');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function query(bb) {
  const b = bb.map(x => x.toFixed(4)).join(',');
  return `[out:json][timeout:180];way["highway"~"^(${HW})$"]["access"!~"^(private|no)$"]["motor_vehicle"!="no"]["area"!="yes"]["service"!~"^(parking_aisle|driveway|drive-through|emergency_access)$"](${b})->.r;.r out body qt;node(w.r);out skel qt;(node["highway"="traffic_signals"](${b});node["crossing"="traffic_signals"](${b}););out body qt;`;
}

async function overpass(q) {
  for (let attempt = 0; attempt < 4; attempt++) {
    for (const ep of ENDPOINTS) {
      try {
        const r = await fetch(ep, {
          method: 'POST',
          body: 'data=' + encodeURIComponent(q),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'green-route/1.0 (github.com/Sanyam1121/green-route)' },
          signal: AbortSignal.timeout(240000),
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        console.log(`  ok from ${ep}: ${j.elements.length} elements`);
        return j.elements;
      } catch (e) {
        console.warn(`  ${ep} failed: ${e.message}`);
      }
    }
    await sleep(20000 * (attempt + 1));
  }
  throw new Error('All Overpass servers failed');
}

async function city(name, [s, w, n, e]) {
  console.log(`Fetching ${name}…`);
  // 2x2 tiles keep each request small enough for busy public servers
  const els = new Map();
  const ms = (s + n) / 2, mw = (w + e) / 2;
  for (const bb of [[s, w, ms, mw], [s, mw, ms, e], [ms, w, n, mw], [ms, mw, n, e]]) {
    for (const el of await overpass(query(bb))) {
      const k = el.type + el.id, prev = els.get(k);
      if (!prev || (el.tags && !prev.tags)) els.set(k, el);
    }
  }
  // compact: n = flat [lat,lon,...] (1e-6 deg ints), s = signal node indices,
  // w = [highwayCode, oneway(-1/0/1), nodeIdx...]
  const idx = new Map(), nodes = [], sig = [], ways = [];
  for (const el of els.values()) if (el.type === 'node') {
    idx.set(el.id, nodes.length / 2);
    nodes.push(Math.round(el.lat * 1e6), Math.round(el.lon * 1e6));
    const t = el.tags;
    if (t && (t.highway === 'traffic_signals' || t.crossing === 'traffic_signals')) sig.push(idx.get(el.id));
  }
  for (const el of els.values()) if (el.type === 'way') {
    const t = el.tags || {}, h = t.highway, ow = t.oneway;
    let dir = 0;
    if (ow === 'yes' || ow === '1' || ow === 'true' || t.junction === 'roundabout' || t.junction === 'circular' || h === 'motorway') dir = 1;
    if (ow === '-1') dir = -1;
    if (ow === 'no') dir = 0;
    const ns = el.nodes.map(id => idx.get(id)).filter(i => i !== undefined);
    if (ns.length > 1) ways.push([HWCODE.indexOf(h), dir, ...ns]);
  }
  const out = { city: name, bbox: [s, w, n, e], updated: new Date().toISOString(), hw: HWCODE, n: nodes, s: sig, w: ways };
  mkdirSync('data', { recursive: true });
  writeFileSync(`data/${name}.json`, JSON.stringify(out));
  console.log(`  wrote data/${name}.json: ${nodes.length / 2} nodes, ${ways.length} ways, ${sig.length} signals`);
}

for (const [name, bb] of Object.entries(CITIES)) await city(name, bb);
