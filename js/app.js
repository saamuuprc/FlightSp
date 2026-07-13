/* FlightSpy León — radar ADS-B en tiempo real, zona de 50 km alrededor del aeropuerto de León (LELN) */
'use strict';

// ---------- Configuración ----------
const AIRPORT = { lat: 42.5890, lon: -5.6556, code: 'LELN', name: 'Aeropuerto de León' };
const ZONE_KM = 50;            // solo nos interesan los aviones dentro de este radio
const FETCH_NM = 30;           // radio de descarga (30 nm ≈ 55,6 km, con margen)
const NM_TO_KM = 1.852;

const SOURCES = [
  { name: 'adsb.lol',       url: (la, lo, r) => `https://api.adsb.lol/v2/point/${la}/${lo}/${r}` },
  { name: 'airplanes.live', url: (la, lo, r) => `https://api.airplanes.live/v2/point/${la}/${lo}/${r}` },
  { name: 'adsb.fi',        url: (la, lo, r) => `https://opendata.adsb.fi/api/v2/lat/${la}/lon/${lo}/dist/${r}` },
];

const DEFAULTS = {
  interval: 5,
  alertEnabled: false,
  alertMil: true,
  alertEmg: true,
  alertNear: true,
  alertNearKm: 15,
  alertSound: true,
  trails: true,
  labels: true,
};

let settings = loadSettings();
function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('fs_settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() { localStorage.setItem('fs_settings', JSON.stringify(settings)); }

// ---------- Estado ----------
const state = {
  aircraft: new Map(),     // hex -> últimos datos recibidos
  markers: new Map(),      // hex -> { m, svg, label, color, heli }
  trails: new Map(),       // hex -> { line, pts }
  anim: new Map(),         // hex -> { lat, lon, gs, track, t0 } base para animación
  selected: null,
  sourceIdx: 0,
  listFilter: 'all',
  histFilter: 'all',
  alerted: new Map(),
  routeCache: new Map(),
  photoCache: new Map(),
  infoCache: new Map(),    // hex -> html con fabricante/operador (adsbdb)
  acInfoCache: new Map(),  // hex -> respuesta cruda de adsbdb
  timer: null,
};

// ---------- Historial de la zona (persistente 3 días) ----------
const LOG_KEY = 'fs_log';
const LOG_MAX = 500;
const LOG_KEEP_MS = 3 * 24 * 3600 * 1000;
const logActive = new Map(); // hex -> entrada abierta
let zoneLog = loadLog();
let logDirty = false;

function loadLog() {
  try {
    const arr = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    for (const e of arr) if (!e.tOut) e.tOut = e.tLast || e.tIn; // cerrar pasadas de sesiones anteriores
    return arr.filter(e => Date.now() - e.tIn < LOG_KEEP_MS);
  } catch { return []; }
}
function saveLog() {
  zoneLog = zoneLog.filter(e => Date.now() - e.tIn < LOG_KEEP_MS);
  if (zoneLog.length > LOG_MAX) zoneLog = zoneLog.slice(-LOG_MAX);
  try { localStorage.setItem(LOG_KEY, JSON.stringify(zoneLog)); } catch {}
  logDirty = false;
}
setInterval(() => { if (logDirty) saveLog(); }, 30000);

function logEnter(ac) {
  const e = {
    hex: ac.hex, cs: callsignOf(ac), reg: ac.r || '', type: ac.t || '',
    mil: isMil(ac), emg: isEmg(ac),
    tIn: Date.now(), tOut: null, tLast: Date.now(),
    minDist: +ac.distKm.toFixed(1),
  };
  zoneLog.push(e);
  logActive.set(ac.hex, e);
  saveLog();
}
function logUpdate(ac) {
  const e = logActive.get(ac.hex);
  if (!e) return;
  e.tLast = Date.now();
  if (ac.distKm < e.minDist) e.minDist = +ac.distKm.toFixed(1);
  if (!e.reg && ac.r) e.reg = ac.r;
  if (!e.type && ac.t) e.type = ac.t;
  if ((ac.flight || '').trim()) e.cs = (ac.flight || '').trim();
  if (isMil(ac)) e.mil = true;
  if (isEmg(ac)) e.emg = true;
  logDirty = true;
}
function logExit(hex) {
  const e = logActive.get(hex);
  if (e) { e.tOut = Date.now(); logActive.delete(hex); saveLog(); }
}

// ---------- Mapa ----------
const map = L.map('map', { zoomControl: true, attributionControl: true, zoomAnimation: true })
  .setView([AIRPORT.lat, AIRPORT.lon], 9);

L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO',
  subdomains: 'abcd', maxZoom: 19,
}).addTo(map);

// Aeropuerto con baliza pulsante
L.marker([AIRPORT.lat, AIRPORT.lon], {
  icon: L.divIcon({
    className: 'apt-icon',
    html: '<div class="apt-pulse"></div><div class="apt-core"></div><div class="apt-tag">LELN</div>',
    iconSize: [16, 16], iconAnchor: [8, 8],
  }),
  interactive: false, keyboard: false,
}).addTo(map);

