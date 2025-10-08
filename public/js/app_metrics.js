// app_metrics.js — live metrics dock + MQTT + primary sensor mapping + Day Playback integration

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

  /* ---------- Thresholds & classify ---------- */
  const THRESHOLDS = {
    temp_f:   { cool: 0,     good: [68, 77], warn: [77, 82],  bad: [82,  999] },
    rh_pct:   {              good: [30, 60], warn: [60, 70],  bad: [70,  999] },
    tvoc_ppb: {              good: [0,  400], warn: [400,1000], bad:[1000,99999] },
    eco2_ppm: {              good: [400,1000], warn:[1000,2000], bad:[2000,99999] },
    occ:      {              good: [0,    5], warn: [6,   10],  bad:[11,  999] },
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

  /* ---------- dbId <-> device mapping ---------- */
  const DBID_TO_DEVICE = new Map([
    [2350, 'dtn-e41358088304'],
    [2348, 'dtn-3c2b5540c86c'],
    // add more: [dbid, 'device-id'],
  ]);

  // after: const DBID_TO_DEVICE = new Map([...]);
window.METRICS = Object.assign(window.METRICS || {}, {
  DBID_TO_DEVICE,
  setPrimaryByDbId
});


  const DEFAULT_PRIMARY_DBID = 2350;

  let primaryDeviceId = null;
  try { const cached = localStorage.getItem('primary_sensor_device'); if (cached) primaryDeviceId = cached; } catch {}
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

  // Expose for other modules (day playback, etc.)
  window.METRICS = { setPrimaryByDbId, getDeviceByDbId, DBID_TO_DEVICE };

  /* ---------- Live state + MQTT ---------- */
  let client = null;
  const latestByDevice = new Map();

  function extractMetrics(payloadObj) {
    return {
      temp_f:   (payloadObj.temp_f   != null) ? Number(payloadObj.temp_f)   : null,
      rh_pct:   (payloadObj.rh_pct   != null) ? Number(payloadObj.rh_pct)   : null,
      tvoc_ppb: (payloadObj.tvoc_ppb != null) ? Number(payloadObj.tvoc_ppb) : null,
      eco2_ppm: (payloadObj.eco2_ppm != null) ? Number(payloadObj.eco2_ppm) : null,
      // occ stays optional/placeholder
    };
  }

  function renderDock() {
    const dev = primaryDeviceId;
    const s = dev ? latestByDevice.get(dev) : null;

    const t   = (s && typeof s.temp_f   === 'number') ? s.temp_f   : null;
    const rh  = (s && typeof s.rh_pct   === 'number') ? s.rh_pct   : null;
    const tv  = (s && typeof s.tvoc_ppb === 'number') ? s.tvoc_ppb : null;
    const c2  = (s && typeof s.eco2_ppm === 'number') ? s.eco2_ppm : null;
    const occ = (s && typeof s.occ      === 'number') ? s.occ      : null;

    setValDot(el.tempVal, el.tempDot, t  != null ? `${t.toFixed(1)} °F` : '—', classify('temp_f',  t));
    setValDot(el.humVal,  el.humDot,  rh != null ? `${rh.toFixed(1)} %` : '—', classify('rh_pct',  rh));
    setValDot(el.tvocVal, el.tvocDot, tv != null ? `${Math.round(tv)} ppb` : '—', classify('tvoc_ppb', tv));
    setValDot(el.eco2Val, el.eco2Dot, c2 != null ? `${Math.round(c2)} ppm` : '—', classify('eco2_ppm', c2));
    setValDot(el.occVal,  el.occDot,  occ!= null ? String(occ) : '—',        classify('occ',     occ));
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

    client.on('connect', () => {
      topics.forEach(tp => client.subscribe(tp, { qos: 1 }, (err) => {
        if (err) console.warn('Subscribe error', tp, err);
      }));
    });

    client.on('message', (topic, payload) => {
      // While day playback is active, suppress live paints
      if (window.__PLAYBACK_ACTIVE) return;

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

  // Boot immediately
  bootMqtt().then(() => {
    renderDock();
    setUpdatedFromMs(null);
  });

  /* ---------- Day Playback integration ---------- */

  // Global flag so other modules can check mode
  window.__PLAYBACK_ACTIVE = false;

  let __pbIdleTimer = null;
  function setPlaybackActive(active) {
    window.__PLAYBACK_ACTIVE = !!active;
  }

  function renderSnapshotToDock(devId, snap, tsMs) {
    if (!snap) {
      setValDot(el.tempVal, el.tempDot, '—', '');
      setValDot(el.humVal,  el.humDot,  '—', '');
      setValDot(el.tvocVal, el.tvocDot, '—', '');
      setValDot(el.eco2Val, el.eco2Dot, '—', '');
      setValDot(el.occVal,  el.occDot,  '—', '');
      setUpdatedFromMs(tsMs || null);
      return;
    }

    const t  = (typeof snap.temp_f   === 'number') ? snap.temp_f   : null;
    const rh = (typeof snap.rh_pct   === 'number') ? snap.rh_pct   : null;
    const tv = (typeof snap.tvoc_ppb === 'number') ? snap.tvoc_ppb : null;
    const c2 = (typeof snap.eco2_ppm === 'number') ? snap.eco2_ppm : null;
    const oc = (typeof snap.occ      === 'number') ? snap.occ      : null;

    setValDot(el.tempVal, el.tempDot, t  != null ? `${t.toFixed(1)} °F` : '—', classify('temp_f',  t));
    setValDot(el.humVal,  el.humDot,  rh != null ? `${rh.toFixed(1)} %` : '—', classify('rh_pct',  rh));
    setValDot(el.tvocVal, el.tvocDot, tv != null ? `${Math.round(tv)} ppb` : '—', classify('tvoc_ppb', tv));
    setValDot(el.eco2Val, el.eco2Dot, c2 != null ? `${Math.round(c2)} ppm` : '—', classify('eco2_ppm', c2));
    setValDot(el.occVal,  el.occDot,  oc != null ? String(oc) : '—',        classify('occ',     oc));

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

    if (primaryDev && snapshot?.sensors?.[primaryDev]) {
      renderSnapshotToDock(primaryDev, snapshot.sensors[primaryDev], ts);
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
  return { setPrimaryByDbId, getDeviceByDbId, DBID_TO_DEVICE };
})();

export default METRICS;
