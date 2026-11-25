// Finds every chowk (major junction or roundabout) in each city and names as many as possible.
//   1. Junctions: where bigger roads (tertiary and up) meet in 3+ clearly different directions, plus roundabouts.
//   2. Names: OpenStreetMap junction/roundabout names and anything named "... Chowk", plus chowk names
//      mentioned inside place names and addresses ("Opp. BMC Chowk" → "BMC Chowk") from data/v3/<city>-places.json.
//   3. Each name is snapped to the nearest junction within 200 m; the most-mentioned name wins.
// Output: data/v3/<city>-chowks.json  { c: [[name, lat, lon, kind, mentions], ...] }  kind: j = junction, r = roundabout, n = named spot only
// Run: node scripts/chowks.mjs [city]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CITIES = {
  jalandhar: [31.27, 75.52, 31.38, 75.65],
  ludhiana: [30.84, 75.76, 30.95, 75.92],
  amritsar: [31.59, 74.81, 31.68, 74.93],
  phagwara: [31.20, 75.74, 31.25, 75.80],
};
const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const RANK = { motorway: 4, trunk: 4, primary: 3, secondary: 2, tertiary: 1, motorway_link: 1, trunk_link: 1, primary_link: 1, secondary_link: 1, tertiary_link: 1 };
const CHOWK = /(chowk|chownk|chauk|chouk|chowck|chok|ਚੌਂਕ|ਚੌਕ|चौक)/i;
const rad = Math.PI / 180;
const hav = (a1, o1, a2, o2) => { const dA = (a2 - a1) * rad, dO = (o2 - o1) * rad; const x = Math.sin(dA / 2) ** 2 + Math.cos(a1 * rad) * Math.cos(a2 * rad) * Math.sin(dO / 2) ** 2; return 12742000 * Math.asin(Math.sqrt(x)); };
const bearing = (a1, o1, a2, o2) => Math.atan2((o2 - o1) * Math.cos(a1 * rad), a2 - a1) / rad;
const angDiff = (a, b) => ((b - a) % 360 + 540) % 360 - 180;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function overpass(q) {
  if (process.env.NO_OVERPASS) return [];
  for (let attempt = 0; attempt < 3; attempt++) for (const ep of ENDPOINTS) {
    try {
      const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'green-route/1.0' }, signal: AbortSignal.timeout(180000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return (await r.json()).elements;
    } catch (e) { console.warn(`  ${ep}: ${e.message}`); }
    await sleep(10000);
  }
  return [];
}