// Anillos de distancia: 10 / 25 / 50 km
for (const [km, style] of [
  [10, { opacity: .18, dashArray: '2 6' }],
  [25, { opacity: .22, dashArray: '4 8' }],
  [50, { opacity: .5, weight: 1.5 }],
]) {
  L.circle([AIRPORT.lat, AIRPORT.lon], {
    radius: km * 1000, color: '#4fc3f7', weight: 1, fill: false, interactive: false, ...style,
  }).addTo(map);
}
// Etiqueta del anillo exterior
L.marker([AIRPORT.lat + 50 / 111.32, AIRPORT.lon], {
  icon: L.divIcon({ className: 'ring-label', html: '50 km', iconSize: [40, 14], iconAnchor: [20, 7] }),
  interactive: false, keyboard: false,
}).addTo(map);

// Círculo de radio de alerta
let nearCircle = L.circle([AIRPORT.lat, AIRPORT.lon], {
  radius: settings.alertNearKm * 1000, color: '#ffb300', weight: 1, opacity: .3, fill: false, dashArray: '3 6', interactive: false,
}).addTo(map);

// ---------- Utilidades ----------
function haversineKm(la1, lo1, la2, lo2) {
  const R = 6371, rad = Math.PI / 180;
  const dLa = (la2 - la1) * rad, dLo = (lo2 - lo1) * rad;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * rad) * Math.cos(la2 * rad) * Math.sin(dLo / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function altColor(alt) {
  if (alt === 'ground' || alt == null) return '#9e9e9e';
  const t = Math.max(0, Math.min(1, alt / 42000));
  const hue = 30 + t * 240; // ámbar (bajo) → violeta (crucero)
  return `hsl(${hue}, 90%, 60%)`;
}

function fmtAlt(a) { return a === 'ground' ? 'En tierra' : a != null ? `${a.toLocaleString('es')} ft` : '—'; }
function fmtNum(v, dec = 0) { return v != null ? Number(v).toFixed(dec) : '—'; }

// Detección militar por tres vías: bandera de la base de datos ADS-B,
// prefijo de indicativo militar, y operador registrado (vía adsbdb, asíncrono)
const MIL_PREFIXES = new Set([
  'AME', // Ejército del Aire y del Espacio (España)
  'GAF', 'FAF', 'IAM', 'RRR', 'RFR', 'ASY', 'CFC', 'RCH', 'CNV', 'PAT',
  'BAF', 'NAF', 'PLF', 'HUF', 'CEF', 'SUI', 'NOW', 'MMF', 'HAF', 'ROF',
]);
const milOverride = new Set(); // hex confirmados militares por su operador registrado
const MIL_OWNER_RE = /air force|army|navy|ministry of defen[cs]e|military|ej[ée]rcito|armada espa|fuerza a[ée]rea|guardia civil|luftwaffe|arm[ée]e de l'air|nato/i;

function isMil(ac) {
  if (((ac.dbFlags || 0) & 1) === 1) return true;
  if (milOverride.has(ac.hex)) return true;
  const m = (ac.flight || '').trim().match(/^([A-Z]{3})\d/);
  return !!(m && MIL_PREFIXES.has(m[1]));
}
function isEmg(ac) {
  return ['7500', '7600', '7700'].includes(ac.squawk) || (ac.emergency && ac.emergency !== 'none');
}
function callsignOf(ac) { return (ac.flight || '').trim() || ac.r || ac.hex.toUpperCase(); }

const CATEGORIES = {
  A1: 'Avión ligero (<7 t)', A2: 'Avión mediano (7–34 t)', A3: 'Avión grande (34–136 t)',
  A4: 'Estela turbulenta alta (B757)', A5: 'Avión pesado (>136 t)', A6: 'Alta performance (>5g)',
  A7: 'Helicóptero', B1: 'Planeador', B2: 'Aerostato', B4: 'Ultraligero', B6: 'Dron (UAV)',
  B7: 'Vehículo espacial', C1: 'Vehículo de emergencia', C2: 'Vehículo de servicio',
};

// ---------- Icono de avión ----------
const PLANE_PATH = 'M12 1.5c.6 0 1.1.6 1.3 1.6l.6 6.6 7.6 4.6c.3.2.5.5.5.9v1.3l-8-2.6-.5 5.6 2.3 1.7c.2.1.3.3.3.6v1.1L12 21.6l-4.1 1.3v-1.1c0-.3.1-.5.3-.6l2.3-1.7-.5-5.6-8 2.6v-1.3c0-.4.2-.7.5-.9l7.6-4.6.6-6.6c.2-1 .7-1.6 1.3-1.6z';
const HELI_SHAPE = '<circle cx="12" cy="12" r="4" fill="COL"/><rect x="11" y="2" width="2" height="20" rx="1" fill="COL"/><rect x="2" y="11" width="20" height="2" rx="1" fill="COL"/>';

function planeSVG(color, size = 26, rot = 0, heli = false) {
  const shape = heli ? HELI_SHAPE.replaceAll('COL', color) : `<path fill="${color}" d="${PLANE_PATH}"/>`;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" style="transform:rotate(${rot}deg)">${shape}</svg>`;
}

function colorOf(ac) { return isEmg(ac) ? '#ffb300' : isMil(ac) ? '#ff5252' : altColor(ac.alt_baro); }

// Crea el marcador una sola vez; después solo se actualizan rotación/color/etiqueta (fluidez)
function ensureMarker(ac) {
  let ref = state.markers.get(ac.hex);
  if (!ref) {
    const icon = L.divIcon({
      className: 'plane-icon',
      html: `<div class="pw">${planeSVG(colorOf(ac), 26, ac.track || 0, ac.category === 'A7')}<div class="plane-label"></div></div>`,
      iconSize: [26, 26], iconAnchor: [13, 13],
    });
    const m = L.marker([ac.lat, ac.lon], { icon });
    m.on('click', () => selectAircraft(ac.hex));
    m.addTo(map);
    const el = m.getElement();
    ref = {
      m,
      wrap: el.querySelector('.pw'),
      svg: el.querySelector('svg'),
      label: el.querySelector('.plane-label'),
      color: colorOf(ac),
      heli: ac.category === 'A7',
    };
    state.markers.set(ac.hex, ref);
  }
  // Actualizaciones ligeras sin recrear el DOM
  const color = colorOf(ac);
  if (color !== ref.color || (ac.category === 'A7') !== ref.heli) {
    ref.color = color; ref.heli = ac.category === 'A7';
    ref.svg.innerHTML = ref.heli ? HELI_SHAPE.replaceAll('COL', color) : `<path fill="${color}" d="${PLANE_PATH}"/>`;
  }
  ref.svg.style.transform = `rotate(${ac.track || 0}deg)`;
  const cs = settings.labels ? (ac.flight || '').trim() : '';
  if (ref.label.textContent !== cs) ref.label.textContent = cs;
  ref.label.style.display = cs ? '' : 'none';
  ref.wrap.classList.toggle('emg', isEmg(ac));
  ref.wrap.classList.toggle('sel', state.selected === ac.hex);
  return ref;
}

// ---------- Animación continua (interpolación por velocidad y rumbo reales) ----------
function animFrame() {
  const now = Date.now();
  for (const [hex, base] of state.anim) {
    const ref = state.markers.get(hex);
    if (!ref) continue;
    if (base.gs == null || base.gs < 40 || base.track == null || base.ground) continue; // en tierra o lento: sin proyección
    let dt = (now - base.t0) / 1000;
    if (dt < 0) dt = 0;
    if (dt > 60) dt = 60; // si la fuente se congela, no extrapolar sin límite
    const dKm = base.gs * NM_TO_KM / 3600 * dt;
    const b = base.track * Math.PI / 180;
    const lat = base.lat + (dKm * Math.cos(b)) / 111.32;
    const lon = base.lon + (dKm * Math.sin(b)) / (111.32 * Math.cos(base.lat * Math.PI / 180));
    ref.m.setLatLng([lat, lon]);
  }
  requestAnimationFrame(animFrame);
}
requestAnimationFrame(animFrame);

// ---------- Obtención de datos ----------
async function fetchAircraft() {
  for (let i = 0; i < SOURCES.length; i++) {
    const idx = (state.sourceIdx + i) % SOURCES.length;
    const src = SOURCES[idx];
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(src.url(AIRPORT.lat, AIRPORT.lon, FETCH_NM), { signal: ctrl.signal });
      clearTimeout(to);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const list = data.ac || data.aircraft || [];
      state.sourceIdx = idx;
      document.getElementById('source-info').textContent = `Fuente actual: ${src.name} ✓ (con relevo automático a ${SOURCES.filter((_, j) => j !== idx).map(s => s.name).join(' y ')})`;
      return list;
    } catch (e) { /* probar siguiente fuente */ }
  }
  return null;
}

