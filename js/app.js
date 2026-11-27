/* Green Route app — UI, trips, search, reports, navigation, settings. Depends on Leaflet, Core, I18N. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const t = (k, v) => I18N.t(k, v);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  };
  const isPhone = () => matchMedia('(max-width:760px)').matches;
  let toastT; const toast = m => { const e = $('toast'); e.textContent = m; e.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => e.classList.remove('show'), 2800); };
  const status = (m, err) => { $('status').textContent = m || ''; $('status').className = err ? 'err' : ''; };
  const hint = m => { $('hint').hidden = !m; $('hint').textContent = m || ''; };

  /* ---------------- cities & options ---------------- */
  const CITIES = {
    jalandhar: { bbox: [31.27, 75.52, 31.38, 75.65], center: [31.325, 75.585] },
    ludhiana: { bbox: [30.84, 75.76, 30.95, 75.92], center: [30.900, 75.850] },
    amritsar: { bbox: [31.59, 74.81, 31.68, 74.93], center: [31.634, 74.873] },
    phagwara: { bbox: [31.20, 75.74, 31.25, 75.80], center: [31.224, 75.770] },
  };
  const opt = Object.assign({ vehicle: 'car', traffic: 'auto', lang: 'en', theme: 'auto', voice: true, likely: true, wait: 45, city: 'jalandhar', widths: false, chowks: true, look: 'game', rotate: true, tilt: true }, store.get('gr-opt', {}));
  if (!CITIES[opt.city]) opt.city = 'jalandhar';
  const saveOpt = () => store.set('gr-opt', opt);

  const MODES = {
    best: { color: '#1f9d55', bg: 'var(--green)' },
    gali: { color: '#e8590c', bg: '#c2410c' },
    short: { color: '#3a6fd8', bg: 'var(--blue)' },
    few: { color: '#8a4fd8', bg: '#6a3fbf' }
  };
  // km/h by class: motorway,trunk,primary,secondary,tertiary | unclassified,residential,living_street,service,road
  //                | track,cycleway,path,pedestrian,footway,steps   (0 = not allowed)
  const BASE = {
    car: [60, 45, 35, 30, 25, 20, 16, 10, 10, 15, 0, 0, 0, 0, 0, 0],
    bike: [50, 40, 32, 28, 24, 22, 20, 16, 15, 18, 12, 0, 0, 0, 0, 0],
    cycle: [0, 15, 15, 15, 15, 15, 14, 12, 12, 12, 10, 16, 10, 6, 6, 0],
    walk: [0, 4.5, 4.8, 4.8, 4.8, 4.8, 4.8, 4.8, 4.8, 4.8, 4.5, 4.8, 4.8, 5, 5, 3]
  };
  const motor = () => opt.vehicle === 'car' || opt.vehicle === 'bike';
  const TRAFFIC = { light: [1, 1, 1, 1, 1], normal: [.9, .8, .8, .85, .9], heavy: [.7, .5, .5, .55, .7] };
  function autoTraffic(d = new Date()) {
    const m = d.getHours() * 60 + d.getMinutes(), sun = d.getDay() === 0;
    if (m < 7 * 60 || m >= 23 * 60) return 'light';
    if (!sun && ((m >= 8 * 60 + 30 && m < 11 * 60) || (m >= 17 * 60 && m < 20 * 60 + 30))) return 'heavy';
    return 'normal';
  }
  const trafficAt = d => opt.traffic === 'auto' ? autoTraffic(d) : opt.traffic;
  function speeds(gali, when) {
    const b = BASE[opt.vehicle] || BASE.car, tr = motor() ? TRAFFIC[trafficAt(when)] : [1, 1, 1, 1, 1];
    return b.map((v, i) => v * (i < 5 ? tr[i] * (gali ? 0.55 : 1) : 1) / 3.6);
  }
  const lightWait = () => opt.vehicle === 'walk' ? Math.round(opt.wait * 0.5) : opt.wait;

  /* ---------------- state ---------------- */
  let G = null, Z = null, A = null, B = null, results = {}, sel = 'best', editMode = false, dataNote = '';
  let fixes = store.get('gr-fixes', { add: [], del: [] }), shared = { add: [], del: [] };
  let reports = [], localReports = store.get('gr-local-reports', []), cleared = new Set();
  let relaxNarrow = false, photoSignals = [], pen = { car: null, bike: null }, block = null, reportPick = null, liveArea = null;

  /* ---------------- map ---------------- */
  const map = L.map('map', { preferCanvas: true, zoomControl: !('ontouchstart' in window) }).setView(CITIES[opt.city].center, 13);
  let sized = false; new ResizeObserver(() => { map.invalidateSize(); if (!sized && map.getSize().x > 50) { sized = true; map.setView(CITIES[opt.city].center, 13); } }).observe($('map'));
  // Base map: "game" = our own dark vector style (styles/game.json on OpenFreeMap tiles), "classic" = OpenStreetMap
  let baseLayer = null;
  const webgl = (() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; } })();
  const gameOn = () => opt.look === 'game' && webgl && !!L.maplibreGL;
  function setBase() {
    if (baseLayer) map.removeLayer(baseLayer);
    baseLayer = gameOn()
      ? L.maplibreGL({ style: 'styles/game.json?v=20', attribution: '&copy; <a href="https://openfreemap.org">OpenFreeMap</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' })
      : L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });
    baseLayer.addTo(map);
    document.body.classList.toggle('game', gameOn());
  }
  setBase();
  const sigLayer = L.layerGroup().addTo(map), camLayer = L.layerGroup().addTo(map), repLayer = L.layerGroup().addTo(map),
    routeLayer = L.layerGroup().addTo(map), meLayer = L.layerGroup().addTo(map);
  const pin = (c, txt) => L.divIcon({ className: '', html: txt === 'B' ? `<div class="pin waypoint" style="--c:${c}"><span>B</span></div>` : `<div class="pin" style="background:${c}">${txt}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
  // route colours: in the game look the chosen route is a glowing purple GPS line
  const GPS = '#c34dff';
  function drawLine(ll, color, on, layer, click) {
    if (gameOn()) {
      if (on) {
        L.polyline(ll, { color: GPS, weight: 18, opacity: .22, interactive: false }).addTo(layer);
        L.polyline(ll, { color: '#0b0f12', weight: 9, opacity: .9, interactive: false }).addTo(layer);
      }
      const l = L.polyline(ll, { color: on ? GPS : color, weight: on ? 6 : 3.5, opacity: on ? 1 : .45 }).addTo(layer);
      if (click) l.on('click', click);
      return l;
    }
    L.polyline(ll, { color: '#fff', weight: on ? 11 : 6, opacity: on ? .95 : .6, interactive: false }).addTo(layer);
    const l = L.polyline(ll, { color, weight: on ? 7 : 4, opacity: on ? 1 : .55 }).addTo(layer);
    if (click) l.on('click', click);
    return l;
  }
  let mA = null, mB = null;

  /* ---------------- data ---------------- */
  const idb = () => new Promise((res, rej) => { try { const r = indexedDB.open('greenroute', 2); r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('osm')) r.result.createObjectStore('osm'); }; r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } });
  async function cacheGet(k) { try { const db = await idb(); return await new Promise(r => { const q = db.transaction('osm').objectStore('osm').get(k); q.onsuccess = () => r(q.result); q.onerror = () => r(null); }); } catch (e) { return null; } }
  async function cachePut(k, v) { try { const db = await idb(); db.transaction('osm', 'readwrite').objectStore('osm').put(v, k); } catch (e) { } }
  async function getJSON(u) { const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) throw new Error(r.status); return r.json(); }

  async function loadCity(name, area) {
    G = null; status(t('loading')); results = {}; routeLayer.clearLayers(); $('result').innerHTML = '';
    let c = null;
    if (!area) {
      try { c = await getJSON(`data/v3/${name}.json`); } catch (e) { }
      if (!c) try { c = await getJSON(`data/v2/${name}.json`); } catch (e) { }
      if (!c && name === 'jalandhar') try { c = await getJSON('data/jalandhar.json'); } catch (e) { }
      if (c) dataNote = t('data_from', { d: new Date(c.updated).toLocaleDateString(I18N.locale(), { day: 'numeric', month: 'short' }) });
    }
    const bb = (area || CITIES[name].bbox).map(x => x.toFixed(4)).join(','), key = 'v3:' + bb;
    if (!c) { const k = await cacheGet(key); if (k && Date.now() - k.t < 7 * 864e5) c = k.d; }
    if (!c) {
      const q = `[out:json][timeout:120];(way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]["access"!~"^(private|no)$"]["area"!="yes"]["service"!~"^(parking_aisle|driveway|drive-through|emergency_access)$"](${bb});way["highway"~"^(track|cycleway|path|pedestrian|footway|steps)$"]["access"!~"^(private|no)$"]["area"!="yes"](${bb}););out body qt;node(w);out skel qt;(node["highway"="traffic_signals"](${bb});node["crossing"="traffic_signals"](${bb});node["highway"="speed_camera"](${bb}););out body qt;`;
      const eps = ['https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass-api.de/api/interpreter'];
      for (let round = 0; round < 2 && !c; round++) for (const ep of eps) {
        try {
          status(t('downloading'));
          const ctl = new AbortController(), tm = setTimeout(() => ctl.abort(), 90000);
          const r = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: ctl.signal });
          clearTimeout(tm); if (!r.ok) throw new Error(r.status);
          c = Core.toCompact((await r.json()).elements); dataNote = ''; break;
        } catch (e) { console.warn('overpass', ep, e); }
      }
      if (!c) { status(t('servers_busy'), true); return; }
      cachePut(key, { t: Date.now(), d: c });
    }
    try { const j = await getJSON('data/signals-extra.json'); shared = { add: j.add || [], del: j.del || [] }; } catch (e) { }
    photoSignals = [];
    if (!area) try { photoSignals = (await getJSON(`data/v3/${name}-signals.json`)).s || []; } catch (e) { }
    status(t('preparing')); await new Promise(r => setTimeout(r, 20));
    if (!area) { await loadPlaces(name); await loadChowks(name); }
    let widths = null;
    if (!area) try { const wj = await getJSON(`data/v3/${name}-widths.json`); if (wj.roads_updated === c.updated) widths = wj.w; } catch (e) { }
    const g = Core.build(c, widths); Z = null; G = g; liveArea = area || null;
    applySignals(); drawCams(); loadReports(); drawWidths(); drawChowks();
    if (!A || !B) idle();
    if (A && B) go();
  }

  function applySignals() {
    const kinds = new Map();
    for (const s of G.osmSig) kinds.set(s, 'sure');
    if (opt.likely) for (const s of G.likely) if (!kinds.has(s)) kinds.set(s, 'likely');
    const rl = [...reports, ...localReports].filter(r => r.t === 'redlight').map(r => [r.la, r.lo]);
    // traffic lights detected in Mapillary street photos count as confirmed
    for (const [la, lo] of photoSignals) { const n = Core.nearest(G, la, lo, true); if (n && n.m < 30) kinds.set(n.i, 'sure'); }
    const allDel = [...shared.del, ...fixes.del], allAdd = [...shared.add, ...fixes.add, ...rl];
    for (const [la, lo] of allDel) for (const s of [...kinds.keys()]) if (Core.hav(G.lat[s], G.lon[s], la, lo) < 45) kinds.delete(s);
    for (const [la, lo] of allAdd) { const n = Core.nearest(G, la, lo, true); if (n && n.m < 40) kinds.set(n.i, 'sure'); }
    Z = Core.zones(G, kinds);
    drawSignals();
  }
  function drawSignals() {
    sigLayer.clearLayers();
    const r = editMode ? 8 : 5;
    for (const c of Z.clusters) L.circleMarker([c.lat, c.lon], { radius: c.kind === 'sure' ? r : r - 1, color: '#fff', weight: 1.5, fillColor: c.kind === 'sure' ? '#e5383b' : '#f2a516', fillOpacity: 1, interactive: false }).addTo(sigLayer);
  }
  function camPoints() {
    const pts = G ? G.cams.map(i => [G.lat[i], G.lon[i]]) : [];
    for (const r of [...reports, ...localReports]) if (r.t === 'camera') pts.push([r.la, r.lo]);
    return pts;
  }
  function drawCams() {
    camLayer.clearLayers();
    for (const p of camPoints()) L.marker(p, { icon: L.divIcon({ className: '', html: '<div class="cam">📷</div>', iconSize: [24, 24], iconAnchor: [12, 12] }), interactive: false }).addTo(camLayer);
  }

  /* ---------------- shared reports (ntfy.sh, kept 12 h) ---------------- */
  const REPORT = {
    police: { icon: '👮', ttl: 2 }, jam: { icon: '🚗', ttl: 1 }, block: { icon: '⛔', ttl: 3 }, pothole: { icon: '🕳️', ttl: 12 },
    water: { icon: '🌊', ttl: 12 }, redlight: { icon: '🚦', ttl: 12, keep: true }, camera: { icon: '📷', ttl: 12, keep: true }, narrow: { icon: '↔️', ttl: 12, keep: true }
  };
  const topic = () => 'greenroute-pb7-' + opt.city;
  const inCity = (la, lo) => { const b = CITIES[opt.city].bbox; return la > b[0] - 0.1 && la < b[2] + 0.1 && lo > b[1] - 0.1 && lo < b[3] + 0.1; };
  async function loadReports() {
    try {
      const r = await fetch(`https://ntfy.sh/${topic()}/json?poll=1&since=12h`);
      if (!r.ok) throw new Error(r.status);
      const lines = (await r.text()).split('\n').filter(Boolean), list = [], now = Date.now() / 1000;
      cleared = new Set();
      for (const ln of lines) {
        let m; try { m = JSON.parse(ln); } catch (e) { continue; }
        if (m.event !== 'message' || typeof m.message !== 'string') continue;
        let d; try { d = JSON.parse(m.message); } catch (e) { continue; }
        if (d.t === 'clear' && typeof d.ref === 'string') { cleared.add(d.ref); continue; }
        if (!REPORT[d.t] || typeof d.la !== 'number' || typeof d.lo !== 'number' || !inCity(d.la, d.lo)) continue;
        if (now - m.time > REPORT[d.t].ttl * 3600) continue;
        list.push({ id: String(m.id), t: d.t, la: d.la, lo: d.lo, time: m.time });
      }
      reports = list.filter(x => !cleared.has(x.id));
      $('repState').textContent = t('reports_live', { n: reports.length });
    } catch (e) { console.warn('reports', e); $('repState').textContent = t('reports_offline'); }
    afterReports();
  }
  function afterReports() {
    if (!G) return;
    buildPenalties(); applySignals(); drawCams(); drawReports();
    if (A && B && !nav) go();
  }
  async function postReport(type, la, lo) {
    const msg = JSON.stringify({ t: type, la: +la.toFixed(6), lo: +lo.toFixed(6) });
    if (REPORT[type].keep) { localReports.push({ id: 'local' + Date.now(), t: type, la, lo, time: Date.now() / 1000, local: true }); store.set('gr-local-reports', localReports); }
    try {
      const r = await fetch(`https://ntfy.sh/${topic()}`, { method: 'POST', body: msg });
      if (!r.ok) throw new Error(r.status);
      toast(t('report_sent'));
    } catch (e) { toast(REPORT[type].keep ? t('report_saved_local') : t('report_failed')); }
    loadReports();
  }
  async function clearReport(rep) {
    if (rep.local) { localReports = localReports.filter(x => x.id !== rep.id); store.set('gr-local-reports', localReports); }
    else try { await fetch(`https://ntfy.sh/${topic()}`, { method: 'POST', body: JSON.stringify({ t: 'clear', ref: rep.id }) }); } catch (e) { }
    reports = reports.filter(x => x.id !== rep.id); map.closePopup(); toast(t('report_removed')); afterReports();
  }
  function drawReports() {
    repLayer.clearLayers();
    const now = Date.now() / 1000;
    for (const r of [...reports, ...localReports.filter(x => x.t !== 'camera')]) {
      const m = L.marker([r.la, r.lo], { icon: L.divIcon({ className: '', html: `<div class="rep">${REPORT[r.t].icon}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }) }).addTo(repLayer);
      const div = document.createElement('div'); div.className = 'pop';
      const ago = Math.max(1, Math.round((now - r.time) / 60));
      div.innerHTML = `<b>${esc(t('rep_' + r.t))}</b><small>${r.local ? esc(t('saved_on_device')) : esc(t('mins_ago', { n: ago < 60 ? ago + ' min' : Math.round(ago / 60) + ' h' }))}</small><button>${esc(t('not_there'))}</button>`;
      div.querySelector('button').onclick = () => clearReport(r);
      m.bindPopup(div);
    }
  }
  // Report effects on routing: blocked nodes, time penalties (car/bike), narrow-for-car
  function buildPenalties() {
    const N = G.N; block = new Uint8Array(N); pen.car = new Float32Array(N); pen.bike = new Float32Array(N);
    const cost = { pothole: 60, water: 180, jam: 180 };
    for (const r of [...reports, ...localReports]) {
      if (!['block', 'pothole', 'water', 'jam', 'narrow'].includes(r.t)) continue;
      const n = Core.nearest(G, r.la, r.lo, true); if (!n || n.m > 40) continue;
      if (r.t === 'block') block[n.i] = 1;
      else if (r.t === 'narrow') pen.car[n.i] += 400;
      else { pen.car[n.i] += cost[r.t]; pen.bike[n.i] += cost[r.t] * (r.t === 'jam' ? 0.4 : 1); }
    }
  }

  /* ---------------- trip ---------------- */
  function setPoint(which, ll, label, noGo) {
    ll = L.latLng(ll);
    const make = (c, tx, cb) => { const m = L.marker(ll, { icon: pin(c, tx), draggable: true, autoPan: true }).addTo(map); m.on('dragend', () => { cb(m.getLatLng()); go(); }); return m; };
    if (which === 'A') { A = ll; if (mA) mA.setLatLng(ll); else mA = make('#1f9d55', 'A', p => { A = p; $('qA').value = t('pinned'); }); $('qA').value = label || t('pinned'); }
    else { B = ll; if (mB) mB.setLatLng(ll); else mB = make('#e5383b', 'B', p => { B = p; $('qB').value = t('pinned'); }); $('qB').value = label || t('pinned'); }
    if (!A) hint(t('hint_start')); else if (!B) hint(isPhone() ? t('hint_dest_phone') : t('hint_dest')); else hint('');
    drawQuick();
    if (!noGo) go();
  }
  function routeOpts(mode, when) {
    const sp = speeds(false, when), car = opt.vehicle === 'car';
    const base = { who: opt.vehicle, realSp: sp, narrowFactor: car ? 2.5 : 1, pen: car ? pen.car : pen.bike, block, narrowBlock: car && !relaxNarrow };
    if (mode === 'short') return { ...base, mode: 'short', costSp: sp };
    if (mode === 'few') return { ...base, mode: 'time', P: 900, costSp: sp };
    if (mode === 'gali') return { ...base, mode: 'time', P: lightWait() * 1.5, costSp: speeds(true, when) };
    return { ...base, mode: 'time', P: lightWait(), costSp: sp };
  }
  function go() {
    routeLayer.clearLayers(); results = {}; $('result').innerHTML = '';
    if (!G || !A || !B) { updateHash(); idle(); return; }
    relaxNarrow = false;
    let mask = Core.usable(G, routeOpts('best'));
    const s = Core.nearest(G, A.lat, A.lng, mask), d = Core.nearest(G, B.lat, B.lng, mask);
    if (!s || !d || s.m > 800 || d.m > 800) { status(t('outside_area'), true); return; }
    if (s.i === d.i) { status(t('same_spot'), true); return; }
    // try nearby start points (e.g. the other side of a divided road) and keep the quickest
    let best = null, src = s.i;
    for (const c of Core.nearMany(G, A.lat, A.lng, 35, 6, mask)) {
      const r = Core.route(G, Z, c.i, d.i, routeOpts('best')); if (!r) continue;
      const score = r.time + r.signals.length * lightWait() + c.m / 1.4;
      if (!best || score < best._score) { best = r; best._score = score; src = c.i; }
    }
    if (!best && opt.vehicle === 'car' && !relaxNarrow) { relaxNarrow = true; return goRelaxed(); }
    if (!best) { status(t('no_route'), true); return; }
    results = { best };
    for (const m of ['gali', 'short', 'few']) results[m] = Core.route(G, Z, src, d.i, routeOpts(m));
    for (const m of Object.keys(results)) if (!results[m]) delete results[m];
    if (!results[sel]) sel = 'best';
    results._dst = d.i;
    status(t('tap_compare'));
    updateHash(); saveRecent();
    render();
    const bnd = L.latLngBounds([[A.lat, A.lng], [B.lat, B.lng]]);
    if (isPhone() || !map.getBounds().pad(-0.1).contains(bnd)) map.fitBounds(bnd, { padding: isPhone() ? [40, 40] : [60, 60], paddingBottomRight: isPhone() ? [30, Math.round($('panel').offsetHeight + 30)] : [60, 60] });
  }
  // A car can't reach the spot without a very narrow lane: route anyway (lanes still cost more) and say so
  function goRelaxed() {
    const mask = Core.usable(G, routeOpts('best'));
    const s = Core.nearest(G, A.lat, A.lng, mask), d = Core.nearest(G, B.lat, B.lng, mask);
    const best = s && d && Core.route(G, Z, s.i, d.i, routeOpts('best'));
    if (!best) { status(t('no_route'), true); return; }
    results = { best, _dst: d.i };
    for (const m of ['gali', 'short', 'few']) { const r = Core.route(G, Z, s.i, d.i, routeOpts(m)); if (r) results[m] = r; }
    if (!results[sel]) sel = 'best';
    status(t('only_narrow'), true); updateHash(); saveRecent(); render();
  }
  const mins = r => Math.max(1, Math.round((r.time + r.signals.length * lightWait()) / 60));
  const km = r => (r.len / 1000).toFixed(r.len < 10000 ? 1 : 0);
  const galiPct = r => Math.round(100 * r.small / Math.max(1, r.len));

  function render() {
    routeLayer.clearLayers();
    const ids = Object.keys(MODES).filter(k => results[k]);
    for (const id of [...ids].sort((a, b) => (a === sel) - (b === sel))) {
      const r = results[id], ll = r.path.map(i => [G.lat[i], G.lon[i]]), on = id === sel;
      drawLine(ll, MODES[id].color, on, routeLayer, () => { sel = id; render(); });
    }
    const cur = results[sel];
    for (const z of new Set(cur.signals)) { const c = Z.clusters[z]; L.circleMarker([c.lat, c.lon], { radius: 9, color: '#fff', weight: 2.5, fillColor: c.kind === 'sure' ? '#e5383b' : '#f2a516', fillOpacity: 1 }).bindTooltip(t(c.kind === 'sure' ? 'light_on_route' : 'likely_on_route')).addTo(routeLayer); }
    const sh = results.short || cur; let why;
    if (sel === 'short') why = cur.signals.length ? t('why_short', { l: t('lights', { n: cur.signals.length }) }) : t('why_short_none');
    else if (sel === 'gali') {
      const b = results.best, dm = mins(b) - mins(cur), ds = b.signals.length - cur.signals.length;
      why = (ds > 0 ? t('fewer_than_best', { n: ds }) : cur.signals.length ? t('same_lights_best') : t('no_lights_cap')) + ' ' + (dm > 0 ? t('min_quicker', { n: dm }) : dm < 0 ? t('min_slower', { n: -dm }) : t('same_time')) + ' ' + t('go_slow');
    } else {
      const ds = sh.signals.length - cur.signals.length, dk = (cur.len - sh.len) / 1000, dm = mins(sh) - mins(cur);
      if (ds <= 0 && Math.abs(dk) < 0.05) why = t('why_same_short');
      else if (ds > 0) why = t('why_skips', { n: ds, extra: dk > 0.05 ? t('km_more', { k: dk.toFixed(1) }) : t('same_dist') }) + (dm > 0 ? ' ' + t('saves_min', { n: dm }) : '');
      else why = dk > 0.05 ? t('why_longer_quicker', { k: dk.toFixed(1) }) : t('why_quickest');
    }
    const warn = opt.vehicle !== 'car' ? '' : cur.tight > 40 ? `<div class="warn">${esc(t('tight_warn', { k: (cur.tight / 1000).toFixed(1), w: cur.minW.toFixed(1) }))}</div>`
      : cur.narrow > 100 ? `<div class="warn">${esc(t('narrow_warn', { k: (cur.narrow / 1000).toFixed(1) }))}</div>` : '';
    const repOn = reportsOnRoute(cur).filter(x => x.t !== 'redlight');
    const repWarn = repOn.length ? `<div class="warn">${esc(t('reports_on_route', { list: [...new Set(repOn.map(x => REPORT[x.t].icon + ' ' + t('rep_' + x.t)))].join(', ') }))}</div>` : '';
    const sameKey = r => r.path.length + '|' + r.len.toFixed(0);
    const same = {}; for (const id of ids) same[id] = ids.find(j => sameKey(results[j]) === sameKey(results[id]));
    $('result').innerHTML = `
      <div class="hero" style="background:${MODES[sel].bg}">
        <div class="k">${esc(t('mode_' + sel))}${sel === 'best' ? ' · ' + esc(t('recommended')) : ''}</div>
        <div class="t">${mins(cur)} ${esc(t('min'))}<small>${km(cur)} km · ${esc(t('lights', { n: cur.signals.length }))}</small></div>
        <div class="g">${esc(t(motor() ? 'pct_gali' : 'pct_lanes', { n: galiPct(cur) }))}</div>
        ${(() => { const v = chowksOnRoute(cur).slice(0, 5).map(c => c.n); return v.length ? `<div class="via">${esc(t('via', { list: v.join(' → ') }))}</div>` : ''; })()}
        <div class="why">${esc(why)}</div>${warn}${repWarn}
        <div class="acts"><button class="go" id="startNav">▶ ${esc(t('start'))}</button><button id="share">${esc(t('share'))}</button></div>
        <a class="gm" id="gmaps" href="${navUrl(cur)}" target="_blank" rel="noopener">${esc(t('open_gmaps'))}</a>
      </div>
      <div class="alts">${ids.map(id => { const r = results[id], dup = same[id] !== id; return `<button class="alt${id === sel ? ' sel' : ''}" data-id="${id}"><i style="background:${MODES[id].color}"></i><b>${esc(t('short_' + id))}</b><span>${dup ? esc(t('same_as', { m: t('short_' + same[id]) })) : mins(r) + ' ' + esc(t('min')) + ' · ' + esc(t('lights_short', { n: r.signals.length }))}</span></button>`; }).join('')}</div>
      ${leaveRow()}
      <div class="saverow"><span>${esc(t('save_dest'))}</span><button data-p="home">🏠 ${esc(t('home'))}</button><button data-p="work">💼 ${esc(t('work'))}</button><button data-p="other">⭐ ${esc(t('other'))}</button></div>`;
    for (const b of document.querySelectorAll('.alt')) b.onclick = () => { sel = b.dataset.id; render(); };
    for (const b of document.querySelectorAll('.saverow button')) b.onclick = () => savePlace(b.dataset.p);
    $('share').onclick = share; $('startNav').onclick = startNav;
    $('gmaps').onclick = () => recordTrip(cur);
    $('panel').classList.remove('min');
  }
  // "Leave now or later?" — same trip at +15/+30/+60 minutes using the time-of-day traffic guess
  function leaveRow() {
    if (opt.traffic !== 'auto' || !results.best || !motor()) return '';
    const s = results.best.path[0], d = results._dst, now = Date.now(), out = [];
    for (const off of [0, 15, 30, 60]) {
      const when = new Date(now + off * 60000);
      const r = off === 0 ? results.best : Core.route(G, Z, s, d, routeOpts('best', when));
      if (r) out.push({ off, m: Math.max(1, Math.round((r.time + r.signals.length * lightWait()) / 60)), tr: autoTraffic(when) });
    }
    const bestM = Math.min(...out.map(x => x.m));
    if (Math.max(...out.map(x => x.m)) - bestM < 2) return '';
    return `<div class="leave"><span>${esc(t('leave'))}</span>${out.map(x => `<em class="${x.m === bestM ? 'win' : ''}"><b>${x.off ? '+' + x.off + ' ' + esc(t('min')) : esc(t('now'))}</b>${x.m} ${esc(t('min'))}</em>`).join('')}</div>`;
  }
  function reportsOnRoute(r) {
    const out = [];
    for (const rep of [...reports, ...localReports]) {
      let best = Infinity, at = 0;
      for (let k = 0; k < r.path.length; k += 1) { const d = Core.hav(rep.la, rep.lo, G.lat[r.path[k]], G.lon[r.path[k]]); if (d < best) { best = d; at = r.cum[k]; } }
      if (best < 35) out.push({ ...rep, at });
    }
    return out;
  }

  function navUrl(r) {
    const p = r.path, n = Math.min(8, Math.max(0, Math.floor(r.len / 500)));
    const smallIdx = []; for (let k = 1; k < p.length - 1; k++) if (((r.info[k] || 0) & 15) >= 5) smallIdx.push(k);
    const pool = smallIdx.length >= n ? smallIdx : p.map((_, k) => k).slice(1, -1);
    const wp = []; for (let k = 1; k <= n && pool.length; k++) { const i = p[pool[Math.floor(k * (pool.length - 1) / (n + 1))]]; wp.push(G.lat[i].toFixed(5) + ',' + G.lon[i].toFixed(5)); }
    const f = x => x.lat.toFixed(5) + ',' + x.lng.toFixed(5);
    return `https://www.google.com/maps/dir/?api=1&origin=${f(A)}&destination=${f(B)}${wp.length ? '&waypoints=' + encodeURIComponent(wp.join('|')) : ''}&travelmode=${({ bike: 'two-wheeler', cycle: 'bicycling', walk: 'walking' })[opt.vehicle] || 'driving'}`;
  }

  /* ---------------- share link ---------------- */
  function updateHash() {
    if (!A || !B) { if (location.hash) history.replaceState(null, '', location.pathname + location.search); return; }
    const p = new URLSearchParams({ c: opt.city, a: A.lat.toFixed(5) + ',' + A.lng.toFixed(5), b: B.lat.toFixed(5) + ',' + B.lng.toFixed(5), an: $('qA').value, bn: $('qB').value });
    history.replaceState(null, '', '#' + p.toString());
  }
  function fromHash() {
    if (!location.hash.includes('a=')) return false;
    const p = new URLSearchParams(location.hash.slice(1)), pa = (p.get('a') || '').split(',').map(Number), pb = (p.get('b') || '').split(',').map(Number);
    if (pa.length !== 2 || pb.length !== 2 || pa.some(isNaN) || pb.some(isNaN)) return false;
    setPoint('A', pa, p.get('an') || '', true); setPoint('B', pb, p.get('bn') || '', true);
    map.fitBounds([pa, pb], { padding: [50, 50] });
    return true;
  }
  async function share() {
    const r = results[sel], url = location.href;
    const text = `${$('qA').value || t('start_pt')} → ${$('qB').value || t('dest_pt')}: ${mins(r)} ${t('min')}, ${km(r)} km, ${t('lights', { n: r.signals.length })} (Green Route)`;
    if (navigator.share) { try { await navigator.share({ title: 'Green Route', text, url }); return; } catch (e) { if (e.name === 'AbortError') return; } }
    try { await navigator.clipboard.writeText(text + '\n' + url); toast(t('link_copied')); }
    catch (e) { location.href = 'https://wa.me/?text=' + encodeURIComponent(text + '\n' + url); }
  }

  /* ---------------- saved places & recent trips ---------------- */
  let places = store.get('gr-places', []), recent = store.get('gr-recent', []);
  const placeKey = () => places.filter(p => p.city === opt.city);
  function savePlace(kind) {
    if (!B) return;
    if (kind === 'other') {
      const row = document.querySelector('.saverow');
      row.innerHTML = `<input id="pname" maxlength="24" placeholder="${esc(t('place_name'))}" aria-label="${esc(t('place_name'))}"><button id="psave">${esc(t('save'))}</button>`;
      $('pname').focus();
      const done = () => { const n = $('pname').value.trim(); if (!n) return; addPlace(n, '⭐'); };
      $('psave').onclick = done; $('pname').onkeydown = e => { if (e.key === 'Enter') done(); };
      return;
    }
    addPlace(t(kind), kind === 'home' ? '🏠' : '💼', kind);
  }
  function addPlace(name, icon, kind) {
    places = places.filter(p => !(p.city === opt.city && (kind ? p.kind === kind : p.n === name)));
    places.push({ n: name, icon, kind: kind || '', la: +B.lat.toFixed(6), lo: +B.lng.toFixed(6), city: opt.city });
    store.set('gr-places', places); toast(t('place_saved', { n: name })); drawQuick(); drawPlacesList();
    const row = document.querySelector('.saverow'); if (row) row.innerHTML = `<span>✓ ${esc(t('place_saved', { n: name }))}</span>`;
  }
  function saveRecent() {
    const e = { an: $('qA').value, bn: $('qB').value, a: [+A.lat.toFixed(5), +A.lng.toFixed(5)], b: [+B.lat.toFixed(5), +B.lng.toFixed(5)], city: opt.city };
    recent = [e, ...recent.filter(x => !(Core.hav(x.a[0], x.a[1], e.a[0], e.a[1]) < 50 && Core.hav(x.b[0], x.b[1], e.b[0], e.b[1]) < 50))].slice(0, 8);
    store.set('gr-recent', recent);
  }
  function drawQuick() {
    const q = $('quick'), list = placeKey();
    q.hidden = !!B || !list.length;
    q.innerHTML = list.map((p, i) => `<button data-i="${i}">${p.icon} ${esc(p.n)}</button>`).join('');
    for (const b of q.children) b.onclick = () => goPlace(list[+b.dataset.i]);
  }
  function goPlace(p) {
    if (!A) locate(true, () => setPoint('B', [p.la, p.lo], p.n));
    setPoint('B', [p.la, p.lo], p.n);
  }
  function drawPlacesList() {
    const list = placeKey();
    $('placesList').innerHTML = list.length ? list.map((p, i) => `<div class="prow"><span>${p.icon} ${esc(p.n)}</span><button data-i="${i}" aria-label="${esc(t('delete'))}">✕</button></div>`).join('') : `<small>${esc(t('no_places'))}</small>`;
    for (const b of $('placesList').querySelectorAll('button')) b.onclick = () => { const p = list[+b.dataset.i]; places = places.filter(x => x !== p); store.set('gr-places', places); drawPlacesList(); drawQuick(); };
  }

  /* ---------------- search: local place index + online search + voice ---------------- */
  const TYPE_ICON = { fuel: '⛽', ev: '🔌', hospital: '🏥', clinic: '🩺', pharmacy: '💊', atm: '🏧', bank: '🏦', school: '🏫', college: '🎓', restaurant: '🍽️', cafe: '☕', hotel: '🏨', police: '👮', bus: '🚌', train: '🚆', cinema: '🎬', market: '🛍️', park: '🌳', sport: '🏟️', govt: '🏛️', area: '🏘️', road: '🛣️', shop: '🏪', sight: '📍', office: '🏢', temple: '🛕', gurdwara: 'ੴ', mosque: '🕌', church: '⛪', chowk: '🔶', other: '📍' };
  // words that mean "find the nearest one of these" (English, Hinglish, Hindi, Punjabi)
  const CATS = {
    fuel: ['petrol pump', 'petrol', 'pump', 'fuel', 'diesel', 'cng', 'पेट्रोल पंप', 'पेट्रोल', 'ਪੈਟਰੋਲ ਪੰਪ', 'ਪੈਟਰੋਲ'],
    ev: ['ev charging', 'charging station', 'charging'],
    chowk: ['chowk', 'chowks', 'chauk', 'chownk', 'चौक', 'ਚੌਂਕ', 'ਚੌਕ'],
    hospital: ['hospital', 'aspatal', 'haspatal', 'hospitals', 'अस्पताल', 'हॉस्पिटल', 'ਹਸਪਤਾਲ'],
    clinic: ['clinic', 'doctor', 'doctors', 'dentist', 'डॉक्टर', 'ਡਾਕਟਰ'],
    pharmacy: ['chemist', 'medical store', 'medical', 'pharmacy', 'dawai', 'dawa', 'दवाई', 'केमिस्ट', 'ਦਵਾਈ', 'ਕੈਮਿਸਟ'],
    atm: ['atm', 'एटीएम', 'ਏਟੀਐਮ'], bank: ['bank', 'बैंक', 'ਬੈਂਕ'],
    temple: ['mandir', 'temple', 'मंदिर', 'ਮੰਦਰ'], gurdwara: ['gurdwara', 'gurudwara', 'gurduara', 'गुरुद्वारा', 'ਗੁਰਦੁਆਰਾ'],
    mosque: ['masjid', 'mosque', 'मस्जिद', 'ਮਸਜਿਦ'], church: ['church', 'girja', 'चर्च', 'ਚਰਚ'],
    school: ['school', 'स्कूल', 'ਸਕੂਲ'], college: ['college', 'university', 'कॉलेज', 'ਕਾਲਜ'],
    restaurant: ['restaurant', 'dhaba', 'khana', 'food', 'ढाबा', 'ਢਾਬਾ'], cafe: ['cafe', 'coffee', 'bakery', 'sweets', 'mithai', 'मिठाई', 'ਮਿਠਾਈ'],
    hotel: ['hotel', 'होटल', 'ਹੋਟਲ'], police: ['police station', 'police', 'thana', 'chowki', 'थाना', 'पुलिस', 'ਥਾਣਾ', 'ਪੁਲਿਸ'],
    bus: ['bus stand', 'bus stop', 'bus adda', 'बस स्टैंड', 'ਬੱਸ ਅੱਡਾ'], train: ['railway station', 'railway', 'station', 'train', 'रेलवे स्टेशन', 'ਰੇਲਵੇ ਸਟੇਸ਼ਨ'],
    park: ['park', 'garden', 'पार्क', 'ਪਾਰਕ'], market: ['market', 'bazaar', 'bazar', 'mall', 'बाज़ार', 'मार्केट', 'ਬਾਜ਼ਾਰ'],
    cinema: ['cinema', 'movie', 'theatre', 'pvr', 'सिनेमा', 'ਸਿਨੇਮਾ'], sport: ['gym', 'stadium', 'जिम', 'ਜਿਮ'], govt: ['post office', 'court', 'dc office']
  };
  const NEAR_WORDS = /\b(near me|nearby|nearest|closest|paas|pass|kol|nede|najdik|nazdeek)\b|पास|नज़दीक|ਨੇੜੇ|ਕੋਲ/g;
  let PL = [];
  async function loadPlaces(name) {
    PL = [];
    try {
      const j = await getJSON(`data/v3/${name}-places.json`);
      const mk = (n, la, lo, ty, alt, st) => { const key = norm(n + ' ' + (alt || '')); return { n, la, lo, ty, st: st || '', key, tok: key.split(' '), sk: key.split(' ').map(skel) }; };
      PL = j.p.map(p => mk(p[0], p[1], p[2], p[3], p[4], p[5]));
      // Localities and streets that only appear in shop/clinic addresses (e.g. "Urban Estate Phase II") become searchable too
      const have = new Set(PL.map(p => norm(p.n))), groups = new Map();
      for (const p of PL) {
        if (!p.st) continue;
        const nm = String(p.st).split(',')[0].replace(/\b(jalandhar|ludhiana|amritsar|phagwara|punjab)\b.*$/i, '').trim();
        if (nm.length < 4 || /^\d+$/.test(nm) || /^(near|opp|opposite|behind|beside|in front|nr\.?|h\.? ?no|house|shop|plot|sco|#)\b/i.test(nm) || have.has(norm(nm))) continue;
        const g = groups.get(norm(nm)) || { n: nm, pts: [] }; g.pts.push([p.la, p.lo]); groups.set(norm(nm), g);
      }
      for (const g of groups.values()) {
        const la = g.pts.reduce((a, x) => a + x[0], 0) / g.pts.length, lo = g.pts.reduce((a, x) => a + x[1], 0) / g.pts.length;
        if (g.pts.some(x => Core.hav(la, lo, x[0], x[1]) > 3000)) continue;
        PL.push(mk(g.n, +la.toFixed(5), +lo.toFixed(5), /\b(road|rd|marg|bazar|bazaar|chowk|street|gali)\b/i.test(g.n) ? 'road' : 'area', '', ''));
      }
    } catch (e) { }
  }
  // Devanagari / Gurmukhi → rough Latin, so "मॉडल टाउन" can match "Model Town"
  const TR = {};
  'अ a|आ a|इ i|ई i|उ u|ऊ u|ए e|ऐ ai|ओ o|औ au|क k|ख kh|ग g|घ gh|ङ n|च ch|छ chh|ज j|झ jh|ञ n|ट t|ठ th|ड d|ढ dh|ण n|त t|थ th|द d|ध dh|न n|प p|फ ph|ब b|भ bh|म m|य y|र r|ल l|व v|श sh|ष sh|स s|ह h|ड़ r|ढ़ rh|क़ q|ख़ kh|ग़ g|ज़ z|फ़ f|ा a|ि i|ी i|ु u|ू u|े e|ै ai|ो o|ौ au|ॉ o|ं n|ँ n|ः h|्  |ਅ a|ਆ a|ਇ i|ਈ i|ਉ u|ਊ u|ਏ e|ਐ ai|ਓ o|ਔ au|ਕ k|ਖ kh|ਗ g|ਘ gh|ਙ n|ਚ ch|ਛ chh|ਜ j|ਝ jh|ਞ n|ਟ t|ਠ th|ਡ d|ਢ dh|ਣ n|ਤ t|ਥ th|ਦ d|ਧ dh|ਨ n|ਪ p|ਫ ph|ਬ b|ਭ bh|ਮ m|ਯ y|ਰ r|ਲ l|ਵ v|ਸ s|ਸ਼ sh|ਹ h|ੜ r|ਜ਼ z|ਫ਼ f|ਖ਼ kh|ਗ਼ g|ਾ a|ਿ i|ੀ i|ੁ u|ੂ u|ੇ e|ੈ ai|ੋ o|ੌ au|ੰ n|ਂ n|ੱ |੍ '.split('|').forEach(x => { const [k, v] = x.split(' '); TR[k] = v || ''; });
  const CONS = /[\u0915-\u0939\u0958-\u095F\u0A15-\u0A39\u0A59-\u0A5E]/;
  TR['\u093C'] = ''; TR['\u0A3C'] = '';
  function translit(s) {
    let out = '';
    const ch = [...s.normalize('NFC')];
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i];
      if (TR[c] === undefined) { out += c; continue; }
      out += TR[c];
      const nx = ch[i + 1];
      if (CONS.test(c) && nx && CONS.test(nx)) out += 'a'; // inherent vowel between consonants
    }
    return out;
  }
  const hasIndic = s => /[ऀ-ॿ਀-੿]/.test(s);
  function norm(s) { return String(s).toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').replace(/\s+/g, ' ').trim(); }
  const skel = w => w.length >= 3 && /^[a-z0-9]+$/.test(w) ? w.replace(/[aeiouwyh]/g, '').replace(/(.)\1+/g, '$1') : '';
  function localSearch(q, limit = 8) {
    const qs = [...new Set([norm(q), ...(hasIndic(q) ? [norm(translit(q))] : [])])].filter(Boolean);
    const here = nearRef(), out = [];
    for (const qn of qs) {
      const qt = qn.split(' '), qsk = qt.map(skel);
      for (const p of PL) {
        let score = 0, ok = true;
        for (let k = 0; k < qt.length; k++) {
          const w = qt[k];
          let best = 0;
          for (let j = 0; j < p.tok.length; j++) {
            const tk = p.tok[j];
            if (tk === w) { best = Math.max(best, 3); }
            else if (tk.startsWith(w)) best = Math.max(best, w.length >= 2 ? 2 : 1);
            else if (w.length >= 4 && tk.includes(w)) best = Math.max(best, 1);
            else if (qsk[k] && qsk[k].length >= 2 && p.sk[j] && p.sk[j].startsWith(qsk[k])) best = Math.max(best, 0.8);
          }
          if (!best) { ok = false; break; }
          score += best;
        }
        if (!ok) continue;
        if (p.key.startsWith(qn)) score += 2;
        const nn = norm(p.n), nsk = nn.split(' ').map(skel).join(' '), qskj = qsk.join(' ');
        if (nn === qn || (qskj.replace(/ /g, '') && nsk === qskj)) score += 4; // the whole name matches exactly
        else if (p.tok.length > qt.length) score -= 0.4 * (p.tok.length - qt.length);
        if (['area', 'market', 'train', 'bus', 'hospital', 'college', 'road'].includes(p.ty)) score += 0.7;
        if (p.ty === 'chowk') score += 1.2;
        const dkm = Core.hav(here[0], here[1], p.la, p.lo) / 1000;
        score -= Math.min(2, dkm / 6) + p.n.length / 80;
        out.push({ p, score });
      }
    }
    out.sort((a, b) => b.score - a.score);
    const seen = new Set(), res = [];
    for (const { p } of out) { const k = p.n + '|' + p.ty; if (seen.has(k)) continue; seen.add(k); res.push(placeItem(p, here)); if (res.length >= limit) break; }
    return res;
  }
  function nearRef() { if (lastFix) return [lastFix.lat, lastFix.lng]; if (A) return [A.lat, A.lng]; const c = map.getCenter(); return [c.lat, c.lng]; }
  const distLabel = m => m < 1000 ? Math.round(m / 10) * 10 + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  function placeItem(p, here) {
    const d = Core.hav(here[0], here[1], p.la, p.lo);
    return { name: p.n, sub: [t('ty_' + p.ty), p.st, distLabel(d)].filter(Boolean).join(' · '), lat: p.la, lon: p.lo, icon: TYPE_ICON[p.ty] || '📍', local: true };
  }
  // "petrol pump", "nearest hospital", "ATM paas", "गुरुद्वारा" → nearest places of that type
  function categoryOf(q) {
    const qn = norm(q).replace(NEAR_WORDS, ' ').replace(/\s+/g, ' ').trim();
    for (const [ty, words] of Object.entries(CATS)) for (const w of words) if (qn === norm(w)) return ty;
    return null;
  }
  function nearestOfType(ty, limit = 8) {
    const here = nearRef();
    if (ty === 'chowk') return CH.filter(c => c.n).map(c => ({ c, d: Core.hav(here[0], here[1], c.la, c.lo) })).sort((a, b) => a.d - b.d).slice(0, limit)
      .map(x => ({ name: x.c.n, sub: t('ty_chowk') + ' · ' + distLabel(x.d), lat: x.c.la, lon: x.c.lo, icon: TYPE_ICON.chowk, local: true }));
    return PL.filter(p => p.ty === ty).map(p => ({ p, d: Core.hav(here[0], here[1], p.la, p.lo) })).sort((a, b) => a.d - b.d).slice(0, limit).map(x => placeItem(x.p, here));
  }

  const ROMAN = { 1: 'i', 2: 'ii', 3: 'iii', 4: 'iv', 5: 'v', 6: 'vi', 7: 'vii', 8: 'viii', 9: 'ix', 10: 'x' };
  function variants(q) {
    const base = q.replace(/[,\s]*(jalandhar|jullundur|ludhiana|amritsar|phagwara)(\s*city)?\s*$/i, '').trim() || q;
    const rom = base.replace(/\b(phase|ph|sector|block)\s*\.?\s*(\d{1,2})\b/gi, (m, w, n) => `${w} ${ROMAN[n] || n}`);
    const noNum = base.replace(/\b(phase|ph)\s*\.?\s*(\d{1,2}|[ivx]+)\b/gi, '').replace(/\s+/g, ' ').trim();
    const lat = hasIndic(base) ? translit(base) : '';
    return [...new Set([base, rom, noNum, lat].filter(x => x && x.length > 1))];
  }
  const searchBox = () => { const b = CITIES[opt.city].bbox; return [b[1] - 0.2, b[0] - 0.2, b[3] + 0.2, b[2] + 0.2]; };
  const distC = (la, lo) => Core.hav(la, lo, CITIES[opt.city].center[0], CITIES[opt.city].center[1]);
  async function photon(q, sig) {
    const c = CITIES[opt.city].center, b = searchBox();
    const j = await (await fetch(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=${c[0]}&lon=${c[1]}&limit=6&lang=en&bbox=${b.join(',')}`, { signal: sig })).json();
    return j.features.map(f => { const p = f.properties; const sub = [p.street, p.district || p.locality, p.city || p.county].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i && v !== p.name).join(', '); return { name: p.name || p.street || 'Place', sub, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], icon: '🔎' }; });
  }
  async function nominatim(q, sig) {
    const b = searchBox();
    const n = await (await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=6&countrycodes=in&bounded=1&viewbox=${b[0]},${b[3]},${b[2]},${b[1]}&q=${encodeURIComponent(q)}`, { signal: sig })).json();
    return n.map(x => { const parts = x.display_name.split(',').map(s => s.trim()); return { name: parts[0], sub: parts.slice(1, 4).join(', '), lat: +x.lat, lon: +x.lon, icon: '🔎' }; });
  }
  function mergeInto(items, list) {
    for (const it of list) {
      if (distC(it.lat, it.lon) > 40000) continue;
      if (items.some(x => norm(x.name) === norm(it.name) && Core.hav(x.lat, x.lon, it.lat, it.lon) < 400)) continue;
      items.push(it);
    }
    return items;
  }
  // Full search used by typing and by voice: saved places, local index, then online services
  async function findPlaces(q, sig, onUpdate) {
    // sentences typed or dictated with the keyboard mic: "Model Town jana hai", "ghar le chalo"
    const stripped = stripFiller(q);
    if (stripped && stripped !== norm(q)) q = stripped;
    const hw = norm(q);
    if (HOME_W.includes(hw) || WORK_W.includes(hw)) {
      const p = placeKey().find(x => x.kind === (HOME_W.includes(hw) ? 'home' : 'work'));
      if (p) { const r = [{ name: p.n, sub: t('saved_place'), lat: p.la, lon: p.lo, icon: p.icon }]; onUpdate && onUpdate(r); return r; }
    }
    const cat = categoryOf(q);
    if (cat && PL.length) { const r = nearestOfType(cat); if (r.length) { r.forEach(x => x.sub = t('nearest') + ' · ' + x.sub); onUpdate && onUpdate(r); return r; } }
    const qn = norm(q);
    let items = placeKey().filter(p => norm(p.n).startsWith(qn)).map(p => ({ name: p.n, sub: t('saved_place'), lat: p.la, lon: p.lo, icon: p.icon }));
    for (const v of variants(q)) mergeInto(items, localSearch(v));
    onUpdate && onUpdate(items);
    const vs = variants(q);
    await Promise.all(vs.slice(0, 3).map(v => photon(v, sig).then(r => { mergeInto(items, r); onUpdate && onUpdate(items); }).catch(() => { })));
    if (items.length < 3) {
      await new Promise(r => setTimeout(r, 400));
      if (sig && sig.aborted) return items;
      try { mergeInto(items, await nominatim(vs[1] || vs[0], sig)); } catch (e) { }
      onUpdate && onUpdate(items);
    }
    return items;
  }

  function setupSearch(which) {
    const inp = $('q' + which), drop = $('d' + which); let t1, ctl, items = [], seq = 0;
    const show = html => { drop.innerHTML = html; drop.hidden = !html; };
    const pick = i => { const it = items[i]; if (!it) return; show(''); inp.blur(); if (it.trip) { setPoint('A', it.trip.a, it.trip.an, true); setPoint('B', it.trip.b, it.trip.bn); return; } setPoint(which, [it.lat, it.lon], it.name); map.panTo([it.lat, it.lon]); };
    const row = (it, i) => `<button data-i="${i}"><b>${it.icon ? it.icon + ' ' : ''}${esc(it.name)}</b><small>${esc(it.sub || '')}</small></button>`;
    const startMenu = () => {
      items = [];
      let h = which === 'A' ? `<button class="loc" data-loc="1">◎ ${esc(t('use_location'))}</button>` : '';
      h += `<div class="chips">${['chowk', 'fuel', 'hospital', 'atm', 'pharmacy', 'gurdwara', 'temple', 'market', 'bus'].map(ty => `<button data-cat="${ty}">${TYPE_ICON[ty]} ${esc(t('ty_' + ty))}</button>`).join('')}</div>`;
      for (const p of placeKey()) items.push({ name: p.n, sub: t('saved_place'), lat: p.la, lon: p.lo, icon: p.icon });
      for (const r of recent.filter(r => r.city === opt.city).slice(0, 4)) items.push({ name: `${r.an || t('start_pt')} → ${r.bn || t('dest_pt')}`, sub: t('recent_trip'), trip: r, icon: '🕘' });
      show(h + items.map(row).join(''));
    };
    const draw = list => { items = list.slice(0, 10); show(items.length ? items.map(row).join('') : `<button disabled><small>${esc(t('searching'))}</small></button>`); };
    const run = q => {
      clearTimeout(t1); const my = ++seq;
      t1 = setTimeout(async () => {
        if (ctl) ctl.abort(); ctl = new AbortController();
        const res = await findPlaces(q, ctl.signal, r => { if (my === seq) draw(r); });
        if (my === seq && !res.length) show(`<button disabled><small>${esc(t('no_places_found'))}</small></button>`);
      }, PL.length ? 120 : 250);
    };
    inp.addEventListener('focus', () => { inp.select(); if (!inp.value || inp.value === t('pinned') || inp.value === t('my_location')) startMenu(); });
    inp.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== inp) show(''); }, 200));
    inp.addEventListener('input', () => { const q = inp.value.trim(); if (q.length < 2) { startMenu(); return; } run(q); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); pick(0); } if (e.key === 'Escape') show(''); });
    drop.addEventListener('pointerdown', e => e.preventDefault());
    drop.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      if (b.dataset.loc) { show(''); inp.blur(); locate(true); }
      else if (b.dataset.cat) { inp.value = t('ty_' + b.dataset.cat); draw(nearestOfType(b.dataset.cat).map(x => (x.sub = t('nearest') + ' · ' + x.sub, x))); if (!items.length) show(`<button disabled><small>${esc(t('none_nearby'))}</small></button>`); }
      else pick(+b.dataset.i);
    });
    setupSearch.pick[which] = pick;
  }
  setupSearch.pick = {};

  /* ---------------- voice search: "ghar le chalo", "Model Town jana hai", "nearest petrol pump" ---------------- */
  const FILLER = ['take me to', 'take me', 'navigate to', 'directions to', 'direction to', 'route to', 'go to', 'show me', 'show', 'i want to go to', 'i want to go', 'please', 'plz', 'jaldi',
    'mujhe', 'mujhko', 'hame', 'hamein', 'humein', 'mainu', 'menu', 'manu', 'asi', 'assi', 'sanu', 'ji', 'bhai', 'paaji', 'yaar',
    'le chalo', 'lai chalo', 'le chal', 'lai chal', 'le jao', 'lai jao', 'chalo', 'chalna hai', 'chalna', 'jana hai', 'jaana hai', 'jana he', 'jana h', 'jana ae', 'jaana ae', 'jaana', 'jana', 'janda', 'jaanda', 'pahuncha do', 'pahunchao', 'pohncha do',
    'ka rasta', 'da rasta', 'ka raasta', 'da raasta', 'rasta', 'raasta', 'route', 'ki taraf', 'wal', 'tak', 'ko', 'nu', 'hai',
    'मुझे', 'हमें', 'ले चलो', 'ले चल', 'ले जाओ', 'चलो', 'चलना है', 'जाना है', 'जाना', 'पहुँचाओ', 'पहुंचाओ', 'का रास्ता', 'रास्ता', 'की तरफ़', 'की तरफ', 'तक', 'को', 'है', 'जी',
    'ਮੈਨੂੰ', 'ਸਾਨੂੰ', 'ਲੈ ਚੱਲੋ', 'ਲੈ ਚਲੋ', 'ਲੈ ਜਾਓ', 'ਚੱਲੋ', 'ਚਲੋ', 'ਜਾਣਾ ਹੈ', 'ਜਾਣਾ', 'ਦਾ ਰਸਤਾ', 'ਰਸਤਾ', 'ਵੱਲ', 'ਤੱਕ', 'ਨੂੰ', 'ਹੈ', 'ਜੀ'].sort((a, b) => b.length - a.length);
  const HOME_W = ['ghar', 'gher', 'home', 'house', 'घर', 'ਘਰ'], WORK_W = ['office', 'ofis', 'offc', 'daftar', 'dafter', 'kaam', 'work', 'dukaan', 'dukan', 'दफ़्तर', 'दफ्तर', 'ऑफिस', 'ऑफ़िस', 'ਦਫ਼ਤਰ', 'ਦਫਤਰ', 'ਆਫ਼ਿਸ'];
  function stripFiller(s) {
    let x = ' ' + norm(s) + ' ';
    for (const f of FILLER) x = x.split(' ' + norm(f) + ' ').join(' ');
    return x.replace(/\s+/g, ' ').trim();
  }
  async function voiceCommand(text) {
    $('micText').textContent = '“' + text + '”';
    let from = null, to = stripFiller(text);
    // "X se Y", "from X to Y", "X ton Y" → both ends
    const m = norm(text).match(/^(?:from )?(.+?) (?:se|to|ton|toh|से|ਤੋਂ) (.+)$/);
    if (m && !/^(go|take me|navigate|route)$/.test(m[1])) { const a = stripFiller(m[1]), b = stripFiller(m[2]); if (a && b) { from = a; to = b; } }
    if (!to) { voiceDone(t('voice_not_understood')); return; }
    const resolve = async q => {
      const qn = norm(q);
      if (HOME_W.includes(qn) || WORK_W.includes(qn)) {
        const kind = HOME_W.includes(qn) ? 'home' : 'work';
        const p = placeKey().find(x => x.kind === kind);
        if (!p) return { missing: kind };
        return { name: p.n, lat: p.la, lon: p.lo };
      }
      const sp = placeKey().find(x => norm(x.n) === qn); if (sp) return { name: sp.n, lat: sp.la, lon: sp.lo };
      const r = await findPlaces(q, null);
      return r[0] || null;
    };
    const dest = await resolve(to);
    if (!dest) { voiceDone(t('voice_no_place', { q: to })); return; }
    if (dest.missing) { voiceDone(t('voice_save_first', { p: t(dest.missing) })); return; }
    let src = null; if (from) src = await resolve(from);
    voiceDone(t('voice_going', { p: dest.name }), true);
    if (src && !src.missing) setPoint('A', [src.lat, src.lon], src.name, true);
    setPoint('B', [dest.lat, dest.lon], dest.name, !A);
    if (!A) locate(true);
    map.panTo([dest.lat, dest.lon]);
  }
  let rec = null;
  function voiceDone(msg, ok) {
    speak(msg); toast(msg);
    setTimeout(() => { $('micSheet').hidden = true; }, ok ? 600 : 1800);
    $('micState').textContent = msg;
  }
  // Brave and some other browsers expose the speech API but block the speech service behind it
  const voiceBlockedBrowser = () => !!navigator.brave || /Firefox|FxiOS|SamsungBrowser\/1[0-5]\b/.test(navigator.userAgent);
  function voiceFail(key) {
    if (rec) { rec.onend = null; try { rec.abort(); } catch (e) { } }
    $('micSheet').hidden = false;
    $('micState').textContent = t(key);
    $('micText').textContent = t('voice_type_tip');
    $('micCancel').textContent = t('type_instead');
    $('micCancel').onclick = () => { $('micSheet').hidden = true; $('micCancel').textContent = t('cancel'); $('micCancel').onclick = cancelVoice; $('qB').focus(); };
  }
  function cancelVoice() { try { rec && rec.abort(); } catch (e) { } $('micSheet').hidden = true; }
  function startVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR || voiceBlockedBrowser()) { voiceFail(SR ? 'voice_browser_blocked' : 'voice_unsupported'); return; }
    try { speechSynthesis.cancel(); } catch (e) { }
    rec = new SR(); rec.lang = I18N.voiceLang(); rec.interimResults = true; rec.maxAlternatives = 1; rec.continuous = false;
    $('micSheet').hidden = false; $('micState').textContent = t('listening'); $('micText').textContent = t('voice_examples');
    $('micCancel').textContent = t('cancel'); $('micCancel').onclick = cancelVoice;
    let final = '', heard = '', failed = false; const started = Date.now();
    rec.onresult = e => { let s = ''; for (const r of e.results) { s += r[0].transcript; if (r.isFinal) final = s; } heard = s; $('micText').textContent = '“' + s + '”'; };
    rec.onerror = e => {
      failed = true;
      const map = { 'not-allowed': 'mic_denied', 'service-not-allowed': 'voice_browser_blocked', 'network': 'voice_browser_blocked', 'audio-capture': 'voice_no_mic', 'language-not-supported': 'voice_lang_unsupported' };
      if (e.error === 'no-speech') voiceDone(t('voice_no_speech'));
      else if (e.error === 'aborted') { }
      else voiceFail(map[e.error] || 'voice_browser_blocked');
    };
    rec.onend = () => {
      const said = (final || heard).trim();
      if (said) { voiceCommand(said); return; }
      if (failed || $('micSheet').hidden) return;
      // ended at once without any sound or error: the browser silently refused
      if (Date.now() - started < 1500) voiceFail('voice_browser_blocked'); else voiceDone(t('voice_no_speech'));
    };
    try { rec.start(); } catch (e) { voiceFail('voice_browser_blocked'); }
  }
  $('mic').onclick = startVoice;
  $('micCancel').onclick = cancelVoice;

  /* ---------------- location ---------------- */
  let lastFix = null;
  function locate(asStart, then) {
    if (!navigator.geolocation) { toast(t('no_geo')); return; }
    toast(t('finding_you'));
    navigator.geolocation.getCurrentPosition(p => {
      const ll = L.latLng(p.coords.latitude, p.coords.longitude); lastFix = ll;
      showMe(ll, p.coords.heading, p.coords.speed);
      // switch city automatically if the user is in another supported city
      const other = Object.keys(CITIES).find(k => { const b = CITIES[k].bbox; return ll.lat > b[0] && ll.lat < b[2] && ll.lng > b[1] && ll.lng < b[3]; });
      if (other && other !== opt.city) { switchCity(other).then(() => { if (asStart) setPoint('A', ll, t('my_location')); if (then) then(); }); return; }
      if (asStart) setPoint('A', ll, t('my_location'));
      if (then) then();
      if (!nav) map.setView(ll, Math.max(map.getZoom(), 15));
    }, () => toast(t('geo_denied')), { enableHighAccuracy: true, timeout: 10000 });
  }
  /* ---------------- live position: smooth movement, facing direction, rotating camera ---------------- */
  // me.mode outside navigation: off | follow (north up) | compass (map turns with you) | free (tracking, not following)
  const me = { target: null, disp: null, gpsHead: null, speed: 0, compass: null, head: null, mapRot: 0, mode: 'off' };
  map.createPane('meP'); map.getPane('meP').style.zIndex = 660;
  let meMarker = null, rafId = 0, lastFrame = 0, liveWatch = null, compassOn = false;
  const angLerp = (a, b, k) => { if (a == null) return b; const d = ((b - a) % 360 + 540) % 360 - 180; return (a + d * k + 360) % 360; };
  function showMe(ll, heading, speed) {
    me.target = L.latLng(ll); if (!me.disp) me.disp = me.target;
    if (heading != null && !isNaN(heading)) me.gpsHead = heading;
    if (speed != null && !isNaN(speed)) me.speed = speed;
    if (!meMarker) meMarker = L.marker(me.target, { icon: L.divIcon({ className: '', html: '<div class="me"><b class="cone"></b><i></i></div>', iconSize: [26, 26], iconAnchor: [13, 13] }), interactive: false, pane: 'meP' }).addTo(map);
    startLoop();
  }
  function hideMe() { if (meMarker) { map.removeLayer(meMarker); meMarker = null; } me.target = me.disp = null; me.head = null; startLoop(); }
  // phone compass: which way the person is looking
  function onOri(e) {
    let hd = null;
    if (typeof e.webkitCompassHeading === 'number') hd = e.webkitCompassHeading;
    else if (e.absolute && typeof e.alpha === 'number') hd = 360 - e.alpha;
    if (hd == null) return;
    const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
    me.compass = angLerp(me.compass, (hd + so + 720) % 360, 0.3);
    startLoop();
  }
  async function startCompass() {
    if (compassOn) return;
    try { if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === 'function' && (await DeviceOrientationEvent.requestPermission()) !== 'granted') return; } catch (e) { return; }
    addEventListener('deviceorientationabsolute', onOri, true); addEventListener('deviceorientation', onOri, true); compassOn = true;
  }
  // moving fast: GPS direction is steadier; standing or walking slowly: the compass shows where you face
  function facing() {
    if (me.speed > 2 && me.gpsHead != null) return me.gpsHead;
    if (me.compass != null) return me.compass;
    if (me.gpsHead != null) return me.gpsHead;
    if (nav && nav.routeHead != null) return nav.routeHead;
    return null;
  }
  const following = () => nav ? nav.follow : (me.mode === 'follow' || me.mode === 'compass');
  const rotating = () => (nav ? nav.follow && opt.rotate : me.mode === 'compass') && me.head != null;
  const tilting = () => !!nav && nav.follow && opt.tilt && !document.body.classList.contains('radar');
  function startLoop() { if (!rafId) { lastFrame = performance.now(); rafId = requestAnimationFrame(frame); } }
  function frame(now) {
    rafId = 0;
    const dt = Math.min(120, now - lastFrame); lastFrame = now;
    let busy = false;
    if (me.target) {
      const k = 1 - Math.exp(-dt / 450);
      const dLat = me.target.lat - me.disp.lat, dLng = me.target.lng - me.disp.lng;
      me.disp = L.latLng(me.disp.lat + dLat * k, me.disp.lng + dLng * k);
      busy = Math.abs(dLat) + Math.abs(dLng) > 2e-7;
      const f = facing();
      if (f != null) { const before = me.head; me.head = angLerp(me.head, f, 1 - Math.exp(-dt / 250)); busy = busy || before == null || Math.abs(((f - me.head) % 360 + 540) % 360 - 180) > 0.5; }
      meMarker && meMarker.setLatLng(me.disp);
    }
    const want = rotating() ? me.head : 0;
    const before = me.mapRot;
    me.mapRot = angLerp(me.mapRot, want, 1 - Math.exp(-dt / 320));
    if (Math.abs(((want - me.mapRot) % 360 + 540) % 360 - 180) > 0.3) busy = true; else me.mapRot = want;
    applyCamera();
    const el = meMarker && meMarker.getElement && meMarker.getElement(), d = el && el.querySelector('.me');
    if (d) { d.style.setProperty('--h', (me.head || 0) + 'deg'); d.classList.toggle('dir', me.head != null); }
    if (me.target && following() && !zoomingNow && pointers.size < 2) {
      const c = map.latLngToContainerPoint(me.disp), s = map.getSize();
      if (Math.abs(c.x - s.x / 2) > 0.5 || Math.abs(c.y - s.y / 2) > 0.5) map.setView(me.disp, map.getZoom(), { animate: false });
    }
    if (busy || (me.target && following() && rotating())) rafId = requestAnimationFrame(frame);
  }
  // zoom state: the camera waits while Leaflet animates a zoom or the user pinches
  let zoomingNow = false, zoomT = 0;
  const pointers = new Map();
  map.on('zoomstart', () => { zoomingNow = true; clearTimeout(zoomT); });
  map.on('zoomend', () => { clearTimeout(zoomT); zoomT = setTimeout(() => { zoomingNow = false; startLoop(); }, 60); });
  // while following, zooming (pinch, wheel, double-tap) keeps you in the middle instead of fighting the camera
  function zoomAround() {
    const c = following() ? 'center' : true;
    map.options.touchZoom = c; map.options.scrollWheelZoom = c; map.options.doubleClickZoom = c;
  }
  // heading-up rotation and 3D tilt: the map sits in an oversized square (#rot) that we turn with CSS
  const rotEl = $('rot'), wrapEl = $('mapwrap');
  let camState = '';
  function applyCamera() {
    const off0 = Math.min(Math.abs(me.mapRot), 360 - Math.abs(me.mapRot));
    const on = off0 > 0.05 || rotating() || tilting();
    const tilt = tilting();
    const state = (on ? 'r' : '') + (tilt ? 't' : '') + (document.body.classList.contains('radar') ? 'R' : '');
    zoomAround();
    if (state !== camState && !zoomingNow) {
      camState = state;
      document.body.classList.toggle('rotmap', on);
      document.body.classList.toggle('tilted', tilt);
      if (on) { const w = wrapEl.clientWidth, hh = wrapEl.clientHeight, dd = Math.ceil(Math.hypot(w, hh) * (tilt ? 2.1 : 1.05)); rotEl.style.width = rotEl.style.height = dd + 'px'; map.dragging.disable(); }
      else { rotEl.style.width = rotEl.style.height = ''; map.dragging.enable(); }
      map.invalidateSize({ pan: false });
      if (me.disp && following()) map.setView(me.disp, map.getZoom(), { animate: false });
    }
    rotEl.style.setProperty('--rot', (-me.mapRot) + 'deg');
    rotEl.style.setProperty('--tilt', tilt ? '40deg' : '0deg');
  }
  addEventListener('resize', () => { camState = ''; startLoop(); });
  // touching the map while it follows/rotates hands control back to the user
  wrapEl.addEventListener('pointerdown', e => {
    if (e.target.closest('button,.leaflet-control,.leaflet-popup')) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, moved: false });
  });
  wrapEl.addEventListener('pointermove', e => {
    const pt = pointers.get(e.pointerId); if (!pt || pointers.size > 1 || pt.moved) return;
    if (Math.hypot(e.clientX - pt.x, e.clientY - pt.y) < 12) return;
    pt.moved = true;
    if (nav && nav.follow) { nav.follow = false; $('navCenter').hidden = false; startLoop(); }
    else if (!nav && (me.mode === 'follow' || me.mode === 'compass')) { me.mode = 'free'; drawMeBtn(); startLoop(); }
  });
  const pointerUp = e => { pointers.delete(e.pointerId); if (!pointers.size) startLoop(); };
  wrapEl.addEventListener('pointerup', pointerUp); wrapEl.addEventListener('pointercancel', pointerUp); wrapEl.addEventListener('pointerleave', pointerUp);
  // ◎ button: off → follow me → compass → off
  function startLive() {
    if (liveWatch != null || !navigator.geolocation) return;
    liveWatch = navigator.geolocation.watchPosition(p => {
      if (nav) return;
      lastFix = L.latLng(p.coords.latitude, p.coords.longitude);
      showMe(lastFix, p.coords.heading, p.coords.speed);
    }, () => { toast(t('geo_denied')); stopLive(); }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }
  function stopLive() { if (liveWatch != null) navigator.geolocation.clearWatch(liveWatch); liveWatch = null; me.mode = 'off'; if (!nav) hideMe(); drawMeBtn(); }
  function drawMeBtn() { const b = $('me'); b.textContent = me.mode === 'compass' ? '🧭' : (me.mode === 'follow' ? '➤' : '◎'); b.classList.toggle('on', me.mode === 'follow' || me.mode === 'compass'); }
  function cycleMe() {
    if (me.mode === 'off' || me.mode === 'free') { me.mode = 'follow'; startLive(); startCompass(); toast(t('follow_on')); if (lastFix) map.setView(lastFix, Math.max(map.getZoom(), 16)); }
    else if (me.mode === 'follow') { me.mode = 'compass'; startCompass(); toast(me.compass == null && me.gpsHead == null ? t('compass_wait') : t('compass_on')); }
    else { stopLive(); toast(t('follow_off')); }
    drawMeBtn(); startLoop();
  }

  /* ---------------- navigation ---------------- */
  let nav = null, watchId = null, wakeLock = null;
  const ARROW = { left: { slight: '↖', turn: '↰', sharp: '↲', uturn: '↶' }, right: { slight: '↗', turn: '↱', sharp: '↳', uturn: '↷' } };
  function action(st) {
    if (st.type === 'arrive') return t('v_arrive_soon');
    const a = t('a_' + st.type + '_' + st.side) + (st.gali ? ' ' + t('into_gali') : '');
    return st.chowk ? t('at_chowk', { c: st.chowk, a }) : a;
  }
  function distText(m) { return m >= 1000 ? (m / 1000).toFixed(1) + ' km' : (m < 100 ? Math.round(m / 10) * 10 : Math.round(m / 50) * 50) + ' m'; }
  function speak(text) {
    if (!opt.voice || !('speechSynthesis' in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(text), want = I18N.voiceLang();
      const vs = speechSynthesis.getVoices(), v = vs.find(x => x.lang.replace('_', '-') === want) || vs.find(x => x.lang.startsWith(want.slice(0, 2))) || vs.find(x => x.lang === 'en-IN');
      if (v) u.voice = v; u.lang = v ? v.lang : want; u.rate = 1;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
    } catch (e) { }
  }
  function navEvents(r) {
    const ev = [];
    r.signalAt.forEach((k, i) => { const c = chowkAt(G.lat[r.path[k]], G.lon[r.path[k]], 80); ev.push({ at: r.cum[k], kind: 'light', sure: Z.clusters[r.signals[i]].kind === 'sure', chowk: c && c.n }); });
    for (const [la, lo] of camPoints()) { let bd = Infinity, at = 0; for (let k = 0; k < r.path.length; k++) { const d = Core.hav(la, lo, G.lat[r.path[k]], G.lon[r.path[k]]); if (d < bd) { bd = d; at = r.cum[k]; } } if (bd < 40) ev.push({ at, kind: 'cam' }); }
    for (const rep of reportsOnRoute(r)) if (['police', 'pothole', 'water', 'jam', 'block'].includes(rep.t)) ev.push({ at: rep.at, kind: 'rep', t: rep.t });
    if (opt.vehicle === 'car') for (const [k, w] of r.tightAt || []) ev.push({ at: r.cum[k], kind: 'tight', w });
    return ev.sort((a, b) => a.at - b.at);
  }
  function setNavRoute(r) {
    nav.r = r; nav.steps = Core.steps(G, r); nav.ev = navEvents(r); nav.k = 0; nav.off = 0;
    for (const st of nav.steps) if (st.type !== 'arrive') { const c = chowkAt(G.lat[r.path[st.k]], G.lon[r.path[st.k]], 70); if (c) st.chowk = c.n; }
    nav.said = new Set();
    routeLayer.clearLayers();
    const ll = r.path.map(i => [G.lat[i], G.lon[i]]);
    nav.line = drawLine(ll, MODES[nav.mode].color, true, routeLayer);
    for (const z of new Set(r.signals)) { const c = Z.clusters[z]; L.circleMarker([c.lat, c.lon], { radius: 8, color: '#fff', weight: 2, fillColor: c.kind === 'sure' ? '#e5383b' : '#f2a516', fillOpacity: 1, interactive: false }).addTo(routeLayer); }
  }
  async function startNav() {
    const r = results[sel]; if (!r) return;
    nav = { mode: sel, follow: true, startShort: results.short, startCur: r, lastReroute: 0 };
    setNavRoute(r);
    startCompass();
    if (liveWatch != null) { navigator.geolocation.clearWatch(liveWatch); liveWatch = null; }
    document.body.classList.add('navigating');
    setRadar(false);
    recordTrip(r);
    try { if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { }
    speak(t('v_start', { n: mins(r) }));
    drawNav(0, r.len);
    if (navigator.geolocation && !window.__grSim) watchId = navigator.geolocation.watchPosition(onPos, () => toast(t('geo_denied')), { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 });
    map.setView([G.lat[r.path[0]], G.lon[r.path[0]]], 17);
  }
  function stopNav(arrived) {
    if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null;
    try { wakeLock && wakeLock.release(); } catch (e) { } wakeLock = null;
    document.body.classList.remove('navigating');
    setRadar(false);
    nav = null; if (me.mode === 'off') hideMe(); else startLive(); startLoop();
    if (arrived) { toast(t('arrived')); drawSavings(); }
    if (A && B) go();
  }
  function onPos(p) {
    if (!nav) return;
    const la = p.coords.latitude, lo = p.coords.longitude, acc = p.coords.accuracy || 20;
    const ll = L.latLng(la, lo); lastFix = ll;
    const pr = Core.project(G, nav.r, la, lo, nav.k);
    { const rp = nav.r.path, k = Math.min(pr.k, rp.length - 2); nav.routeHead = (Core.bearing(G.lat[rp[k]], G.lon[rp[k]], G.lat[rp[k + 1]], G.lon[rp[k + 1]]) + 360) % 360; }
    showMe(ll, p.coords.heading, p.coords.speed);
    if (nav.follow && map.getZoom() < 16) map.setZoom(17, { animate: false });
    // off route → find a new route from here
    if (pr.off > 45 && acc < 60) nav.off++; else nav.off = 0;
    if ((nav.off >= 2 || pr.off > 90) && Date.now() - nav.lastReroute > 8000) {
      nav.lastReroute = Date.now();
      const s = Core.nearest(G, la, lo, Core.usable(G, routeOpts(nav.mode)));
      const r = s && Core.route(G, Z, s.i, results._dst, routeOpts(nav.mode));
      if (r) { speak(t('v_reroute')); setNavRoute(r); return onPos(p); }
    }
    nav.k = pr.k;
    const along = pr.along, left = nav.r.len - along;
    if (left < 25 || (B && Core.hav(la, lo, B.lat, B.lng) < 25)) { speak(t('v_arrive')); return stopNav(true); }
    // voice: next turn
    const st = nav.steps.find(s => s.at > along + 5);
    if (st && st.type !== 'arrive') {
      const d = st.at - along, id = 's' + st.k;
      if (d < 220 && d > 60 && !nav.said.has(id + 'far')) { nav.said.add(id + 'far'); speak(t('v_in', { d: distText(d), a: action(st) })); }
      else if (d <= 40 && !nav.said.has(id + 'now')) { nav.said.add(id + 'now'); nav.said.add(id + 'far'); speak(cap(action(st))); }
    }
    // voice: red lights, cameras, reports ahead
    for (const e of nav.ev) {
      const d = e.at - along, id = e.kind + Math.round(e.at);
      if (d < 0 || nav.said.has(id)) continue;
      const lim = e.kind === 'rep' ? 300 : 150;
      if (d < lim) { nav.said.add(id); speak(e.kind === 'light' ? (e.chowk ? t('v_light_at', { c: e.chowk }) : t('v_light')) : e.kind === 'cam' ? t('v_cam') : e.kind === 'tight' ? t('v_tight', { w: Math.round(e.w) }) : t('v_rep_' + e.t)); break; }
    }
    drawNav(along, left);
  }
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
  function drawNav(along, left) {
    const st = nav.steps.find(s => s.at > along + 5) || nav.steps[nav.steps.length - 1];
    const d = Math.max(0, st.at - along);
    const nextSt = nav.steps[nav.steps.indexOf(st) + 1];
    $('navArrow').textContent = st.type === 'arrive' ? '🏁' : ARROW[st.side][st.type];
    $('navDist').textContent = distText(d);
    $('navText').textContent = cap(action(st));
    $('navThen').textContent = nextSt && nextSt.at - st.at < 150 ? t('then', { a: action(nextSt) }) : '';
    const lightsLeft = nav.r.signalAt.filter(k => nav.r.cum[k] > along).length;
    const secLeft = nav.r.time * (left / Math.max(1, nav.r.len)) + lightsLeft * lightWait();
    const eta = new Date(Date.now() + secLeft * 1000).toLocaleTimeString(I18N.locale(), { hour: 'numeric', minute: '2-digit' });
    $('navLeft').textContent = `${Math.max(1, Math.round(secLeft / 60))} ${t('min')} · ${distText(left)} · ${t('lights_short', { n: lightsLeft })} · ${t('arrive_at', { t: eta })}`;
    $('navMute').textContent = opt.voice ? '🔊' : '🔇';
  }
  map.on('dragstart', () => { if (nav) { nav.follow = false; $('navCenter').hidden = false; startLoop(); } });
  // test hook: drive along the current nav route
  window.GR = {
    simulate(speedKmh = 30, everyMs = 1000) {
      window.__grSim = true; if (!nav) startNav();
      let along = 0; const r0 = nav.r;
      const tick = () => {
        if (!nav) return; const r = nav.r; along += speedKmh / 3.6 * everyMs / 1000;
        let k = 0; while (k < r.path.length - 1 && r.cum[k + 1] < along) k++;
        const i = r.path[k], j = r.path[Math.min(k + 1, r.path.length - 1)], f = Math.min(1, (along - r.cum[k]) / Math.max(1, r.cum[k + 1] - r.cum[k] || 1));
        onPos({ coords: { latitude: G.lat[i] + (G.lat[j] - G.lat[i]) * f, longitude: G.lon[i] + (G.lon[j] - G.lon[i]) * f, accuracy: 8 } });
        if (nav && r === r0) setTimeout(tick, everyMs);
      };
      tick();
    },
    state: () => ({ nav: !!nav, text: $('navText').textContent, dist: $('navDist').textContent, left: $('navLeft').textContent, said: nav ? [...nav.said] : [] })
  };

  /* ---------------- chowks ---------------- */
  let CH = [], chowkNames = store.get('gr-chowk-names', {});
  const chKey = c => c.la.toFixed(5) + ',' + c.lo.toFixed(5);
  async function loadChowks(name) {
    CH = [];
    try { CH = (await getJSON(`data/v3/${name}-chowks.json`)).c.map(x => ({ n: x[0], la: x[1], lo: x[2], kind: x[3], v: x[4] })); } catch (e) { }
    for (const c of CH) { const own = chowkNames[chKey(c)]; if (own) c.n = own; }
    // chowks are searchable like any place
    for (const c of CH) if (c.n) { const key = norm(c.n); PL.unshift({ n: c.n, la: c.la, lo: c.lo, ty: 'chowk', st: '', key, tok: key.split(' '), sk: key.split(' ').map(skel) }); }
  }
  // nearest named chowk to a point (for voice directions and the route summary)
  function chowkAt(la, lo, within = 60) {
    let best = null, bd = within;
    for (const c of CH) { if (!c.n || Math.abs(c.la - la) > 0.002 || Math.abs(c.lo - lo) > 0.002) continue; const d = Core.hav(la, lo, c.la, c.lo); if (d < bd) { bd = d; best = c; } }
    return best;
  }
  function chowksOnRoute(r) {
    const out = [];
    for (let k = 0; k < r.path.length; k++) {
      const c = chowkAt(G.lat[r.path[k]], G.lon[r.path[k]], 45);
      if (c && !out.some(x => x === c || x.n === c.n)) out.push(c);
    }
    return out;
  }
  map.createPane('chowks'); map.getPane('chowks').style.zIndex = 620;
  const chowkLayer = L.layerGroup().addTo(map);
  function drawChowks() {
    chowkLayer.clearLayers();
    if (!opt.chowks || !CH.length) return;
    const z = map.getZoom(); if (z < 13) return;
    const b = map.getBounds().pad(0.1);
    for (const c of CH) {
      if (!b.contains([c.la, c.lo])) continue;
      if (!c.n && z < 15) continue;
      const big = !!c.n && (z >= 15 || c.v >= 6);
      const html = c.n ? (big ? `<div class="chowk"><i></i>${esc(c.n.replace(/ (Chowk|चौक|ਚੌਂਕ|ਚੌਕ)$/, ''))}</div>` : `<div class="chowk dot"><i></i></div>`) : `<div class="chowk dot un"><i></i></div>`;
      const m = L.marker([c.la, c.lo], { icon: L.divIcon({ className: '', html, iconSize: null, iconAnchor: [8, 8] }), pane: 'chowks', keyboard: false }).addTo(chowkLayer);
      m.on('click', e => { L.DomEvent.stop(e); chowkPopup(c, m); });
    }
  }
  function chowkPopup(c, m) {
    const div = document.createElement('div'); div.className = 'pop';
    div.innerHTML = `<b>${esc(c.n || t('unnamed_chowk'))}</b><small>${esc(t(c.kind === 'r' ? 'roundabout' : 'ty_chowk'))}</small>
      <button data-a="to">${esc(t('route_here'))}</button><button data-a="from">${esc(t('start_here'))}</button><button data-a="name">${esc(t(c.n ? 'rename_chowk' : 'name_chowk'))}</button>`;
    div.onclick = e => {
      const a = e.target.dataset.a; if (!a) return;
      if (a === 'to') { map.closePopup(); setPoint('B', [c.la, c.lo], c.n || t('ty_chowk')); }
      if (a === 'from') { map.closePopup(); setPoint('A', [c.la, c.lo], c.n || t('ty_chowk')); }
      if (a === 'name') {
        div.innerHTML = `<b>${esc(t('name_chowk'))}</b><input maxlength="40" value="${esc(c.n || '')}" placeholder="${esc(t('chowk_name_ph'))}"><button data-a="save">${esc(t('save'))}</button>`;
        const inp = div.querySelector('input'); inp.focus();
        div.querySelector('[data-a=save]').onclick = ev => {
          ev.stopPropagation(); let v = inp.value.trim(); if (!v) return;
          if (!/(chowk|chauk|चौक|ਚੌਂਕ|ਚੌਕ)$/i.test(v)) v += ' Chowk';
          c.n = v; chowkNames[chKey(c)] = v; store.set('gr-chowk-names', chowkNames);
          const key = norm(v); PL.unshift({ n: v, la: c.la, lo: c.lo, ty: 'chowk', st: '', key, tok: key.split(' '), sk: key.split(' ').map(skel) });
          map.closePopup(); drawChowks(); toast(t('chowk_saved', { n: v }));
        };
      }
    };
    L.popup({ offset: [0, -4] }).setLatLng([c.la, c.lo]).setContent(div).openOn(map);
  }
  // redraw once after the map settles (moveend also fires after every zoom)
  // at most every ~0.4 s, always once more at the end; skipped while a zoom is animating
  const settle = (fn, ms = 80) => { let tm = 0, last = 0; const run = () => { if (zoomingNow) { tm = setTimeout(run, 120); return; } last = Date.now(); tm = 0; fn(); };
    return () => { if (tm) return; const wait = Math.max(ms, 400 - (Date.now() - last)); tm = setTimeout(run, wait); }; };
  map.on('moveend', settle(drawChowks));

  /* ---------------- street width layer ---------------- */
  map.createPane('widths'); map.getPane('widths').style.zIndex = 350; // under routes and markers
  const widthRenderer = L.canvas({ pane: 'widths' }), widthLayer = L.layerGroup().addTo(map);
  function drawWidths() {
    widthLayer.clearLayers();
    if (!opt.widths || !G || !G.widths) return;
    if (map.getZoom() < 15) { if (opt.widths) hint(t('zoom_for_widths')); return; }
    hint('');
    const b = map.getBounds().pad(0.1); let n = 0;
    for (let wi = 0; wi < G.ways.length && n < 4000; wi++) {
      const dm = G.widths[wi]; if (!dm) continue;
      const ns = G.ways[wi].slice(2);
      if (!ns.some(i => b.contains([G.lat[i], G.lon[i]]))) continue;
      const m = dm / 10, col = m < 3.5 ? '#e5383b' : m < 5 ? '#f2a516' : '#1f9d55';
      L.polyline(ns.map(i => [G.lat[i], G.lon[i]]), { color: col, weight: 4, opacity: .7, renderer: widthRenderer, pane: 'widths' }).bindTooltip(t('width_tip', { w: m.toFixed(1) })).addTo(widthLayer);
      n++;
    }
  }
  map.on('moveend', settle(drawWidths, 120));

  /* ---------------- savings ---------------- */
  function weekKey(d = new Date()) { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x.toISOString().slice(0, 10); }
  let lastTripKey = '';
  function recordTrip(cur) {
    const key = location.hash; if (key === lastTripKey) return; lastTripKey = key;
    const sh = results.short || cur, s = store.get('gr-savings', {}), w = weekKey();
    const e = s[w] || { lights: 0, mins: 0, trips: 0 };
    e.lights += Math.max(0, sh.signals.length - cur.signals.length);
    e.mins += Math.max(0, mins(sh) - mins(cur)); e.trips++;
    s[w] = e; for (const k of Object.keys(s).sort().slice(0, -12)) delete s[k];
    store.set('gr-savings', s); drawSavings();
  }
  function drawSavings() {
    const s = store.get('gr-savings', {}), e = s[weekKey()], all = Object.values(s).reduce((a, x) => ({ lights: a.lights + x.lights, mins: a.mins + x.mins, trips: a.trips + x.trips }), { lights: 0, mins: 0, trips: 0 });
    $('savings').innerHTML = e && e.trips ? `<b>${esc(t('this_week'))}</b> ${esc(t('savings_line', { l: e.lights, m: e.mins, tr: e.trips }))}${all.trips > e.trips ? `<small>${esc(t('all_time', { l: all.lights, m: all.mins }))}</small>` : ''}` : `<small>${esc(t('savings_empty'))}</small>`;
  }

  /* ---------------- idle state ---------------- */
  function idle() {
    if (!G) return;
    const sure = Z.clusters.filter(c => c.kind === 'sure').length, lk = Z.clusters.length - sure;
    status(t('mapped', { s: sure, l: lk, c: G.cams.length + localReports.filter(r => r.t === 'camera').length }) + ' ' + dataNote);
    if (!A) hint(isPhone() ? t('hint_start_phone') : t('hint_start'));
  }

  /* ---------------- map taps ---------------- */
  map.on('click', e => {
    if (document.body.classList.contains('rotmap')) return; // taps on a turned map land in the wrong place
    if (reportPick) { const ty = reportPick; reportPick = null; hint(''); postReport(ty, e.latlng.lat, e.latlng.lng); return; }
    if (editMode) { toggleSignal(e.latlng); return; }
    if (nav) return;
    if (!A) setPoint('A', e.latlng); else setPoint('B', e.latlng);
  });
  function toggleSignal(ll) {
    if (!G) return;
    const near = Z.clusters.findIndex(c => Core.hav(c.lat, c.lon, ll.lat, ll.lng) < 40);
    if (near >= 0) {
      const c = Z.clusters[near];
      fixes.add = fixes.add.filter(([a, o]) => Core.hav(a, o, c.lat, c.lon) >= 45);
      fixes.del.push([+c.lat.toFixed(6), +c.lon.toFixed(6)]); toast(t('light_removed'));
    } else {
      const n = Core.nearest(G, ll.lat, ll.lng, true);
      if (!n || n.m > 40) { toast(t('tap_closer')); return; }
      fixes.del = fixes.del.filter(([a, o]) => Core.hav(a, o, G.lat[n.i], G.lon[n.i]) >= 45);
      fixes.add.push([+G.lat[n.i].toFixed(6), +G.lon[n.i].toFixed(6)]); toast(t('light_added'));
    }
    store.set('gr-fixes', fixes); applySignals(); go();
  }

  /* ---------------- report sheet ---------------- */
  function openReport() {
    const sh = $('repSheet');
    sh.querySelector('.grid').innerHTML = Object.keys(REPORT).map(k => `<button data-t="${k}"><span>${REPORT[k].icon}</span>${esc(t('rep_' + k))}</button>`).join('');
    sh.hidden = false;
    for (const b of sh.querySelectorAll('.grid button')) b.onclick = () => {
      const ty = b.dataset.t; sh.hidden = true;
      const fix = nav && lastFix ? lastFix : null;
      if (fix) { postReport(ty, fix.lat, fix.lng); return; }
      const where = $('repWhere'); where.hidden = false;
      $('repHere').onclick = () => { where.hidden = true; if (!navigator.geolocation) return toast(t('no_geo')); navigator.geolocation.getCurrentPosition(p => postReport(ty, p.coords.latitude, p.coords.longitude), () => toast(t('geo_denied')), { enableHighAccuracy: true, timeout: 10000 }); };
      $('repMap').onclick = () => { where.hidden = true; reportPick = ty; hint(t('tap_report_spot')); if (isPhone()) $('panel').classList.add('min'); };
      $('repCancel2').onclick = () => { where.hidden = true; };
    };
  }

  function setRadar(on) {
    document.body.classList.toggle('radar', !!on); camState = '';
    setTimeout(() => { map.invalidateSize(); if (nav && lastFix) map.setView(lastFix, on ? 17 : map.getZoom()); }, 60);
  }
  $('radarBtn').onclick = () => setRadar(!document.body.classList.contains('radar'));

  /* ---------------- theme, language, city ---------------- */
  function applyTheme() {
    // the game look always uses the dark interface unless the user picked Light
    const game = gameOn();
    const theme = opt.theme === 'auto' && game ? 'dark' : opt.theme;
    const dark = theme === 'dark' || (theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = theme === 'auto' ? '' : theme;
    document.body.classList.toggle('darkmap', dark && !game);
    document.querySelector('meta[name=theme-color]').content = game ? '#11181c' : '#1f9d55';
  }
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  function applyLang() {
    I18N.set(opt.lang);
    for (const e of document.querySelectorAll('[data-i18n]')) e.textContent = t(e.dataset.i18n);
    for (const e of document.querySelectorAll('[data-i18n-ph]')) e.placeholder = t(e.dataset.i18nPh);
    for (const e of document.querySelectorAll('[data-i18n-al]')) e.setAttribute('aria-label', t(e.dataset.i18nAl));
    drawOpts(); drawSavings(); drawPlacesList();
    if (G) { drawReports(); if (results.best) render(); else idle(); }
  }
  async function switchCity(c) {
    if (c === opt.city && G) return;
    opt.city = c; saveOpt(); $('citySel').value = c;
    A = B = null; if (mA) map.removeLayer(mA); if (mB) map.removeLayer(mB); mA = mB = null; $('qA').value = $('qB').value = '';
    map.setView(CITIES[c].center, 13); drawQuick();
    await loadCity(c);
  }

  /* ---------------- controls ---------------- */
  function drawOpts() {
    for (const b of $('vehSeg').children) b.classList.toggle('on', b.dataset.v === opt.vehicle);
    $('trWrap').hidden = !motor();
    $('trSel').options[0].textContent = t('auto_tr', { t: t('tr_' + autoTraffic()) }); $('trSel').value = opt.traffic;
    $('citySel').value = opt.city; $('langSel').value = opt.lang; $('themeSel').value = opt.theme; $('lookSel').value = opt.look;
    $('widths').checked = opt.widths; $('chowksOn').checked = opt.chowks; $('rotateOn').checked = opt.rotate; $('tiltOn').checked = opt.tilt;
    $('voice').checked = opt.voice; $('likely').checked = opt.likely; $('wait').value = opt.wait; $('wv').textContent = opt.wait + ' s';
  }
  $('vehSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; opt.vehicle = b.dataset.v; saveOpt(); drawOpts(); go(); };
  $('trSel').onchange = () => { opt.traffic = $('trSel').value; saveOpt(); go(); };
  $('citySel').onchange = () => switchCity($('citySel').value);
  $('langSel').onchange = () => { opt.lang = $('langSel').value; saveOpt(); applyLang(); };
  $('themeSel').onchange = () => { opt.theme = $('themeSel').value; saveOpt(); applyTheme(); };
  $('lookSel').onchange = () => { opt.look = $('lookSel').value; saveOpt(); setBase(); applyTheme(); if (results.best) render(); drawChowks(); if (opt.look === 'game' && !gameOn()) toast(t('game_unsupported')); };
  $('rotateOn').onchange = () => { opt.rotate = $('rotateOn').checked; saveOpt(); startLoop(); };
  $('tiltOn').onchange = () => { opt.tilt = $('tiltOn').checked; saveOpt(); camState = ''; startLoop(); };
  $('chowksOn').onchange = () => { opt.chowks = $('chowksOn').checked; saveOpt(); drawChowks(); };
  $('widths').onchange = () => { opt.widths = $('widths').checked; saveOpt(); if (opt.widths && !(G && G.widths)) toast(t('widths_none')); if (opt.widths && map.getZoom() < 15) map.setZoom(15); drawWidths(); };
  $('voice').onchange = () => { opt.voice = $('voice').checked; saveOpt(); if (opt.voice) speak(t('v_test')); };
  $('likely').onchange = () => { opt.likely = $('likely').checked; saveOpt(); if (G) { applySignals(); idle(); go(); } };
  $('wait').oninput = () => { $('wv').textContent = $('wait').value + ' s'; };
  $('wait').onchange = () => { opt.wait = +$('wait').value; saveOpt(); go(); };
  $('edit').onclick = () => { editMode = !editMode; $('edit').classList.toggle('on', editMode); $('edit').textContent = t(editMode ? 'done_fixing' : 'fix_lights'); if (G) drawSignals(); hint(editMode ? t('hint_fix') : ''); if (editMode && isPhone()) $('panel').classList.add('min'); };
  $('copyfix').onclick = async () => { const s = JSON.stringify({ fixes, reports: localReports.map(({ t: ty, la, lo }) => ({ t: ty, la, lo })), chowks: chowkNames }); try { await navigator.clipboard.writeText(s); toast(t('fixes_copied')); } catch (e) { status(s); } };
  $('swap').onclick = () => { if (!A || !B) return; const a = A, qa = $('qA').value, qb = $('qB').value; setPoint('A', B, qb, true); setPoint('B', a, qa, true); go(); };
  $('clear').onclick = () => { A = B = null; if (mA) map.removeLayer(mA); if (mB) map.removeLayer(mB); mA = mB = null; $('qA').value = $('qB').value = ''; drawQuick(); go(); };
  $('area').onclick = () => { const b = map.getBounds(), s = [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()]; if ((s[2] - s[0]) * (s[3] - s[1]) > 0.04) { toast(t('zoom_in_more')); return; } loadCity(opt.city, s); };
  $('handle').onclick = () => $('panel').classList.toggle('min');
  $('locA').onclick = () => locate(true);
  $('me').onclick = cycleMe;
  $('repBtn').onclick = openReport;
  $('repCancel').onclick = () => { $('repSheet').hidden = true; };
  $('navStop').onclick = () => stopNav(false);
  $('navMute').onclick = () => { opt.voice = !opt.voice; saveOpt(); $('navMute').textContent = opt.voice ? '🔊' : '🔇'; };
  $('navCenter').onclick = () => { if (nav) { nav.follow = true; $('navCenter').hidden = true; if (me.disp) map.setView(me.disp, 17); startLoop(); } };
  $('navReport').onclick = openReport;
  document.addEventListener('visibilitychange', async () => { if (nav && document.visibilityState === 'visible' && 'wakeLock' in navigator) try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { } });
  setInterval(() => { if (G) loadReports(); }, 120000);

  let deferred = null;
  addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('install').hidden = false; });
  $('install').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('install').hidden = true; };
  if ('serviceWorker' in navigator && !window.__grTest) navigator.serviceWorker.register('sw.js').catch(() => { });
  if ('speechSynthesis' in window) speechSynthesis.getVoices();

  /* ---------------- start ---------------- */
  setupSearch('A'); setupSearch('B');
  const hp = new URLSearchParams(location.hash.slice(1)); if (CITIES[hp.get('c')]) opt.city = hp.get('c');
  applyTheme(); applyLang(); drawQuick();
  loadCity(opt.city).then(() => { if (G && !fromHash() && !A) idle(); if (A && B) go(); });
  window.GR.setTrip = (a, b, an, bn) => { setPoint('A', a, an, true); setPoint('B', b, bn); };
  window.GR.select = id => { sel = id; render(); };
  window.GR.ready = () => !!G && !!Z;
  window.GR.voice = voiceCommand;
  window.GR.mid = f => { const r = results[sel]; const i = r.path[Math.floor(r.path.length * (f || 0.5))]; return [G.lat[i], G.lon[i]]; };
  window.GR.report = (ty, la, lo) => postReport(ty, la, lo);
  window.GR.pos = (la, lo) => onPos({ coords: { latitude: la, longitude: lo, accuracy: 10 } });
  window.GR.navPath = () => nav ? nav.r.path.length + ':' + Math.round(nav.r.len) + ':' + G.lat[nav.r.path[0]].toFixed(4) + ',' + G.lon[nav.r.path[0]].toFixed(4) : '';
})();
