// app_metrics.js — live metrics dock + MQTT + primary sensor + primary room + Day Playback integration

const METRICS = (() => {
  /* ---------- DOM ---------- */
  const el = {
    dock:    document.getElementById('metricsDock'),
    toggle:  document.getElementById('toggleMetrics'),
    updated: document.getElementById('mxUpdated'),
    tempVal: document.getElementById('mTempVal'),
    tempDot: document.getElementById('mTempDot'),
    humVal:  document.getElementById('mHumVal'),
    humDot:  document.getElementById('mHumDot'),
    tvocVal: document.getElementById('mTvocVal'),
    tvocDot: document.getElementById('mTvocDot'),
    eco2Val: document.getElementById('mEco2Val'),
    eco2Dot: document.getElementById('mEco2Dot'),
    occVal:  document.getElementById('mOccVal'),
    occDot:  document.getElementById('mOccDot'),
  };

  /* ---------- Live occupancy (room) ---------- */
  // Stores: roomName -> { count:number, ts:number(ms) }
  const latestOccByRoom = new Map();

  // LocalStorage key + default primary room (yours)
  const KEY_PRIMARY_ROOM = 'primary_room_name';
  const DEFAULT_PRIMARY_ROOM = 'WWH015';

  // Optional mapping from dbId -> room name (fill as needed)
  // If you later want to set primary room from a model selection, populate this.
  const DBID_TO_ROOM = new Map([
    [2348, 'WWH015'],
    // [2396, 'WWH016'],
  ]);

  // Consider occupancy "stale" after 6 hours with no message
  const OCC_CLEAR_AFTER_MS = 6 * 60 * 60 * 1000; // 6h

  let primaryRoomName = null;
  try {
    primaryRoomName = localStorage.getItem(KEY_PRIMARY_ROOM) || DEFAULT_PRIMARY_ROOM;
  } catch {
    primaryRoomName = DEFAULT_PRIMARY_ROOM;
  }

  function getRoomByDbId(dbId) {
    return DBID_TO_ROOM.get(Number(dbId)) || null;
  }
  function setPrimaryRoomByDbId(dbId) {
    const room = getRoomByDbId(dbId);
    if (!room) { console.warn('No room mapping for dbId', dbId); return false; }
    primaryRoomName = room;
    try { localStorage.setItem(KEY_PRIMARY_ROOM, room); } catch {}
    setUpdatedFromMs(Date.now());
    renderDock();
    return true;
  }
  function setPrimaryRoomByName(room) {
    if (!room || typeof room !== 'string') return false;
    primaryRoomName = room;
    try { localStorage.setItem(KEY_PRIMARY_ROOM, room); } catch {}
    setUpdatedFromMs(Date.now());
    renderDock();
    return true;
  }

  /* ---------- UI helpers ---------- */
  function setValDot(valEl, dotEl, text, cls = '') {
    valEl.textContent = text;
    valEl.className = 'value' + (cls ? ' ' + cls : '');
    dotEl.className = 'dot'   + (cls ? ' ' + cls : '');
  }

  function formatFullStamp(ms) {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const day = d.getDate();
    const ord = (n) => {
      const j = n % 10, k = n % 100;
      if (j === 1 && k !== 11) return n + 'st';
      if (j === 2 && k !== 12) return n + 'nd';
      if (j === 3 && k !== 13) return n + 'rd';
      return n + 'th';
    };
    const monthNames = [
      'January','February','March','April','May','June',
      'July','August','September','October','November','December'
    ];
    const month = monthNames[d.getMonth()];
    const year = d.getFullYear();
    return `${hh}:${mm} ${ord(day)} ${month}, ${year}`;
  }

  function setUpdatedFromMs(ms) {
    const label = ms ? `Last updated at ${formatFullStamp(ms)}` : 'Last updated at —';
    el.updated.textContent = label;
  }

  function formatPeople(n) {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n} ${n === 1 ? 'person' : 'people'}`;
}

  /* ---------- Thresholds & classify ---------- */
  const THRESHOLDS = {
    temp_f:   { cool: 0,     good: [68, 77], warn: [77, 82],  bad: [82,  999] },
    rh_pct:   {              good: [30, 60], warn: [60, 70],  bad: [70,  999] },
    tvoc_ppb: {              good: [0,  400], warn: [400,1000], bad:[1000,99999] },
    eco2_ppm: {              good: [400,1000], warn:[1000,2000], bad:[2000,99999] },
    occ:      {              good: [0,    15], warn: [16,   30],  bad:[31,  999] },
  };

  function classify(metric, val) {
    const t = THRESHOLDS[metric];
    if (!t || typeof val !== 'number') return '';
    if (t.cool && val < t.good[0]) return 'cool';
    if (val >= t.good[0] && val <= t.good[1]) return 'good';
    if (val > t.warn[0] && val <= t.warn[1]) return 'warn';
    if (val > t.bad[0]) return 'bad';
    return '';
  }

  /* ---------- Dock toggle ---------- */
  if (el.toggle && el.dock) {
    el.toggle.addEventListener('click', () => {
      const compact = el.dock.classList.toggle('compact');
      el.toggle.textContent = compact ? 'Show' : 'Hide';
      el.toggle.setAttribute('aria-expanded', String(!compact));
    });
  }

  /* ---------- dbId <-> sensor device mapping ---------- */
  const DBID_TO_DEVICE = new Map([
    [2350, 'dtn-e41358088304'],    
    // add more: [dbid, 'device-id'],
  ]);

  const DEFAULT_PRIMARY_DBID = 2350;

  let primaryDeviceId = null;
  try {
    const cached = localStorage.getItem('primary_sensor_device');
    if (cached) primaryDeviceId = cached;
  } catch {}
  if (!primaryDeviceId) {
    const def = DBID_TO_DEVICE.get(DEFAULT_PRIMARY_DBID);
    if (def) {
      primaryDeviceId = def;
      try { localStorage.setItem('primary_sensor_device', def); } catch {}
    }
  }

  function getDeviceByDbId(dbId) {
    return DBID_TO_DEVICE.get(Number(dbId)) || null;
  }
  function setPrimaryByDbId(dbId) {
    const dev = getDeviceByDbId(dbId);
    if (!dev) { console.warn('No device mapping for dbId', dbId); return false; }
    primaryDeviceId = dev;
    try { localStorage.setItem('primary_sensor_device', dev); } catch {}
    setUpdatedFromMs(Date.now());
    renderDock();
    return true;
  }

  /* ---------- Live state + MQTT ---------- */
  let client = null;
  const latestByDevice = new Map(); // deviceId -> env metrics

  function extractMetrics(payloadObj) {
    return {
      temp_f:   (payloadObj.temp_f   != null) ? Number(payloadObj.temp_f)   : null,
      rh_pct:   (payloadObj.rh_pct   != null) ? Number(payloadObj.rh_pct)   : null,
      tvoc_ppb: (payloadObj.tvoc_ppb != null) ? Number(payloadObj.tvoc_ppb) : null,
      eco2_ppm: (payloadObj.eco2_ppm != null) ? Number(payloadObj.eco2_ppm) : null,
      // occ remains optional for sensor snapshots
    };
  }

  function nowMs() { return Date.now(); }

  function currentOccupancyForPrimaryRoom() {
    if (!primaryRoomName) return { val: null, ts: null };
    const row = latestOccByRoom.get(primaryRoomName);
    if (!row) return { val: null, ts: null };
    const age = nowMs() - (row.ts || 0);
    if (age > OCC_CLEAR_AFTER_MS) return { val: null, ts: row.ts }; // stale → clear to "—"
    return { val: (typeof row.count === 'number' ? row.count : null), ts: row.ts };
  }

  function renderDock() {
    const dev = primaryDeviceId;
    const s = dev ? latestByDevice.get(dev) : null;

    const t   = (s && typeof s.temp_f   === 'number') ? s.temp_f   : null;
    const rh  = (s && typeof s.rh_pct   === 'number') ? s.rh_pct   : null;
    const tv  = (s && typeof s.tvoc_ppb === 'number') ? s.tvoc_ppb : null;
    const c2  = (s && typeof s.eco2_ppm === 'number') ? s.eco2_ppm : null;

    // Occupancy: prefer live room stream; fallback to sensor occ if present
    const occLive = currentOccupancyForPrimaryRoom();
    let occVal = occLive.val;
    if (occVal == null && s && typeof s.occ === 'number') occVal = s.occ;

    setValDot(el.tempVal, el.tempDot, t  != null ? `${t.toFixed(1)} °F` : '—', classify('temp_f',  t));
    setValDot(el.humVal,  el.humDot,  rh != null ? `${rh.toFixed(1)} %` : '—', classify('rh_pct',  rh));
    setValDot(el.tvocVal, el.tvocDot, tv != null ? `${Math.round(tv)} ppb` : '—', classify('tvoc_ppb', tv));
    setValDot(el.eco2Val, el.eco2Dot, c2 != null ? `${Math.round(c2)} ppm` : '—', classify('eco2_ppm', c2));
    setValDot(el.occVal, el.occDot, formatPeople(occVal), classify('occ', occVal));
  }

  function scheduleRender(tsMs = null) {
    renderDock();
    setUpdatedFromMs(tsMs || Date.now());
  }

  function deviceFromTopic(topic) {
    const parts = String(topic).split('/');
    const idx = parts.indexOf('dt-lab');
    if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    return parts[2] || null;
  }

  function toMs(x) {
    const n = typeof x === 'string' ? parseInt(x, 10) : x;
    if (!Number.isFinite(n)) return Date.now();
    return n >= 1e12 ? n : n * 1000; // seconds → ms
  }

  async function bootMqtt() {
    const res = await fetch('/api/mqtt/config').catch(() => null);
    if (!res || !res.ok) { console.error('Failed to fetch /api/mqtt/config'); return; }
    const cfg = await res.json();
    if (!cfg?.ok) { console.error('Bad mqtt config'); return; }

    const { url, username, password, topics = [] } = cfg;
    const clientId = 'web_' + Math.random().toString(16).slice(2);
    client = mqtt.connect(url, {
      clientId, username, password,
      clean: true, connectTimeout: 15000, keepalive: 30,
      protocolVersion: 4, reconnectPeriod: 4000
    });

    // make available to other modules if not already
    if (!window.MQTT_CLIENT) window.MQTT_CLIENT = client;

    client.on('connect', () => {
      // Existing topics (sensor JSON, etc.)
      topics.forEach(tp => client.subscribe(tp, { qos: 1 }, (err) => {
        if (err) console.warn('Subscribe error', tp, err);
      }));

      // Direct, near real-time room occupancy counts
      client.subscribe('dt/dt-lab/+/count', { qos: 1 }, (err) => {
        if (err) console.warn('Subscribe error dt/dt-lab/+/count', err);
      });
    });

    client.on('message', (topic, payload) => {
      const isCountTopic = /\/count$/.test(topic);

      // During playback, prefer snapshots, so ignore *live* paints
      if (!isCountTopic && window.__PLAYBACK_ACTIVE) return;
      if (isCountTopic && window.__PLAYBACK_ACTIVE) return;

      if (isCountTopic) {
        // Payload sample: {"room":"WWH015","count":1,"event":"entry","t":1761108665636}
        let obj = null;
        try { obj = JSON.parse(payload.toString()); } catch {}
        if (!obj || typeof obj.room !== 'string') return;

        const room = obj.room;
        const n = Number(obj.count);
        const ts = toMs(obj.t ?? Date.now());
        if (!Number.isFinite(n)) return;

        latestOccByRoom.set(room, { count: n, ts });

        if (room === primaryRoomName) {
          renderDock();
          setUpdatedFromMs(ts);
        }
        return;
      }

      // Sensor telemetry (JSON)
      const dev = deviceFromTopic(topic);
      if (!dev) return;
      let obj = null;
      try { obj = JSON.parse(payload.toString()); } catch {}
      if (!obj) return;

      let ms = toMs(obj.ts_ms ?? obj.ts ?? Date.now());
      const MIN_OK = Date.UTC(2010, 0, 1);
      const MAX_FUTURE = Date.now() + 7 * 24 * 3600 * 1000;
      if (ms < MIN_OK || ms > MAX_FUTURE) ms = Date.now();

      const m = extractMetrics(obj);
      latestByDevice.set(dev, m);

      if (dev === primaryDeviceId) {
        renderDock();
        setUpdatedFromMs(ms);
      }
    });
  }

  // Boot + initial paint
  bootMqtt().then(() => {
    renderDock();
    setUpdatedFromMs(null);
  });

  // Periodic re-render to reflect staleness expiry for occupancy
  setInterval(() => {
    // If occupancy just crossed the 6h boundary, this will clear it visually
    renderDock();
  }, 60 * 1000);

  /* ---------- Day Playback integration ---------- */

  // Global flag so other modules can check mode
  window.__PLAYBACK_ACTIVE = false;

  let __pbIdleTimer = null;
  function setPlaybackActive(active) {
    window.__PLAYBACK_ACTIVE = !!active;
  }

  // Render snapshot for both sensor + room occupancy if available
  function renderSnapshotToDock(primaryDevId, snap, tsMs) {
    // snap is expected to look like:
    // {
    //   sensors: { "<deviceId>": { temp_f, rh_pct, tvoc_ppb, eco2_ppm, occ? } },
    //   rooms:   { "<roomName>": { count, ts? } or number }
    //   ...
    // }

    // Sensor slice
    const s = (primaryDevId && snap?.sensors?.[primaryDevId]) || null;

    const t  = (s && typeof s.temp_f   === 'number') ? s.temp_f   : null;
    const rh = (s && typeof s.rh_pct   === 'number') ? s.rh_pct   : null;
    const tv = (s && typeof s.tvoc_ppb === 'number') ? s.tvoc_ppb : null;
    const c2 = (s && typeof s.eco2_ppm === 'number') ? s.eco2_ppm : null;

    // Room slice (prefer snapshot rooms over sensor occ)
    let occSnap = null;
    if (primaryRoomName && snap && snap.rooms && Object.prototype.hasOwnProperty.call(snap.rooms, primaryRoomName)) {
      const row = snap.rooms[primaryRoomName];
      if (typeof row === 'number') {
        occSnap = row;
      } else if (row && typeof row.count === 'number') {
        occSnap = row.count;
      }
    } else if (s && typeof s.occ === 'number') {
      occSnap = s.occ;
    }

    setValDot(el.tempVal, el.tempDot, t  != null ? `${t.toFixed(1)} °F` : '—', classify('temp_f',  t));
    setValDot(el.humVal,  el.humDot,  rh != null ? `${rh.toFixed(1)} %` : '—', classify('rh_pct',  rh));
    setValDot(el.tvocVal, el.tvocDot, tv != null ? `${Math.round(tv)} ppb` : '—', classify('tvoc_ppb', tv));
    setValDot(el.eco2Val, el.eco2Dot, c2 != null ? `${Math.round(c2)} ppm` : '—', classify('eco2_ppm', c2));
    setValDot(el.occVal, el.occDot, formatPeople(occSnap), classify('occ', occSnap));
    setUpdatedFromMs(tsMs || Date.now());
  }

  // Consume playback frames
  window.addEventListener('playback:tick', (e) => {
    const { ts, snapshot } = e.detail || {};
    let primaryDev = null;
    try { primaryDev = localStorage.getItem('primary_sensor_device') || null; } catch {}

    setPlaybackActive(true);
    clearTimeout(__pbIdleTimer);
    __pbIdleTimer = setTimeout(() => setPlaybackActive(false), 2000);

    // Prefer snapshot (both sensor metrics and room occupancy)
    if ((primaryDev && snapshot?.sensors?.[primaryDev]) || (snapshot?.rooms && primaryRoomName)) {
      renderSnapshotToDock(primaryDev, snapshot, ts);
    } else {
      // no snapshot for this minute — render blanks but keep time
      renderSnapshotToDock(primaryDev, null, ts);
    }
  });

  // Optional explicit state if your playback module dispatches it
  window.addEventListener('playback:state', (e) => {
    const playing = !!(e.detail && e.detail.playing);
    setPlaybackActive(playing);
  });

  /* ---------- Public API ---------- */
  const api = {
    // sensor
    setPrimaryByDbId,
    getDeviceByDbId,
    DBID_TO_DEVICE,
    // room
    setPrimaryRoomByDbId,
    setPrimaryRoomByName,
    getRoomByDbId,
    DBID_TO_ROOM
  };

  // Merge (do not clobber) any previous METRICS
  window.METRICS = Object.assign(window.METRICS || {}, api);
  return window.METRICS;
})();

export default METRICS;