function update(list) {
  const seen = new Set();
  let milCount = 0;
  let closest = null, fastest = null, highest = null;

  for (const ac of list) {
    if (ac.lat == null || ac.lon == null) continue;
    ac.hex = (ac.hex || '').toLowerCase();
    if (!ac.hex) continue;
    ac.distKm = haversineKm(AIRPORT.lat, AIRPORT.lon, ac.lat, ac.lon);
    if (ac.distKm > ZONE_KM) continue; // fuera de la zona de 50 km: no nos interesa
    seen.add(ac.hex);
    const isNew = !state.aircraft.has(ac.hex);
    state.aircraft.set(ac.hex, ac);
    if (isNew) logEnter(ac); else logUpdate(ac);

    if (isMil(ac)) milCount++;
    if (!closest || ac.distKm < closest.distKm) closest = ac;
    if (ac.gs != null && (!fastest || ac.gs > fastest.gs)) fastest = ac;
    if (typeof ac.alt_baro === 'number' && (!highest || ac.alt_baro > highest.alt_baro)) highest = ac;

    ensureMarker(ac);

    // Base de animación: posición real + edad del dato
    state.anim.set(ac.hex, {
      lat: ac.lat, lon: ac.lon,
      gs: ac.gs, track: ac.track,
      ground: ac.alt_baro === 'ground',
      t0: Date.now() - (ac.seen_pos != null ? ac.seen_pos * 1000 : 0),
    });

    // Estela (con posiciones reales recibidas)
    if (settings.trails) {
      let t = state.trails.get(ac.hex);
      if (!t) {
        t = { pts: [], line: L.polyline([], { color: altColor(ac.alt_baro), weight: 2, opacity: .5, interactive: false }).addTo(map) };
        state.trails.set(ac.hex, t);
      }
      const last = t.pts[t.pts.length - 1];
      if (!last || last[0] !== ac.lat || last[1] !== ac.lon) {
        t.pts.push([ac.lat, ac.lon]);
        if (t.pts.length > 120) t.pts.shift();
        t.line.setLatLngs(t.pts);
        t.line.setStyle({ color: altColor(ac.alt_baro) });
      }
    }

    checkAlerts(ac);
  }

  // Eliminar aviones que han salido de la zona
  for (const hex of [...state.markers.keys()]) {
    if (!seen.has(hex)) {
      map.removeLayer(state.markers.get(hex).m);
      state.markers.delete(hex);
      state.anim.delete(hex);
      const t = state.trails.get(hex);
      if (t) { map.removeLayer(t.line); state.trails.delete(hex); }
      state.aircraft.delete(hex);
      logExit(hex);
      if (state.selected === hex) closeSheet('detail');
    }
  }

  // Interfaz
  document.getElementById('ac-count').textContent = `${seen.size} ✈`;
  document.getElementById('stat-mil').textContent = milCount;
  document.getElementById('stat-closest').textContent = closest ? `${callsignOf(closest)} · ${closest.distKm.toFixed(1)} km` : '—';
  document.getElementById('stat-fastest').textContent = fastest ? `${callsignOf(fastest)} · ${Math.round(fastest.gs)} kt` : '—';
  document.getElementById('stat-highest').textContent = highest ? `${callsignOf(highest)} · ${highest.alt_baro.toLocaleString('es')} ft` : '—';
  state.statTargets = { closest: closest?.hex, fastest: fastest?.hex, highest: highest?.hex };

  if (state.selected && state.aircraft.has(state.selected)) renderDetail(state.selected, false);
  if (!document.getElementById('list').classList.contains('hidden')) renderList();
  if (!document.getElementById('history').classList.contains('hidden')) renderHistory();
}

