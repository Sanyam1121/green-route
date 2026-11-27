/* Green Route routing core — no DOM. Works in the browser (window.Core) and in Node (require). */
var Core = (function () {
  // Road classes: 0-4 main roads, 5-9 small streets / galiyan, 10-15 paths (no motor vehicles)
  const CLASSES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'road',
    'track', 'cycleway', 'path', 'pedestrian', 'footway', 'steps'];
  const RANK = { motorway: 4, trunk: 4, primary: 3, secondary: 2, tertiary: 1 };
  const clsOf = h => { const i = CLASSES.indexOf((h || '').replace('_link', '')); return i < 0 ? 6 : i; };
  const R = 6371000, rad = Math.PI / 180;
  function hav(a1, o1, a2, o2) { const dA = (a2 - a1) * rad, dO = (o2 - o1) * rad; const x = Math.sin(dA / 2) ** 2 + Math.cos(a1 * rad) * Math.cos(a2 * rad) * Math.sin(dO / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }
  function bearing(a1, o1, a2, o2) { return Math.atan2((o2 - o1) * Math.cos(a1 * rad), a2 - a1) / rad; }
  const angDiff = (a, b) => ((b - a) % 360 + 540) % 360 - 180;
  const GAP = 65536; // edge info bit: crossing a divided road at a junction gap

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
      const no = x => x === 'no' || x === 'private';
      if (CLASSES.indexOf(h) >= 10) dir = 0;
      const noMotor = no(t.motor_vehicle) || no(t.vehicle), noBicycle = no(t.bicycle) || t.bicycle === 'dismount' || h === 'steps', noFoot = no(t.foot) || h === 'motorway';
      const ns = e.nodes.map(id => idx.get(id)).filter(i => i !== undefined);
      if (ns.length > 1) w.push([Math.max(0, hw.indexOf(h)), (dir + 1) | (narrow ? 4 : 0) | (noCars ? 8 : 0) | (noMotor ? 16 : 0) | (noBicycle ? 32 : 0) | (noFoot ? 64 : 0), ...ns]);
    }
    return { v: 3, hw, n, s, cam, w };
  }

  // Build the road graph from a compact (v1, v2 or v3) data object.
  // adj[u] = [to, metres, info, ...]  where info = class(0-15) | narrow 16 | noCars 32 | againstOneway 64
  //                                             | noMotor 128 | noBicycle 256 | noFoot 512
  // widths: optional array (one per way, decimetres, 0 = unknown) from data/v3/<city>-widths.json
  function build(c, widths) {
    const N = c.n.length / 2, lat = new Float64Array(N), lon = new Float64Array(N);
    for (let i = 0; i < N; i++) { lat[i] = c.n[2 * i] / 1e6; lon[i] = c.n[2 * i + 1] / 1e6; }
    const adj = Array.from({ length: N }, () => []), nb = new Array(N);
    const par = new Int32Array(N); for (let i = 0; i < N; i++) par[i] = i;
    const find = x => { while (par[x] !== x) { par[x] = par[par[x]]; x = par[x]; } return x; };
    const link = (a, b, r) => { const m = nb[a] || (nb[a] = new Map()); if ((m.get(b) ?? -1) < r) m.set(b, r); };
    const vx = c.v >= 2;
    // one-way main roads (each side of a divided road): which way, and the direction of travel at each node
    const cwWay = new Int32Array(N).fill(-1), cwBear = new Float32Array(N), cwCls = new Uint8Array(N);
    for (let wi = 0; wi < c.w.length; wi++) {
      const w = c.w[wi];
      const h = c.hw[w[0]] || 'residential', f = w[1];
      const wcode = widths && widths[wi] ? Math.min(63, Math.max(1, Math.round(widths[wi] / 5))) : 0; // 0.5 m units
      const dir = vx ? (f & 3) - 1 : f;
      const info = clsOf(h) | (vx && (f & 4) ? 16 : 0) | (vx && (f & 8) ? 32 : 0) | (vx && (f & 16) ? 128 : 0) | (vx && (f & 32) ? 256 : 0) | (vx && (f & 64) ? 512 : 0) | (wcode << 10);
      const rk = RANK[h] || 0;
      if (dir !== 0 && rk > 0) for (let k = 2; k < w.length; k++) {
        const a = w[k], b = w[k + 1 < w.length ? k + 1 : k - 1], fw = k + 1 < w.length ? 1 : -1;
        let br = bearing(lat[a], lon[a], lat[b], lon[b]); if (fw * dir < 0) br += 180;
        cwWay[a] = wi; cwBear[a] = br; cwCls[a] = clsOf(h);
      }
      for (let k = 2; k + 1 < w.length; k++) {
        const a = w[k], b = w[k + 1];
        const d = hav(lat[a], lon[a], lat[b], lon[b]);
        // one-way streets also get a reverse edge marked "against" that only walkers may use
        adj[a].push(b, d, dir === -1 ? info | 64 : info);
        adj[b].push(a, d, dir === 1 ? info | 64 : info);
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
    // Divider gaps: where a side street meets one side of a divided road, let routes cross to the other side
    // (most junctions in Indian cities have a gap in the divider; OpenStreetMap rarely draws it).
    // Marked GAP (bit 16) so routing can add a waiting penalty or skip them.
    let gaps = 0;
    {
      const CELL = 0.0004, grid = new Map(), key = (a, o) => Math.floor(a / CELL) + ':' + Math.floor(o / CELL);
      for (let i = 0; i < N; i++) if (cwWay[i] >= 0) { const k = key(lat[i], lon[i]); (grid.get(k) || grid.set(k, []).get(k)).push(i); }
      const done = new Set();
      for (let a = 0; a < N; a++) {
        if (cwWay[a] < 0 || !nb[a] || nb[a].size < 3) continue;
        let side = false; for (const j of nb[a].keys()) if (cwWay[j] < 0) { side = true; break; }
        if (!side) continue;
        const ca = Math.floor(lat[a] / CELL), co = Math.floor(lon[a] / CELL);
        let bb = -1, bd = 36;
        for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (const b of grid.get((ca + x) + ':' + (co + y)) || []) {
          if (cwWay[b] === cwWay[a] || Math.abs(angDiff(cwBear[a], cwBear[b])) < 140) continue;
          const d = hav(lat[a], lon[a], lat[b], lon[b]); if (d < 5 || d >= bd) continue;
          const across = Math.abs(angDiff(cwBear[a], bearing(lat[a], lon[a], lat[b], lon[b])));
          if (d > 12 && (across < 45 || across > 135)) continue; // must go across the road, not along it
          if (nb[a].has(b)) continue;
          bd = d; bb = b;
        }
        if (bb < 0) continue;
        const k2 = Math.min(a, bb) + ':' + Math.max(a, bb); if (done.has(k2)) continue; done.add(k2);
        const info = Math.max(cwCls[a], cwCls[bb]) | GAP;
        adj[a].push(bb, bd, info); adj[bb].push(a, bd, info); gaps++;
      }
    }
    const size = new Map(); let best = -1, bs = 0;
    for (let i = 0; i < N; i++) { if (!adj[i].length) continue; const r = find(i); const k = (size.get(r) || 0) + 1; size.set(r, k); if (k > bs) { bs = k; best = r; } }
    const main = new Uint8Array(N); for (let i = 0; i < N; i++) if (adj[i].length && find(i) === best) main[i] = 1;
    return { lat, lon, adj, deg, osmSig: c.s || [], cams: c.cam || [], likely, main, N, ways: c.w, hw: c.hw, widths: widths || null, gaps };
  }

  // Which nodes a traveller can start from / end at (has at least one usable edge).
  function usable(G, o) {
    G._mask = G._mask || {};
    const key = o.who + ':' + (o.narrowBlock ? 1 : 0) + ':' + o.realSp.map(x => x > 0 ? 1 : 0).join('');
    if (G._mask[key]) return G._mask[key];
    const m = new Uint8Array(G.N);
    for (let i = 0; i < G.N; i++) { if (!G.main[i]) continue; const a = G.adj[i]; for (let k = 0; k < a.length; k += 3) if (allowed(a[k + 2], o)) { m[i] = 1; break; } }
    return (G._mask[key] = m);
  }
  function allowed(info, o) {
    if (!o.realSp[info & 15]) return false;
    const who = o.who || 'car';
    if ((info & 64) && who !== 'walk') return false;
    // widths are measured wall to wall, which is wider than the space a car really gets (drains, steps, parked bikes):
    // under 5 m between buildings counts as too narrow for a car
    if (who === 'car') { if (info & 160) return false; const wc = (info >> 10) & 63; return !(o.narrowBlock && wc && wc < 10); }
    if (who === 'bike') return !(info & 128);
    if (who === 'cycle') return !(info & 256);
    return !(info & 512);
  }

  function nearest(G, la, lo, onlyMain) {
    let bi = -1, bd = Infinity; const c = Math.cos(la * rad);
    const mask = onlyMain && onlyMain.length ? onlyMain : null;
    for (let i = 0; i < G.N; i++) {
      if (mask ? !mask[i] : (onlyMain && !G.main[i])) continue;
      const dy = G.lat[i] - la, dx = (G.lon[i] - lo) * c, d = dy * dy + dx * dx;
      if (d < bd) { bd = d; bi = i; }
    }
    return bi < 0 ? null : { i: bi, m: hav(la, lo, G.lat[bi], G.lon[bi]) };
  }

  // Candidate road points near a spot (both sides of a divided road, nearby lanes), closest first.
  function nearMany(G, la, lo, extra = 35, max = 6, mask) {
    const first = nearest(G, la, lo, mask || true); if (!first) return [];
    const lim = Math.min(120, first.m + extra), out = [];
    for (let i = 0; i < G.N; i++) {
      if (!(mask ? mask[i] : G.main[i]) || Math.abs(G.lat[i] - la) > 0.0012 || Math.abs(G.lon[i] - lo) > 0.0014) continue;
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
    const pen = o.pen, block = o.block, car = o.who === 'car', rs = o.realSp;
    // src / dst: a node, or a Map(node -> extra cost) to pick the best of several nearby road points
    const srcs = src instanceof Map ? src : new Map([[src, 0]]), dsts = dst instanceof Map ? dst : new Map([[dst, 0]]);
    for (const [n, c0] of srcs) if (c0 < dist[n]) { dist[n] = c0; push(n, c0); }
    let bestEnd = -1, bestScore = Infinity;
    const gapCost = o.noGaps ? Infinity : short ? 25 : (o.gapPen ?? 30);
    while (hn.length) {
      const d0 = hk[0], u = pop();
      if (d0 > dist[u]) continue;
      if (d0 >= bestScore) break;
      if (dsts.has(u)) { const sc = d0 + dsts.get(u); if (sc < bestScore) { bestScore = sc; bestEnd = u; } }
      const a = G.adj[u], zu = zone[u];
      for (let k = 0; k < a.length; k += 3) {
        const v = a[k], len = a[k + 1], info = a[k + 2];
        if (block && block[v] && !dsts.has(v)) continue;
        if (!rs[info & 15] || !allowed(info, o)) continue;
        let c = short ? len : len / cs[info & 15];
        if (info & GAP) { if (gapCost === Infinity) continue; c += (info & 15) <= 1 ? gapCost * 3 : gapCost; } // highways: few real gaps
        if (car && (info & 16)) c *= nf;
        if (car) {
          if (o.noCar && o.noCar.has(u * N + v)) continue; // marked "too narrow for cars" by people
          const wc = (info >> 10) & 63, cl = info & 15;
          if (wc) { if (wc < 14) c *= 2; } // 5–7 m between buildings: one car at a time, slow
          else if (cl === 7) c *= 1.8; else if (cl === 8) c *= 1.5; else if (cl === 6 || cl === 9) c *= 1.25; // width unknown: lanes are a gamble
        }
        const zv = zone[v];
        if (zv >= 0 && zv !== zu) c += short ? 1 : P;
        if (pen && pen[v]) c += short ? pen[v] / 10 : pen[v];
        const nd = d0 + c;
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push(v, nd); }
      }
    }
    if (bestEnd < 0) return null;
    const path = []; for (let x = bestEnd; x !== -1; x = prev[x]) path.push(x); path.reverse();
    return measure(G, Z, path, o.realSp, o);
  }

  // Distance, time, small-street and narrow-lane metres, red-light zones and cumulative distance along a path.
  function measure(G, Z, path, realSp, o) {
    let gaps = 0, len = 0, time = 0, small = 0, narrow = 0, r_paths = 0, tight = 0, minW = Infinity, prevTight = false; const tightAt = []; const hit = [], hitAt = [], cum = new Float64Array(path.length), info = new Int32Array(path.length);
    for (let k = 0; k + 1 < path.length; k++) {
      const u = path[k], v = path[k + 1], a = G.adj[u];
      for (let j = 0; j < a.length; j += 3) if (a[j] === v && (!o || allowed(a[j + 2], o))) {
        const f = a[j + 2]; info[k + 1] = f;
        len += a[j + 1]; time += a[j + 1] / realSp[f & 15];
        if ((f & 15) >= 5) small += a[j + 1];
        if ((f & 15) >= 10) r_paths += a[j + 1];
        const wc = (f >> 10) & 63, isTight = wc > 0 && wc < 12;
        if (isTight) { tight += a[j + 1]; minW = Math.min(minW, wc / 2); if (!prevTight) tightAt.push([k, wc / 2]); }
        prevTight = isTight;
        if (f & 16) narrow += a[j + 1];
        if (f & GAP) gaps++;
        break;
      }
      cum[k + 1] = len;
      const zv = Z.zone[v];
      if (zv >= 0 && zv !== Z.zone[u] && k + 1 < path.length - 1) { hit.push(zv); hitAt.push(k + 1); }
    }
    return { path, len, time, gaps, small, narrow, paths: r_paths, tight, minW: isFinite(minW) ? minW : 0, tightAt, signals: hit, signalAt: hitAt, cum, info };
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
      let gap = false; for (let j = a; j < b; j++) if ((r.info[j + 1] || 0) & GAP) gap = true;
      const st = { k, at: r.cum[k], type, side: ang > 0 ? 'right' : 'left', gali: intoGali, gap };
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

  return { GAP, build, toCompact, nearest, nearMany, usable, allowed, zones, route, measure, steps, project, hav, bearing, CLASSES };
})();
if (typeof module !== 'undefined') module.exports = Core;
