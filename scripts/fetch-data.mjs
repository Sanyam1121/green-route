// Downloads roads, footpaths, cycle paths, traffic signals, cameras and all named places for each city
// from OpenStreetMap (Overpass API) and writes compact JSON files into data/v3/.
// Run by the GitHub Action, or locally: node scripts/fetch-data.mjs [cityName]
import { writeFileSync, mkdirSync } from 'node:fs';

export const CITIES = {
  jalandhar: [31.27, 75.52, 31.38, 75.65], // south, west, north, east
  ludhiana: [30.84, 75.76, 30.95, 75.92],
  amritsar: [31.59, 74.81, 31.68, 74.93],
  phagwara: [31.20, 75.74, 31.25, 75.80],
};

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const ROADS = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
const PATHS = 'track|cycleway|path|pedestrian|footway|steps';
const HWCODE = (ROADS + '|' + PATHS).split('|');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function roadQuery(bb) {
  const b = bb.map(x => x.toFixed(4)).join(',');
  return `[out:json][timeout:180];(way["highway"~"^(${ROADS})$"]["access"!~"^(private|no)$"]["area"!="yes"]["service"!~"^(parking_aisle|driveway|drive-through|emergency_access)$"](${b});way["highway"~"^(${PATHS})$"]["access"!~"^(private|no)$"]["area"!="yes"](${b}););out body qt;node(w);out skel qt;(node["highway"="traffic_signals"](${b});node["crossing"="traffic_signals"](${b});node["highway"="speed_camera"](${b}););out body qt;`;
}
function placeQuery(bb) {
  const b = bb.map(x => x.toFixed(4)).join(',');
  const k = ['amenity', 'shop', 'place', 'tourism', 'leisure', 'office', 'healthcare', 'historic', 'craft', 'club', 'sport'];
  return `[out:json][timeout:180];(${k.map(x => `nwr["name"]["${x}"](${b});`).join('')}nwr["name"]["railway"~"^(station|halt)$"](${b});nwr["name"]["public_transport"="station"](${b});nwr["name"]["landuse"~"^(residential|commercial|retail|industrial)$"](${b});way["name"]["highway"~"^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|pedestrian)$"](${b});nwr["name"]["building"~"^(school|college|university|hospital|temple|gurdwara|mosque|church|commercial|retail|hotel|public|government|train_station)$"](${b}););out tags center qt;`;
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

const num = v => { const m = /([\d.]+)/.exec(v || ''); return m ? parseFloat(m[1]) : NaN; };
const no = v => v === 'no' || v === 'private';

async function roads(name, [s, w, n, e]) {
  const els = new Map();
  const ms = (s + n) / 2, mw = (w + e) / 2;
  for (const bb of [[s, w, ms, mw], [s, mw, ms, e], [ms, w, n, mw], [ms, mw, n, e]]) {
    for (const el of await overpass(roadQuery(bb))) {
      const k = el.type + el.id, prev = els.get(k);
      if (!prev || (el.tags && !prev.tags)) els.set(k, el);
    }
  }
  // v3 compact format:
  //   n = flat [lat,lon,...] in 1e-6 degrees, s = signal node indices, cam = camera node indices
  //   w = [highwayCode, flags, nodeIdx...]
  //   flags = (oneway+1) | narrow<<2 | noCars<<3 | noMotor<<4 | noBicycle<<5 | noFoot<<6
  const idx = new Map(), nodes = [], sig = [], cam = [], ways = [];
  for (const el of els.values()) if (el.type === 'node') {
    idx.set(el.id, nodes.length / 2);
    nodes.push(Math.round(el.lat * 1e6), Math.round(el.lon * 1e6));
    const t = el.tags;
    if (t && (t.highway === 'traffic_signals' || t.crossing === 'traffic_signals')) sig.push(idx.get(el.id));
    if (t && t.highway === 'speed_camera') cam.push(idx.get(el.id));
  }
  const count = { narrow: 0, paths: 0 };
  for (const el of els.values()) if (el.type === 'way') {
    const t = el.tags || {}, h = t.highway, ow = t.oneway;
    const isPath = PATHS.split('|').includes(h);
    let dir = 0;
    if (ow === 'yes' || ow === '1' || ow === 'true' || t.junction === 'roundabout' || t.junction === 'circular' || h === 'motorway') dir = 1;
    if (ow === '-1') dir = -1;
    if (ow === 'no' || isPath) dir = 0;
    const width = num(t.width) || num(t['est_width']);
    const narrow = (width && width < 3.5) || h === 'living_street' || t.service === 'alley' || t.narrow === 'yes';
    const noCars = t.motorcar === 'no' || t.motorcar === 'destination';
    const noMotor = no(t.motor_vehicle) || no(t.vehicle);
    const noBicycle = no(t.bicycle) || t.bicycle === 'dismount' || no(t.vehicle) || h === 'steps';
    const noFoot = no(t.foot) || (h === 'motorway' && t.foot !== 'yes');
    if (narrow) count.narrow++;
    if (isPath) count.paths++;
    const ns = el.nodes.map(id => idx.get(id)).filter(i => i !== undefined);
    if (ns.length > 1) ways.push([HWCODE.indexOf(h), (dir + 1) | (narrow ? 4 : 0) | (noCars ? 8 : 0) | (noMotor ? 16 : 0) | (noBicycle ? 32 : 0) | (noFoot ? 64 : 0), ...ns]);
  }
  const out = { v: 3, city: name, bbox: [s, w, n, e], updated: new Date().toISOString(), hw: HWCODE, n: nodes, s: sig, cam, w: ways };
  writeFileSync(`data/v3/${name}.json`, JSON.stringify(out));
  console.log(`  wrote data/v3/${name}.json: ${nodes.length / 2} nodes, ${ways.length} ways (${count.paths} footpaths/cycle paths, ${count.narrow} narrow), ${sig.length} signals, ${cam.length} cameras`);
}

// Place type from tags: short codes the app turns into icons, labels and "nearest" searches
function typeOf(t) {
  const a = t.amenity, sh = t.shop, rel = t.religion;
  if (a === 'place_of_worship' || ['temple', 'gurdwara', 'mosque', 'church'].includes(t.building)) {
    if (rel === 'sikh' || t.building === 'gurdwara') return 'gurdwara';
    if (rel === 'muslim' || t.building === 'mosque') return 'mosque';
    if (rel === 'christian' || t.building === 'church') return 'church';
    return 'temple';
  }
  if (a === 'fuel') return 'fuel';
  if (a === 'charging_station') return 'ev';
  if (a === 'hospital' || t.building === 'hospital' || t.healthcare === 'hospital') return 'hospital';
  if (a === 'clinic' || a === 'doctors' || a === 'dentist' || t.healthcare) return 'clinic';
  if (a === 'pharmacy' || sh === 'chemist') return 'pharmacy';
  if (a === 'atm') return 'atm';
  if (a === 'bank') return 'bank';
  if (a === 'school' || t.building === 'school' || a === 'kindergarten') return 'school';
  if (a === 'college' || a === 'university' || t.building === 'college' || t.building === 'university') return 'college';
  if (a === 'restaurant' || a === 'food_court') return 'restaurant';
  if (a === 'fast_food' || a === 'cafe' || a === 'ice_cream' || sh === 'bakery' || sh === 'confectionery') return 'cafe';
  if (t.tourism === 'hotel' || t.tourism === 'guest_house' || t.building === 'hotel') return 'hotel';
  if (a === 'police') return 'police';
  if (a === 'bus_station' || t.highway === 'bus_stop') return 'bus';
  if (t.railway === 'station' || t.railway === 'halt' || t.public_transport === 'station' || t.building === 'train_station') return 'train';
  if (a === 'cinema') return 'cinema';
  if (a === 'marketplace' || sh === 'mall' || t.landuse === 'retail' || t.landuse === 'commercial') return 'market';
  if (t.leisure === 'park' || t.leisure === 'garden' || t.leisure === 'playground') return 'park';
  if (t.leisure === 'fitness_centre' || t.leisure === 'sports_centre' || t.leisure === 'stadium' || t.sport) return 'sport';
  if (a === 'townhall' || t.office === 'government' || t.building === 'government' || a === 'courthouse' || a === 'post_office') return 'govt';
  if (t.place) return 'area';
  if (t.landuse === 'residential') return 'area';
  if (t.highway) return 'road';
  if (sh) return 'shop';
  if (t.tourism || t.historic) return 'sight';
  if (t.office) return 'office';
  return 'other';
}

async function places(name, bb) {
  const els = await overpass(placeQuery(bb));
  const out = [], seen = new Map();
  for (const el of els) {
    const t = el.tags || {}; const nm = (t.name || '').trim(); if (!nm) continue;
    const la = el.lat ?? el.center?.lat, lo = el.lon ?? el.center?.lon; if (la == null) continue;
    const ty = typeOf(t);
    // roads are split into many pieces: keep one point per road name per ~400 m
    const key = nm.toLowerCase() + '|' + ty, prev = seen.get(key) || [];
    if (prev.some(([a, o]) => Math.abs(a - la) < 0.004 && Math.abs(o - lo) < 0.004)) continue;
    prev.push([la, lo]); seen.set(key, prev);
    const alt = [t['name:hi'], t['name:pa'], t['name:en'] !== nm ? t['name:en'] : null, t.alt_name, t.old_name].filter(Boolean).join(';');
    out.push([nm, +la.toFixed(5), +lo.toFixed(5), ty, alt || 0, t['addr:street'] || t['addr:suburb'] || 0]);
  }
  writeFileSync(`data/v3/${name}-places.json`, JSON.stringify({ updated: new Date().toISOString(), p: out }));
  const byType = {}; for (const p of out) byType[p[3]] = (byType[p[3]] || 0) + 1;
  console.log(`  wrote data/v3/${name}-places.json: ${out.length} places ${JSON.stringify(byType)}`);
}

mkdirSync('data/v3', { recursive: true });
const only = process.argv[2];
for (const [name, bb] of Object.entries(CITIES)) {
  if (only && only !== name) continue;
  console.log(`Fetching ${name}…`);
  try { await places(name, bb); } catch (e) { console.error(`${name} places failed: ${e.message}`); process.exitCode = 1; }
  try { await roads(name, bb); } catch (e) { console.error(`${name} roads failed: ${e.message}`); process.exitCode = 1; }
}