async function tick() {
  const list = await fetchAircraft();
  const dot = document.getElementById('status-dot');
  if (list) {
    dot.className = 'dot ok';
    update(list);
  } else {
    dot.className = 'dot err';
    document.getElementById('source-info').textContent = 'Fuente actual: sin conexión con ninguna fuente ✗';
  }
}

function startPolling() {
  if (state.timer) clearInterval(state.timer);
  tick();
  state.timer = setInterval(tick, settings.interval * 1000);
}

// Pausar cuando la app no está visible (ahorra batería y datos)
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (state.timer) { clearInterval(state.timer); state.timer = null; } }
  else startPolling();
});

// ---------- Alertas ----------
function canAlert(hex, kind) {
  const key = `${hex}:${kind}`;
  const last = state.alerted.get(key) || 0;
  if (Date.now() - last < 15 * 60 * 1000) return false;
  state.alerted.set(key, Date.now());
  return true;
}

function checkAlerts(ac) {
  if (!settings.alertEnabled) return;
  const cs = callsignOf(ac);
  if (settings.alertEmg && isEmg(ac) && canAlert(ac.hex, 'emg')) {
    notify(`🚨 EMERGENCIA: ${cs}`, `Squawk ${ac.squawk || ac.emergency} · ${fmtAlt(ac.alt_baro)} · a ${ac.distKm.toFixed(1)} km`, 'emg', ac.hex);
  }
  if (settings.alertMil && isMil(ac) && canAlert(ac.hex, 'mil')) {
    notify(`🪖 Militar: ${cs}`, `${ac.t || 'Tipo desconocido'} · ${fmtAlt(ac.alt_baro)} · a ${ac.distKm.toFixed(1)} km`, 'mil', ac.hex);
  }
  if (settings.alertNear && ac.distKm <= settings.alertNearKm && ac.alt_baro !== 'ground' && canAlert(ac.hex, 'near')) {
    notify(`✈️ ${cs} en la zona`, `A ${ac.distKm.toFixed(1)} km del aeropuerto · ${fmtAlt(ac.alt_baro)} · ${ac.t || ''}`, '', ac.hex);
  }
}

let audioCtx = null;
function beep() {
  if (!settings.alertSound) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.connect(g); g.connect(audioCtx.destination);
    o.frequency.value = 880; g.gain.setValueAtTime(.15, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(.001, audioCtx.currentTime + .4);
    o.start(); o.stop(audioCtx.currentTime + .4);
  } catch {}
}