// "OYO near BMC chowk", "Opp. Guru Nanak Mission Chowk, GT Road" → "BMC Chowk", "Guru Nanak Mission Chowk"
const STOP = new Set(['near', 'opp', 'opposite', 'behind', 'beside', 'nr', 'at', 'on', 'the', 'road', 'rd', 'street', 'shop', 'no', 'and', 'in', 'front', 'of', 'to', 'jalandhar', 'ludhiana', 'amritsar', 'phagwara', 'punjab', 'city']);
function chowkName(text) {
  if (!text) return null;
  for (const part of String(text).split(/[,;|()\-–]/)) {
    const m = part.match(/([\p{L}\p{N}.' ]{2,40}?)\s*(chowk|chownk|chauk|chouk|chowck|chok)\b/iu) || part.match(/([\p{L}\p{N}.' ]{1,40}?)\s*(ਚੌਂਕ|ਚੌਕ|चौक)/u);
    if (!m) continue;
    let words = m[1].trim().split(/\s+/).filter(Boolean);
    // keep the last 1–4 words before "chowk", dropping filler like "near", "opp"
    let i = words.length - 1; const keep = [];
    while (i >= 0 && keep.length < 4) { const w = words[i].replace(/[.']/g, ''); if (STOP.has(w.toLowerCase())) { if (keep.length) break; i--; continue; } keep.unshift(words[i]); i--; }
    while (keep.length > 1 && /^[#\d]/.test(keep[0])) keep.shift(); // "329 Basti Adda" → "Basti Adda"
    if (!keep.length || keep.join('').length < 2 || /^\d+$/.test(keep.join(''))) continue;
    if (/^(service|road|main|gt|t|national|state|highway|link)$/i.test(keep.join(' ')) || /\b(road|marg|highway|bypass|junction)$/i.test(keep.join(' '))) continue;
    const keep3 = keep.slice(-3);
    while (keep3.length > 1 && /^[#\d]/.test(keep3[0])) keep3.shift();
    const base = keep3.map(w => ((/^[A-Z]{2,3}$/.test(w)) || (w.length <= 4 && /^[a-z]+$/i.test(w) && !/[aeiou]/i.test(w))) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
    return /[ऀ-ॿ਀-੿]/.test(m[2]) ? base + ' ' + m[2] : base + ' Chowk';
  }
  return null;
}
const skel = s => s.toLowerCase().replace(/chowk|chownk|chauk|chouk|chowck|chok/g, '').replace(/[^a-z0-9]/g, '').replace(/[aeiouwyh]/g, '').replace(/(.)\1+/g, '$1');

async function city(name, [s, w, n, e]) {
  const roadsFn = `data/v3/${name}.json`;
  if (!existsSync(roadsFn)) { console.log(`${name}: no road file`); return; }
  const c = JSON.parse(readFileSync(roadsFn, 'utf8'));
  const N = c.n.length / 2, lat = new Float64Array(N), lon = new Float64Array(N);
  for (let i = 0; i < N; i++) { lat[i] = c.n[2 * i] / 1e6; lon[i] = c.n[2 * i + 1] / 1e6; }
  // neighbours with the best road rank between them
  const nb = new Map();
  const link = (a, b, r) => { let m = nb.get(a); if (!m) nb.set(a, m = new Map()); if ((m.get(b) ?? -1) < r) m.set(b, r); };
  for (const wy of c.w) { const h = c.hw[wy[0]], r = RANK[h] ?? 0; for (let k = 2; k + 1 < wy.length; k++) { link(wy[k], wy[k + 1], r); link(wy[k + 1], wy[k], r); } }
  // 1. junction candidates
  const cand = [];
  for (const [i, m] of nb) {
    if (m.size < 3) continue;
    const dirs = []; let main = 0;
    for (const [j, r] of m) if (r >= 1) { dirs.push(bearing(lat[i], lon[i], lat[j], lon[j])); if (r >= 2) main++; }
    if (dirs.length < 3) continue;
    const distinct = []; for (const b of dirs) if (distinct.every(x => Math.abs(angDiff(x, b)) >= 35)) distinct.push(b);
    if (distinct.length >= 3) cand.push({ i, main });
  }
  // cluster nodes of the same junction (dual carriageways, slip roads) within 70 m
  const juncs = [];
  for (const cd of cand.sort((a, b) => b.main - a.main)) {
    const la = lat[cd.i], lo = lon[cd.i];
    const j = juncs.find(x => hav(la, lo, x.la, x.lo) < 70);
    if (j) { j.la = (j.la * j.n + la) / (j.n + 1); j.lo = (j.lo * j.n + lo) / (j.n + 1); j.n++; j.main = Math.max(j.main, cd.main); }
    else juncs.push({ la, lo, n: 1, main: cd.main, kind: 'j', names: new Map() });
  }
  // 2. OpenStreetMap: roundabouts and named junctions / chowks
  const b = [s, w, n, e].map(x => x.toFixed(4)).join(',');
  const els = await overpass(`[out:json][timeout:120];(way["junction"~"roundabout|circular"](${b});nwr["junction"]["name"](${b});nwr["name"~"chowk|chownk|chauk|chouk|ਚੌਂਕ|ਚੌਕ|चौक",i](${b});nwr["highway"]["name"~"chowk|chownk|chauk",i](${b}););out tags center qt;`);
  const mentions = []; // [name, lat, lon, weight]
  for (const el of els) {
    const t = el.tags || {}, la = el.lat ?? el.center?.lat, lo = el.lon ?? el.center?.lon; if (la == null) continue;
    if (t.junction === 'roundabout' || t.junction === 'circular') {
      const j = juncs.find(x => hav(la, lo, x.la, x.lo) < 90);
      if (j) j.kind = 'r'; else juncs.push({ la, lo, n: 1, main: 1, kind: 'r', names: new Map() });
    }
    // a roundabout/junction carrying a road's name ("GT Road; Sher Shah Suri Marg") is not a chowk name
    const roadLike = /road|marg|highway|\bnh\b|\bsh\b|bypass|service|flyover|bridge|junction|street|[;\-–]/i;
    const nm = t.name && (CHOWK.test(t.name) ? chowkName(t.name) : (t.junction && !roadLike.test(t.name) ? t.name + ' Chowk' : null));
    if (nm) mentions.push([nm, la, lo, t.junction || t.highway ? 5 : 3]);
  }
  // 3. chowk names inside place names and addresses (OSM + Overture)
  const plFn = `data/v3/${name}-places.json`;
  if (existsSync(plFn)) for (const p of JSON.parse(readFileSync(plFn, 'utf8')).p) {
    for (const text of [p[0], p[5]]) { const nm = chowkName(text); if (nm) mentions.push([nm, p[1], p[2], text === p[0] && /^[^,]*chowk\s*$/i.test(p[0]) ? 3 : 1]); }
  }
  // snap each mention to the nearest junction within 200 m; otherwise it becomes its own named spot
  const spots = [];
  for (const [nm, la, lo, wgt] of mentions) {
    let best = null, bd = 200;
    for (const j of juncs) { const d = hav(la, lo, j.la, j.lo); if (d < bd) { bd = d; best = j; } }
    if (!best) { best = spots.find(x => hav(la, lo, x.la, x.lo) < 150 && x.names.has(skel(nm))); if (!best) { best = { la, lo, n: 1, main: 0, kind: 'n', names: new Map() }; spots.push(best); } }
    const k = skel(nm); if (!k) continue;
    const cur = best.names.get(k) || { name: nm, votes: 0, spell: new Map() };
    cur.votes += wgt; cur.spell.set(nm, (cur.spell.get(nm) || 0) + wgt);
    best.names.set(k, cur);
  }
  const out = [];
  for (const j of [...juncs, ...spots]) {
    const keys = [...j.names.keys()];
    for (const long of keys) for (const short of keys) {
      if (long !== short && short.length >= 2 && long.endsWith(short)) { j.names.get(short).votes += j.names.get(long).votes; j.names.get(long).votes = 0; }
    }
    let name = '', votes = 0;
    for (const v of j.names.values()) if (v.votes > votes) { votes = v.votes; name = [...v.spell].sort((a, b) => b[1] - a[1])[0][0]; }
    if (j.kind === 'n' && votes < 4) continue; // only one or two stray mentions away from any junction
    if (!name && j.kind === 'j' && j.main < 2) continue; // minor unnamed crossing
    out.push([name, +j.la.toFixed(6), +j.lo.toFixed(6), j.kind, votes]);
  }
  // the same name far apart twice (e.g. two "Model Town Chowk"): keep both; same name within 300 m: keep the best-voted
  const final = [];
  for (const ch of out.sort((a, b) => b[4] - a[4])) {
    if (ch[0] && final.some(x => x[0] && (skel(x[0]) === skel(ch[0]) || skel(ch[0]).endsWith(skel(x[0]))) && hav(x[1], x[2], ch[1], ch[2]) < (skel(x[0]) === skel(ch[0]) ? 1500 : 2500))) { ch[0] = ''; if (ch[3] === 'n') continue; }
    if (!ch[0] && ch[3] === 'j' && ch[4] === 0 && false) continue;
    final.push(ch);
  }
  writeFileSync(`data/v3/${name}-chowks.json`, JSON.stringify({ updated: new Date().toISOString(), c: final }));
  const named = final.filter(x => x[0]).length;
  console.log(`${name}: ${final.length} chowks (${named} named, ${final.filter(x => x[3] === 'r').length} roundabouts) from ${juncs.length} junctions and ${mentions.length} name mentions`);
  console.log('  e.g. ' + final.filter(x => x[0]).slice(0, 25).map(x => `${x[0]} (${x[4]})`).join(', '));
}

const only = process.argv[2];
for (const [nm, bb] of Object.entries(CITIES)) if (!only || only === nm) {
  try { await city(nm, bb); } catch (e) { console.error(`${nm}: chowks failed: ${e.message}`); }
}
