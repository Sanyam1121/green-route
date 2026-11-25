/* Green Route routing core — no DOM. Works in the browser (window.Core) and in Node (require). */
var Core = (function () {
  // Road classes: 0-4 main roads, 5-9 small streets / galiyan
  const CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'road'];
  const RANK = { motorway: 4, trunk: 4, primary: 3, secondary: 2, tertiary: 1 };
  const clsOf = h => { const i = CLASSES.indexOf((h || '').replace('_link', '')); return i < 0 ? 6 : i; };
  const R = 6371000, rad = Math.PI / 180;
  function hav(a1, o1, a2, o2) { const dA = (a2 - a1) * rad, dO = (o2 - o1) * rad; const x = Math.sin(dA / 2) ** 2 + Math.cos(a1 * rad) * Math.cos(a2 * rad) * Math.sin(dO / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
  function bearing(a1, o1, a2, o2) { return Math.atan2((o2 - o1) * Math.cos(a1 * rad), a2 - a1) / rad; }
  const angDiff = (a, b) => ((b - a) % 360 + 540) % 360 - 180;

  // Convert raw Overpass elements to the compact v2 format used by the saved data files.
  function toCompact(elements) {
    const idx = new Map(), n = [], s = [], cam = [], w = [];
    const hw = CLASSES.concat(['motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
    for (const e of elements) if (e.type === 'node') {
      if (!idx.has(e.id)) { idx.set(e.id, n.length / 2); n.push(Math.round(e.lat * 1e6), Math.round(e.lon * 1e6)); }
      const t = e.tags, i = idx.get(e.id);
      if (t && (t.highway === 'traffic_signals' || t.crossing === 'traffic_signals')) s.push(i);
      if (t && t.highway === 'speed_camera') cam.push(i);
    }
    for (const e of elements) if (e.type === 'way') {
      const t = e.tags || {}, h = t.highway, ow = t.oneway;
      let dir = 0;
      if (ow === 'yes' || ow === '1' || ow === 'true' || t.junction === 'roundabout' || t.junction === 'circular' || h === 'motorway') dir = 1;
      if (ow === '-1') dir = -1;
      if (ow === 'no') dir = 0;
      const wd = parseFloat(t.width || t.est_width || '');
      const narrow = (wd && wd < 3.5) || h === 'living_street' || t.service === 'alley' || t.narrow === 'yes';
      const noCars = t.motorcar === 'no' || t.motorcar === 'destination';
      const ns = e.nodes.map(id => idx.get(id)).filter(i => i !== undefined);
      if (ns.length > 1) w.push([Math.max(0, hw.indexOf(h)), (dir + 1) | (narrow ? 4 : 0) | (noCars ? 8 : 0), ...ns]);
    }
    return { v: 2, hw, n, s, cam, w };
  }

  // Build the road graph from a compact (v1 or v2) data object.
  // adj[u] = [to, metres, info, ...]  where info = class | narrow<<4 | noCars<<5
  function build(c) {
    const N = c.n.length / 2, lat = new Float64Array(N), lon = new Float64Array(N);
    for (let i = 0; i < N; i++) { lat[i] = c.n[2 * i] / 1e6; lon[i] = c.n[2 * i + 1] / 1e6; }
    const adj = Array.from({ length: N }, () => []), nb = new Array(N);
    const par = new Int32Array(N); for (let i = 0; i < N; i++) par[i] = i;
    const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const link = (a, b, r) => { const m = nb[a] || (nb[a] = new Map()); if ((m.get(b) ?? -1) < r) m.set(b, r); };
    const v2 = c.v === 2;
    for (const w of c.w) {
      const h = c.hw[w[0]] || 'residential', f = w[1];
      const dir = v2 ? (f & 3) - 1 : f, narrow = v2 && (f & 4), noCars = v2 && (f & 8);
      const info = clsOf(h) | (narrow ? 16 : 0) | (noCars ? 32 : 0), rk = RANK[h] || 0;
      for (let k = 2; k + 1 < w.length; k++) {
        const a = w[k], b = w[k + 1];
        const d = hav(lat[a], lon[a], lat[b], lon[b]);
        if (dir !== -1) adj[a].push(b, d, info);
        if (dir !== 1) adj[b].push(a, d, info);
        link(a, b, rk); link(b, a, rk);
        const ra = find(a), rb = find(b); if (ra !== rb) par[ra] = rb;
      }
    }
    // Junction degree and "likely red light" junctions: a main road (secondary+) meeting another
    // significant road (tertiary+) in at least three clearly different directions.
    const deg = new Uint8Array(N), likely = [];
    for (let i = 0; i < N; i++) {
      const m = nb[i]; if (!m) continue;
      deg[i] = Math.min(255, m.size);
      if (m.size < 3) continue;
      let M = 0; const dirs = [];
      for (const [j, r] of m) { if (r >= 1) { dirs.push(bearing(lat[i], lon[i], lat[j], lon[j])); if (r >= 2) M++; } }
      if (dirs.length < 3 || M < 2) continue;
      const distinct = [];
      for (const b of dirs) if (distinct.every(x => Math.abs(angDiff(x, b)) >= 35)) distinct.push(b);
      if (distinct.length >= 3) likely.push(i);
    }
    const size = new Map(); let best = -1, bs = 0;
    for (let i = 0; i < N; i++) { if (!adj[i].length) continue; const r = find(i); const k = (size.get(r) || 0) + 1; size.set(r, k); if (k > bs) { bs = k; best = r; } }
    const main = new Uint8Array(N); for (let i = 0; i < N; i++) if (adj[i].length && find(i) === best) main[i] = 1;
    return { lat, lon, adj, deg, osmSig: c.s || [], cams: c.cam || [], likely, main, N };
  }

  function nearest(G, la, lo, onlyMain) {
    let bi = -1, bd = Infinity; const c = Math.cos(la * rad);
    for (let i = 0; i < G.N; i++) {
      if (onlyMain && !G.main[i]) continue;
      const dy = G.lat[i] - la, dx = (G.lon[i] - lo) * c, d = dy * dy + dx * dx;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi < 0 ? null : { i: bi, m: hav(la, lo, G.lat[bi], G.lon[bi]) };
  }

  // Candidate road points near a spot (both sides of a divided road, nearby lanes), closest first.
  function nearMany(G, la, lo, extra = 35, max = 6) {
    const first = nearest(G, la, lo, true); if (!first) return [];
    const lim = Math.min(120, first.m + extra), out = [];
    for (let i = 0; i < G.N; i++) {
      if (!G.main[i] || Math.abs(G.lat[i] - la) > 0.0012 || Math.abs(G.lon[i] - lo) > 0.0014) continue;
      const m = hav(la, lo, G.lat[i], G.lon[i]); if (m <= lim) out.push({ i, m });
    }
    return out.sort((a, b) => a.m - b.m).slice(0, max);
  }

  // kinds: Map(node -> 'sure'|'likely'). Nearby signal nodes form one junction "zone";
  // entering a zone = one stop.
  function zones(G, kinds) {
    const CELL = 0.0006, key = (a, o) => Math.floor(a / CELL) + ':' + Math.floor(o / CELL);
    const cl = [], grid = new Map(), sigCl = new Map();
    const order = [...kinds].sort((a, b) => (a[1] === 'sure' ? 0 : 1) - (b[1] === 'sure' ? 0 : 1));
    for (const [s, kind] of order) {
      const la = G.lat[s], lo = G.lon[s], ca = Math.floor(la / CELL), co = Math.floor(lo / CELL);
      const lim = kind === 'sure' ? 50 : 70;
      let found = -1;
      for (let x = -1; x <= 1 && found < 0; x++) for (let y = -1; y <= 1 && found < 0; y++) {
        for (const c of grid.get((ca + x) + ':' + (co + y)) || []) { if (hav(la, lo, cl[c].lat, cl[c].lon) < lim) { found = c; break; } }
      }
      if (found < 0) { found = cl.length; cl.push({ lat: la, lon: lo, n: 1, kind }); const k = key(la, lo); (grid.get(k) || grid.set(k, []).get(k)).push(found); }
      else { const c = cl[found]; if (c.kind === kind) { c.lat = (c.lat * c.n + la) / (c.n + 1); c.lon = (c.lon * c.n + lo) / (c.n + 1); c.n++; } }
      sigCl.set(s, found);
    }
    const zone = new Int32Array(G.N).fill(-1);
    if (cl.length) {
      const g2 = new Map(); cl.forEach((c, i) => { const k = key(c.lat, c.lon); (g2.get(k) || g2.set(k, []).get(k)).push(i); });
      for (let i = 0; i < G.N; i++) {
        if (!G.adj[i].length) continue;
        const la = G.lat[i], lo = G.lon[i], ca = Math.floor(la / CELL), co = Math.floor(lo / CELL);
        let bd = 30, bc = -1;
        for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (const c of g2.get((ca + x) + ':' + (co + y)) || []) { const d = hav(la, lo, cl[c].lat, cl[c].lon); if (d < bd) { bd = d; bc = c; } }
        zone[i] = bc;
      }
      for (const [s, c] of sigCl) zone[s] = c;
    }
    return { zone, clusters: cl };
  }

  /* o = { mode:'short'|'time', P: seconds per red light, costSp, realSp: m/s by class,
           car: bool, narrowFactor, pen: Float32Array seconds added on entering a node (or null),
           block: Uint8Array nodes that cannot be entered (or null) } */
  function route(G, Z, src, dst, o) {
    const N = G.N, dist = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
    const hn = [], hk = [];
    const push = (n, k) => { let i = hn.length; hn.push(n); hk.push(k); while (i > 0) { const p = (i - 1) >> 1; if (hk[p] <= k) break; hn[i] = hn[p]; hk[i] = hk[p]; i = p; } hn[i] = n; hk[i] = k; };
    const pop = () => { const n = hn[0], ln = hn.pop(), lk = hk.pop(); if (hn.length) { let i = 0; const L = hn.length; while (true) { let c = 2 * i + 1; if (c >= L) break; if (c + 1 < L && hk[c + 1] < hk[c]) c++; if (hk[c] >= lk) break; hn[i] = hn[c]; hk[i] = hk[c]; i = c; } hn[i] = ln; hk[i] = lk; } return n; };
    const zone = Z.zone, short = o.mode === 'short', P = o.P || 0, cs = o.costSp, nf = o.narrowFactor || 1;
    const pen = o.pen, block = o.block, car = !!o.car;
    dist[src] = 0; push(src, 0);
    while (hn.length) {
      const d0 = hk[0], u = pop();
      if (d0 > dist[u]) continue;
      if (u === dst) break;
      const a = G.adj[u], zu = zone[u];
      for (let k = 0; k < a.length; k += 3) {
        const v = a[k], len = a[k + 1], info = a[k + 2];
        if (block && block[v] && v !== dst) continue;
        if (car && (info & 32)) continue;
        let c = short ? len : len / cs[info & 15];
        if (car && (info & 16)) c *= nf;
        const zv = zone[v];
        if (zv >= 0 && zv !== zu) c += short ? 1 : P;
        if (pen && pen[v]) c += short ? pen[v] / 10 : pen[v];
        const nd = d0 + c;
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push(v, nd); }
      }
    }
    if (dist[dst] === Infinity) return null;
    const path = []; for (let x = dst; x !== -1; x = prev[x]) path.push(x); path.reverse();
    return measure(G, Z, path, o.realSp);
  }

  // Distance, time, small-street and narrow-lane metres, red-light zones and cumulative distance along a path.
  function measure(G, Z, path, realSp) {
    let len = 0, time = 0, small = 0, narrow = 0; const hit = [], hitAt = [], cum = new Float64Array(path.length), info = new Int32Array(path.length);
    for (let k = 0; k + 1 < path.length; k++) {
      const u = path[k], v = path[k + 1], a = G.adj[u];
      for (let j = 0; j < a.length; j += 3) if (a[j] === v) {
        const f = a[j + 2]; info[k + 1] = f;
        len += a[j + 1]; time += a[j + 1] / realSp[f & 15];
        if ((f & 15) >= 5) small += a[j + 1];
        if (f & 16) narrow += a[j + 1];
        break;
      }
      cum[k + 1] = len;
      const zv = Z.zone[v];
      if (zv >= 0 && zv !== Z.zone[u] && k + 1 < path.length - 1) { hit.push(zv); hitAt.push(k + 1); }
    }
    return { path, len, time, small, narrow, signals: hit, signalAt: hitAt, cum, info };
  }

  // Turn-by-turn steps from a measured route.
  function steps(G, r) {
    const p = r.path, out = [];
    const pointBack = (k, m) => { let j = k; while (j > 0 && r.cum[k] - r.cum[j] < m) j--; return j; };
    const pointFwd = (k, m) => { let j = k; while (j < p.length - 1 && r.cum[j] - r.cum[k] < m) j++; return j; };
    for (let k = 1; k < p.length - 1; k++) {
      const v = p[k];
      const a = pointBack(k, 20), b = pointFwd(k, 20);
      if (a === k || b === k) continue;
      const bin = bearing(G.lat[p[a]], G.lon[p[a]], G.lat[v], G.lon[v]);
      const bout = bearing(G.lat[v], G.lon[v], G.lat[p[b]], G.lon[p[b]]);
      const ang = angDiff(bin, bout), abs = Math.abs(ang);
      const junction = G.deg[v] >= 3;
      if (!((junction && abs >= 30) || abs >= 65)) continue;
      const type = abs >= 150 ? 'uturn' : abs >= 120 ? 'sharp' : abs >= 55 ? 'turn' : 'slight';
      const nextInfo = r.info[k + 1] || 0, prevInfo = r.info[k] || 0;
      const intoGali = (nextInfo & 15) >= 5 && (prevInfo & 15) < 5;
      const st = { k, at: r.cum[k], type, side: ang > 0 ? 'right' : 'left', gali: intoGali };
      const last = out[out.length - 1];
      if (last && st.at - last.at < 15) { if (abs > 45) out[out.length - 1] = st; continue; }
      out.push(st);
    }
    out.push({ k: p.length - 1, at: r.len, type: 'arrive' });
    return out;
  }

  // Project a GPS fix onto the route near index `hint`; returns {k, along, off} (off = metres from route).
  function project(G, r, la, lo, hint) {
    const p = r.path, from = Math.max(0, (hint || 0) - 10), to = Math.min(p.length - 1, (hint || 0) + 400);
    const cx = Math.cos(la * rad) * 111320, cy = 110540;
    let best = { k: hint || 0, along: r.cum[hint || 0], off: Infinity };
    for (let k = from; k < to; k++) {
      const ax = G.lon[p[k]] * cx, ay = G.lat[p[k]] * cy, bx = G.lon[p[k + 1]] * cx, by = G.lat[p[k + 1]] * cy, px = lo * cx, py = la * cy;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy || 1;
      let t = ((px - ax) * dx + (py - ay) * dy) / L2; t = Math.max(0, Math.min(1, t));
      const qx = ax + t * dx, qy = ay + t * dy, off = Math.hypot(px - qx, py - qy);
      if (off < best.off) best = { k, along: r.cum[k] + t * (r.cum[k + 1] - r.cum[k]), off };
    }
    return best;
  }

  return { build, toCompact, nearest, nearMany, zones, route, measure, steps, project, hav, bearing, CLASSES };
})();
if (typeof module !== 'undefined') module.exports = Core;