function notify(title, body, cls, hex) {
  const t = document.createElement('div');
  t.className = `toast ${cls}`;
  t.innerHTML = `<b>${title}</b><br>${body}`;
  t.onclick = () => { selectAircraft(hex); t.remove(); };
  document.getElementById('toasts').appendChild(t);
  setTimeout(() => t.remove(), 8000);
  beep();
  if (navigator.vibrate) navigator.vibrate([100, 50, 100]);

  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      if (navigator.serviceWorker?.controller) {
        navigator.serviceWorker.ready.then(reg =>
          reg.showNotification(title, { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: hex }));
      } else {
        new Notification(title, { body, icon: 'icons/icon-192.png', tag: hex });
      }
    } catch {}
  }
}

// ---------- Panel de detalle ----------
function selectAircraft(hex) {
  const prev = state.selected;
  state.selected = hex;
  if (prev && state.aircraft.has(prev)) ensureMarker(state.aircraft.get(prev));
  closeSheet('list'); closeSheet('settings'); closeSheet('history');
  renderDetail(hex, true);
  openSheet('detail');
  const ac = state.aircraft.get(hex);
  if (ac) { ensureMarker(ac); map.panTo([ac.lat, ac.lon], { animate: true }); }
}

async function renderDetail(hex, full) {
  const ac = state.aircraft.get(hex);
  if (!ac) return;
  const el = document.getElementById('detail-content');
  const cs = callsignOf(ac);
  const emg = isEmg(ac), mil = isMil(ac);
  const vr = ac.baro_rate ?? ac.geom_rate;
  const vrIcon = vr > 200 ? '↗' : vr < -200 ? '↘' : '→';

  el.innerHTML = `
    <div id="photo-slot"></div>
    <div class="ac-head">
      <span class="ac-callsign">${cs}</span>
      <span class="ac-reg">${ac.r || ''}</span>
      ${mil ? '<span class="badge mil">🪖 Militar</span>' : '<span class="badge civ">✈️ Civil</span>'}
      ${emg ? `<span class="badge emg">Emergencia ${ac.squawk || ''}</span>` : ''}
    </div>
    <div class="ac-type">${ac.desc || ac.t || 'Tipo desconocido'}${ac.year ? ` · ${ac.year}` : ''}${ac.ownOp ? ` · ${ac.ownOp}` : ''}</div>
    <div id="acinfo-slot"></div>
    <div id="route-slot"></div>
    <div class="grid">
      <div class="cell"><div class="k">Altitud</div><div class="v">${fmtAlt(ac.alt_baro)}</div></div>
      <div class="cell"><div class="k">Velocidad</div><div class="v">${fmtNum(ac.gs)} <span class="u">kt</span></div><div class="u">${ac.gs != null ? Math.round(ac.gs * 1.852) + ' km/h' : ''}</div></div>
      <div class="cell"><div class="k">V. vertical ${vrIcon}</div><div class="v">${fmtNum(vr)} <span class="u">ft/min</span></div></div>
      <div class="cell"><div class="k">Rumbo</div><div class="v">${fmtNum(ac.track)}°</div></div>
      <div class="cell"><div class="k">Dist. a LELN</div><div class="v">${ac.distKm.toFixed(1)} <span class="u">km</span></div></div>
      <div class="cell"><div class="k">Squawk</div><div class="v">${ac.squawk || '—'}</div></div>
      <div class="cell"><div class="k">ICAO hex</div><div class="v">${ac.hex.toUpperCase()}</div></div>
      <div class="cell"><div class="k">Categoría</div><div class="v" style="font-size:11px">${CATEGORIES[ac.category] || ac.category || '—'}</div></div>
      <div class="cell"><div class="k">Señal</div><div class="v">${ac.rssi != null ? ac.rssi + ' dB' : '—'}</div><div class="u">${ac.messages ? ac.messages.toLocaleString('es') + ' msgs' : ''}</div></div>
    </div>`;

  if (full) {
    loadPhoto(ac);
    loadAcInfo(ac);
    loadRoute(ac);
  } else {
    const photo = state.photoCache.get(ac.hex);
    if (photo) document.getElementById('photo-slot').innerHTML = photo;
    const info = state.infoCache.get(ac.hex);
    if (info) document.getElementById('acinfo-slot').innerHTML = info;
    const route = state.routeCache.get((ac.flight || '').trim());
    if (route) document.getElementById('route-slot').innerHTML = route;
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Info de aeronave de adsbdb (fabricante, operador, foto alternativa) — clave para militares
async function acInfo(hex) {
  if (state.acInfoCache.has(hex)) return state.acInfoCache.get(hex);
  let a = null;
  try { a = (await fetchJson(`https://api.adsbdb.com/v0/aircraft/${hex}`)).response?.aircraft || null; } catch {}
  state.acInfoCache.set(hex, a);
  return a;
}

function psPhotoHtml(p, ac) {
  return `<img class="ac-photo" src="${p.thumbnail_large?.src || p.thumbnail?.src}" alt="Foto de ${ac.r || ac.hex}">
    <div class="ac-photo-credit">📷 ${p.photographer || ''} · <a href="${p.link}" target="_blank" rel="noopener">planespotters.net</a></div>`;
}

// Foto con triple búsqueda: planespotters por hex → por matrícula → foto de adsbdb
async function loadPhoto(ac) {
  const slot = () => document.getElementById('photo-slot');
  if (state.photoCache.has(ac.hex)) { if (slot()) slot().innerHTML = state.photoCache.get(ac.hex); return; }
  let html = '';
  try {
    const p = (await fetchJson(`https://api.planespotters.net/pub/photos/hex/${ac.hex}`)).photos?.[0];
    if (p) html = psPhotoHtml(p, ac);
  } catch {}
  if (!html && ac.r) {
    try {
      const p = (await fetchJson(`https://api.planespotters.net/pub/photos/reg/${encodeURIComponent(ac.r)}`)).photos?.[0];
      if (p) html = psPhotoHtml(p, ac);
    } catch {}
  }
  if (!html) {
    const a = await acInfo(ac.hex);
    if (a?.url_photo) {
      html = `<img class="ac-photo" src="${a.url_photo}" alt="Foto de ${ac.r || ac.hex}">
        <div class="ac-photo-credit">📷 vía <a href="https://adsbdb.com" target="_blank" rel="noopener">adsbdb.com</a></div>`;
    }
  }
  if (!html) {
    // Sin foto pública en ninguna base de datos: silueta + enlace de búsqueda
    const q = ac.r || ac.hex.toUpperCase();
    const searchUrl = ac.r
      ? `https://www.jetphotos.com/registration/${encodeURIComponent(ac.r)}`
      : `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(q + ' aircraft')}`;
    html = `<div class="ac-nophoto">
        ${planeSVG('#2e4266', 64, 45, ac.category === 'A7')}
        <div>Sin foto pública de esta aeronave</div>
        <a href="${searchUrl}" target="_blank" rel="noopener">🔍 Buscar fotos de ${q}</a>
      </div>`;
  }
  state.photoCache.set(ac.hex, html);
  if (state.selected === ac.hex && slot()) slot().innerHTML = html;
}

// Línea extra con fabricante, modelo completo y operador registrado
async function loadAcInfo(ac) {
  const slot = () => document.getElementById('acinfo-slot');
  if (state.infoCache.has(ac.hex)) { if (slot()) slot().innerHTML = state.infoCache.get(ac.hex); return; }
  const a = await acInfo(ac.hex);
  let html = '';
  if (a) {
    // Si el operador registrado es una fuerza armada, marcarlo militar en todo el sistema
    if (a.registered_owner && MIL_OWNER_RE.test(a.registered_owner) && !milOverride.has(ac.hex)) {
      milOverride.add(ac.hex);
      const live = state.aircraft.get(ac.hex);
      if (live) { ensureMarker(live); logUpdate(live); }
    }
    const bits = [];
    const full = [a.manufacturer, a.type].filter(Boolean).join(' ');
    if (full) bits.push(full);
    if (a.registered_owner) bits.push(`${isMil(ac) ? '🛡️' : '🏢'} ${a.registered_owner}`);
    if (a.registered_owner_country_name) bits.push(a.registered_owner_country_name);
    if (bits.length) html = `<div class="ac-type">${bits.join(' · ')}</div>`;
  }
  state.infoCache.set(ac.hex, html);
  if (state.selected === ac.hex && slot()) slot().innerHTML = html;
}

async function loadRoute(ac) {
  const cs = (ac.flight || '').trim();
  if (!cs) return;
  const slot = () => document.getElementById('route-slot');
  if (state.routeCache.has(cs)) { if (slot()) slot().innerHTML = state.routeCache.get(cs); return; }
  try {
    const res = await fetch(`https://api.adsbdb.com/v0/callsign/${cs}`);
    const data = await res.json();
    const fr = data.response?.flightroute;
    if (fr?.origin && fr?.destination) {
      const html = `<div class="route">
        <div class="apt"><div class="apt-code">${fr.origin.iata_code || fr.origin.icao_code}</div><div class="apt-name">${fr.origin.municipality || fr.origin.name}</div></div>
        <div class="arrow">✈ ——→</div>
        <div class="apt"><div class="apt-code">${fr.destination.iata_code || fr.destination.icao_code}</div><div class="apt-name">${fr.destination.municipality || fr.destination.name}</div></div>
      </div>
      ${fr.airline ? `<div class="ac-type">🏢 ${fr.airline.name}${fr.airline.country ? ' · ' + fr.airline.country : ''}</div>` : ''}`;
      state.routeCache.set(cs, html);
      if (state.selected === ac.hex && slot()) slot().innerHTML = html;
    } else state.routeCache.set(cs, '');
  } catch {}
}

// ---------- Lista ----------
function renderList() {
  const el = document.getElementById('list-content');
  let arr = [...state.aircraft.values()].sort((a, b) => a.distKm - b.distKm);
  if (state.listFilter === 'mil') arr = arr.filter(isMil);
  if (state.listFilter === 'emg') arr = arr.filter(isEmg);
  if (state.listFilter === 'low') arr = arr.filter(a => a.alt_baro === 'ground' || a.alt_baro < 10000);

  el.innerHTML = arr.length ? arr.map(ac => {
    const color = colorOf(ac);
    return `<div class="list-row" data-hex="${ac.hex}">
      <div class="list-plane">${planeSVG(color, 22, ac.track || 0, ac.category === 'A7')}</div>
      <div class="list-main">
        <div class="list-cs">${callsignOf(ac)} ${isMil(ac) ? '🪖' : ''}${isEmg(ac) ? '🚨' : ''}</div>
        <div class="list-sub">${ac.t || '—'} · ${ac.r || ac.hex.toUpperCase()}</div>
      </div>
      <div class="list-right">
        <div class="list-alt">${fmtAlt(ac.alt_baro)}</div>
        <div class="list-dist">${ac.distKm.toFixed(1)} km · ${ac.gs != null ? Math.round(ac.gs) + ' kt' : '—'}</div>
      </div>
    </div>`;
  }).join('') : '<p class="hint">Ningún avión en la zona de 50 km con este filtro ahora mismo. La zona es tranquila — cuando pase algo, aquí estará. 📡</p>';

  el.querySelectorAll('.list-row').forEach(row =>
    row.addEventListener('click', () => selectAircraft(row.dataset.hex)));
}

// ---------- Ficha de archivo (avión del historial que ya se fue) ----------
function renderHistDetail(e) {
  state.selected = e.hex; // para que foto/info/ruta rellenen los huecos al llegar
  closeSheet('list'); closeSheet('settings'); closeSheet('history');
  const el = document.getElementById('detail-content');
  const durMin = Math.max(1, Math.round(((e.tOut || e.tLast) - e.tIn) / 60000));
  const mil = e.mil || milOverride.has(e.hex);
  el.innerHTML = `
    <div id="photo-slot"></div>
    <div class="ac-head">
      <span class="ac-callsign">${e.cs}</span>
      <span class="ac-reg">${e.reg || ''}</span>
      ${mil ? '<span class="badge mil">🪖 Militar</span>' : '<span class="badge civ">✈️ Civil</span>'}
      ${e.emg ? '<span class="badge emg">Tuvo emergencia</span>' : ''}
    </div>
    <div class="ac-type">${e.type || 'Tipo desconocido'} · pasó por la zona ${dayLabel(e.tIn).toLowerCase()}</div>
    <div id="acinfo-slot"></div>
    <div id="route-slot"></div>
    <div class="grid">
      <div class="cell"><div class="k">Entró en zona</div><div class="v">${hhmm(e.tIn)}</div></div>
      <div class="cell"><div class="k">Salió</div><div class="v">${e.tOut ? hhmm(e.tOut) : '—'}</div></div>
      <div class="cell"><div class="k">Tiempo en zona</div><div class="v">${durMin} <span class="u">min</span></div></div>
      <div class="cell"><div class="k">Dist. mínima</div><div class="v">${e.minDist} <span class="u">km</span></div></div>
      <div class="cell"><div class="k">ICAO hex</div><div class="v">${e.hex.toUpperCase()}</div></div>
      <div class="cell"><div class="k">Día</div><div class="v" style="font-size:12px">${new Date(e.tIn).toLocaleDateString('es', { day: 'numeric', month: 'short' })}</div></div>
    </div>`;
  openSheet('detail');
  // Reutilizar toda la maquinaria de foto/operador/ruta con un objeto mínimo
  const ghost = { hex: e.hex, r: e.reg, flight: e.cs, dbFlags: mil ? 1 : 0, category: '' };
  loadPhoto(ghost);
  loadAcInfo(ghost);
  loadRoute(ghost);
}

// ---------- Historial (interfaz) ----------
function hhmm(t) { return new Date(t).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' }); }
function dayLabel(t) {
  const d = new Date(t), today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Hoy';
  if (d.toDateString() === yesterday.toDateString()) return 'Ayer';
  return d.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
}

function renderHistory() {
  const el = document.getElementById('history-content');
  let arr = [...zoneLog].sort((a, b) => b.tIn - a.tIn);
  if (state.histFilter === 'mil') arr = arr.filter(e => e.mil);
  if (state.histFilter === 'civ') arr = arr.filter(e => !e.mil);

  if (!arr.length) {
    el.innerHTML = '<p class="hint">Aún no hay registros con este filtro. En cuanto algo cruce la zona de 50 km, quedará apuntado aquí con su hora. 📋</p>';
    return;
  }

  let html = '', lastDay = '';
  arr.forEach((e, i) => {
    const day = dayLabel(e.tIn);
    if (day !== lastDay) { html += `<div class="day-head">${day}</div>`; lastDay = day; }
    const active = logActive.get(e.hex) === e;
    const range = active ? `${hhmm(e.tIn)} → <b class="inzone">en zona</b>` : `${hhmm(e.tIn)} → ${hhmm(e.tOut)}`;
    html += `<div class="list-row hist-row ${active ? 'active' : ''}" data-i="${i}">
      <div class="hist-dot" style="background:${e.emg ? '#ffb300' : e.mil ? '#ff5252' : '#4fc3f7'}"></div>
      <div class="list-main">
        <div class="list-cs">${e.cs} ${e.mil ? '🪖' : ''}${e.emg ? '🚨' : ''}</div>
        <div class="list-sub">${[e.type, e.reg].filter(Boolean).join(' · ') || e.hex.toUpperCase()}</div>
      </div>
      <div class="list-right">
        <div class="hist-time">${range}</div>
        <div class="list-dist">mín. ${e.minDist} km</div>
      </div>
    </div>`;
  });
  el.innerHTML = html;
  el.querySelectorAll('.hist-row').forEach(row =>
    row.addEventListener('click', () => {
      const e = arr[Number(row.dataset.i)];
      if (!e) return;
      if (logActive.get(e.hex) === e) selectAircraft(e.hex); // sigue en zona: al mapa
      else renderHistDetail(e);                              // ya se fue: ficha de archivo
    }));
}

document.querySelectorAll('#history .list-filters .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('#history .list-filters .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.histFilter = chip.dataset.hfilter;
    renderHistory();
  });
});

// ---------- Paneles ----------
function openSheet(id) { document.getElementById(id).classList.remove('hidden'); }
function closeSheet(id) {
  document.getElementById(id).classList.add('hidden');
  if (id === 'detail') {
    const prev = state.selected;
    state.selected = null;
    if (prev && state.aircraft.has(prev)) ensureMarker(state.aircraft.get(prev));
  }
}

document.getElementById('detail-close').onclick = () => closeSheet('detail');
document.getElementById('list-close').onclick = () => closeSheet('list');
document.getElementById('settings-close').onclick = () => closeSheet('settings');
document.getElementById('history-close').onclick = () => closeSheet('history');
document.getElementById('btn-list').onclick = () => { closeSheet('detail'); closeSheet('settings'); closeSheet('history'); renderList(); openSheet('list'); };
document.getElementById('btn-settings').onclick = () => { closeSheet('detail'); closeSheet('list'); closeSheet('history'); openSheet('settings'); };
document.getElementById('btn-history').onclick = () => { closeSheet('detail'); closeSheet('list'); closeSheet('settings'); renderHistory(); openSheet('history'); };

// Estadísticas clicables: tocar "Más cercano/rápido/alto" abre ese avión
for (const [statId, key] of [['stat-closest', 'closest'], ['stat-fastest', 'fastest'], ['stat-highest', 'highest']]) {
  document.getElementById(statId).parentElement.addEventListener('click', () => {
    const hex = state.statTargets?.[key];
    if (hex && state.aircraft.has(hex)) selectAircraft(hex);
  });
}
// "Militares" abre la lista ya filtrada a militares
document.getElementById('stat-mil').parentElement.addEventListener('click', () => {
  closeSheet('detail'); closeSheet('settings'); closeSheet('history');
  document.querySelectorAll('#list .list-filters .chip').forEach(c =>
    c.classList.toggle('active', c.dataset.filter === 'mil'));
  state.listFilter = 'mil';
  renderList();
  openSheet('list');
});
// El contador de aviones de arriba abre la lista completa
document.getElementById('ac-count').addEventListener('click', () => document.getElementById('btn-list').click());

document.querySelectorAll('#list .list-filters .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.list-filters .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.listFilter = chip.dataset.filter;
    renderList();
  });
});

// ---------- Controles de ajustes ----------
function bindRange(id, key, labelId, onChange) {
  const input = document.getElementById(id);
  input.value = settings[key];
  const label = document.getElementById(labelId);
  const upd = () => { label.textContent = input.value; };
  upd();
  input.addEventListener('input', () => { settings[key] = Number(input.value); upd(); saveSettings(); if (onChange) onChange(); });
}
function bindCheck(id, key, onChange) {
  const input = document.getElementById(id);
  input.checked = settings[key];
  input.addEventListener('change', () => { settings[key] = input.checked; saveSettings(); if (onChange) onChange(); });
}

bindRange('set-interval', 'interval', 'interval-val', startPolling);
bindRange('alert-near-km', 'alertNearKm', 'near-km-val', () => nearCircle.setRadius(settings.alertNearKm * 1000));
nearCircle.setRadius(settings.alertNearKm * 1000);

bindCheck('alert-enabled', 'alertEnabled', async () => {
  if (settings.alertEnabled && 'Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission();
  }
});
bindCheck('alert-mil', 'alertMil');
bindCheck('alert-emg', 'alertEmg');
bindCheck('alert-near', 'alertNear');
bindCheck('alert-sound', 'alertSound');
bindCheck('set-trails', 'trails', () => {
  if (!settings.trails) {
    for (const t of state.trails.values()) map.removeLayer(t.line);
    state.trails.clear();
  }
});
bindCheck('set-labels', 'labels', () => {
  for (const ac of state.aircraft.values()) ensureMarker(ac);
});

// Recalcular tamaño del mapa cuando el layout cambia (carga, rotación, barra del navegador)
window.addEventListener('load', () => setTimeout(() => map.invalidateSize(), 150));
window.addEventListener('resize', () => map.invalidateSize());
window.addEventListener('orientationchange', () => setTimeout(() => map.invalidateSize(), 300));

// ---------- Service worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').then(reg => {
      // Al publicar una versión nueva, recargar una vez para estrenarla al momento
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'activated' && navigator.serviceWorker.controller) location.reload();
        });
      });
    }).catch(() => {});
  });
}

// ---------- Arranque ----------
startPolling();
