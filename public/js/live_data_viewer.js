// live_data_viewer.js — polished Live Data popup with ~20-bucket aggregation + CSV (+room support)

(() => {
  const $ = (sel) => document.querySelector(sel);
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

  // ---- Popup
  function ensurePopup() {
    const mask = $('#popupMask'), title = $('#popupTitle'), body = $('#popupBody'), closeBtn = $('#popupClose');
    if (!mask || !title || !body) return null;
    on(closeBtn, 'click', closePopup);
    on(mask, 'click', (e) => { if (e.target === mask) closePopup(); });
    return { mask, title, body };
  }
  function openPopup() { const dom = ensurePopup(); if (!dom) return null; dom.body.innerHTML = ''; dom.mask.style.display = 'flex'; return dom; }
  function closePopup() { const mask = $('#popupMask'); if (mask) mask.style.display = 'none'; }

  // ---- Chart.js
  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement('script'); s.src = src; s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
    });
  }
  async function ensureChartJs() {
    if (window.Chart) return;
    await loadScriptOnce('https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js');
    await loadScriptOnce('https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3');
  }
  // ---- Make metric tiles clickable to open history
  function hookMetricClicks() {
    // Map card IDs → metric field names
    const map = {
      mTemp: { metric: 'temp_f' },
      mHum:  { metric: 'rh_pct' },
      mTvoc: { metric: 'tvoc_ppb' },
      mEco2: { metric: 'eco2_ppm' },
      mOcc:  { metric: 'count' }
    };

    Object.entries(map).forEach(([id, cfg]) => {
      const card = document.getElementById(id);
      if (!card) return;

      // make the whole card feel clickable
      card.style.cursor = 'pointer';

      card.addEventListener('click', () => {
        const m = window.METRICS || {};
        const roomName =
          (typeof m.getPrimaryRoomName === 'function' && m.getPrimaryRoomName()) ||
          (Array.isArray(m.ROOMS_LIST) && m.ROOMS_LIST.length ? m.ROOMS_LIST[0] : null);

        window.dispatchEvent(
          new CustomEvent('openHistoryForMetric', {
            detail: { metric: cfg.metric, roomName }
          })
        );
      });
    });
  }

  // Ensure we hook **after** DOM is ready so cards exist
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hookMetricClicks, { once: true });
  } else {
    hookMetricClicks();
  }



  // ---- Fallback mappings (only used if your modules don't expose theirs)
  const FALLBACK_SENSOR_DBID_TO_DEVICE = new Map([[2350, 'dtn-e41358088304']]);
  const FALLBACK_PLUG_DBID_TO_DEVICES  = new Map([[2244, ['dtn-12e7df']]]);
  const FALLBACK_LIGHT_DEVICE_TO_DBIDS = new Map([['dtn-e41358088304', [2394, 2396, 2395, 2392, 2390, 2393]],
   ['dtn-d0bdbf0b65f4', [2961, 2962, 2963, 2964, 2965, 2966]],
  ['dtn-a01cbf0b65f4', [3078, 3079, 3080, 3081, 3082, 3083]]]);
  const FALLBACK_DBID_TO_ROOM          = new Map([]); // fill if needed

  function resolveDevicesFor({ category, dbId }) {
    dbId = Number(dbId);
    if (category === 'sensor') {
      const m = window.METRICS;
      if (m?.DBID_TO_DEVICE?.has(dbId)) return [m.DBID_TO_DEVICE.get(dbId)];
      if (typeof m?.getDeviceByDbId === 'function') { const d = m.getDeviceByDbId(dbId); if (d) return [d]; }
      if (FALLBACK_SENSOR_DBID_TO_DEVICE.has(dbId)) return [FALLBACK_SENSOR_DBID_TO_DEVICE.get(dbId)];
      return [];
    }
    if (category === 'plug') {
      const p = window.PLUGS;
      if (p?.DBID_TO_DEVICES?.has(dbId)) return [...p.DBID_TO_DEVICES.get(dbId)];
      if (typeof p?.getDevicesForDbId === 'function') return [...(p.getDevicesForDbId(dbId) || [])];
      if (FALLBACK_PLUG_DBID_TO_DEVICES.has(dbId)) return [...FALLBACK_PLUG_DBID_TO_DEVICES.get(dbId)];
      return [];
    }
    if (category === 'light') {
      const L = window.LIGHTS;
      if (typeof L?.getDevicesForDbId === 'function') return [...(L.getDevicesForDbId(dbId) || [])];
      for (const [dev, ids] of FALLBACK_LIGHT_DEVICE_TO_DBIDS) if (ids.includes(dbId)) return [dev];
      return [];
    }
    if (category === 'room') {
      const m = window.METRICS;
      if (typeof m?.getRoomByDbId === 'function') {
        const room = m.getRoomByDbId(dbId);
        return room ? [room] : [];
      }
      if (FALLBACK_DBID_TO_ROOM.has(dbId)) return [FALLBACK_DBID_TO_ROOM.get(dbId)];
      return [];
    }
    return [];
  }

  // What fields each category can chart
  const METRICS_BY_CATEGORY = {
    sensor: [
      { field: 'temp_f',   label: 'Temperature (°F)' },
      { field: 'rh_pct',   label: 'Relative Humidity (%)' },
      { field: 'tvoc_ppb', label: 'TVOC (ppb)' },
      { field: 'eco2_ppm', label: 'eCO₂ (ppm)' },
    ],
    plug: [
      { field: 'volts',      label: 'Voltage (V)' },
      { field: 'amps',       label: 'Current (A)' },
      { field: 'watts',      label: 'Power (W)' },
      { field: 'energy_wh',  label: 'Energy (Wh)' }, // server may also return energy_kwh
      { field: 'relay_num',  label: 'Relay (0/1)' }, // server uses last()
    ],
    light: [
      { field: 'light_on_num', label: 'Light ON (0/1)' }, // from env
    ],
    room: [
      { field: 'count', label: 'Occupancy (people)' },     // NEW
    ],
  };

  const measurementFor = (category) =>
    category === 'plug' ? 'plugData'
  : category === 'room' ? 'room_count'  // NEW
  : 'env';

  // ---- Target ~20 points
  function pickEvery({ minutes = null, startISO = null, stopISO = null, targetPts = 20 }) {
    if (minutes != null) {
      const m = Math.max(1, Number(minutes) || 60);
      const stepMin = Math.max(1, Math.round(m / targetPts));
      return `${stepMin}m`;
    }
    if (startISO && stopISO) {
      const ms = Math.max(30_000, (new Date(stopISO) - new Date(startISO)));
      const stepSec = Math.max(30, Math.floor((ms / 1000) / targetPts));
      return stepSec < 60 ? `${stepSec}s` : `${Math.round(stepSec/60)}m`;
    }
    return '1m';
  }

  // ---- UI builder
  function buildUI({ devices, defaultDevice, category }) {
    const root = document.createElement('div');
    root.className = 'ldv-root';

    const hdr = document.createElement('div');
    hdr.className = 'ldv-hdr';

    let devSel = null;
    if (devices.length > 1) {
      devSel = document.createElement('select');
      devSel.className = 'ldv-sel';
      devices.forEach(d => {
        const o = document.createElement('option');
        o.value = d; o.textContent = d; if (d === defaultDevice) o.selected = true;
        devSel.appendChild(o);
      });
      hdr.appendChild(devSel);
    }

    const metricSel = document.createElement('select');
    metricSel.className = 'ldv-sel ldv-metric';
    (METRICS_BY_CATEGORY[category] || []).forEach(m => {
      const o = document.createElement('option'); o.value = m.field; o.textContent = m.label; metricSel.appendChild(o);
    });
    hdr.appendChild(metricSel);

    const presetRow = document.createElement('div'); presetRow.className = 'ldv-presets';
    const presets = [{label:'1h',minutes:60},{label:'6h',minutes:360},{label:'24h',minutes:1440},{label:'72h',minutes:4320}];
    const presetButtons = presets.map(p => {
      const b = document.createElement('button'); b.className='ldv-btn ldv-preset'; b.textContent=`Last ${p.label}`; b.dataset.minutes=String(p.minutes); presetRow.appendChild(b); return b;
    });
    hdr.appendChild(presetRow);

    const range = document.createElement('div'); range.className = 'ldv-range';
    const s = document.createElement('input'); s.type='datetime-local'; s.className='ldv-input';
    const e = document.createElement('input'); e.type='datetime-local'; e.className='ldv-input';
    const apply = document.createElement('button'); apply.className='ldv-btn'; apply.textContent='Apply';
    const dl = document.createElement('button'); dl.className='ldv-btn ldv-ghost'; dl.textContent='Download CSV';
    range.append(s, e, apply, dl);

    const chartWrap = document.createElement('div'); chartWrap.className = 'ldv-chartWrap';
    const overlay = document.createElement('div'); overlay.className = 'ldv-overlay'; overlay.style.display='none';
    overlay.innerHTML = '<div class="ldv-spin"></div><div class="ldv-msg"></div>';
    const canvas = document.createElement('canvas'); canvas.id = 'tsChartLive';
    chartWrap.append(canvas, overlay);

    root.append(hdr, range, chartWrap);
    return { root, metricSel, devSel, presetButtons, startInp: s, stopInp: e, applyBtn: apply, dlBtn: dl, canvas, overlay };
  }

  // ---- Query builder: now supports tagKey (room vs device)
  function buildQuery({ category, device, field, minutes, startISO, stopISO, every, tagKey, agg }) {
  const measurement = measurementFor(category);
  let fields = field;
  if (category === 'plug' && field === 'energy_wh') fields = 'energy_wh,energy_kwh';

  const params = new URLSearchParams({
    measurement,
    device,
    fields,
    ...(minutes ? { minutes: String(minutes) } : {}),
    ...(startISO ? { start: startISO } : {}),
    ...(stopISO  ? { stop:  stopISO } : {}),
    ...(every    ? { every } : {}),
    ...(tagKey   ? { tagKey } : {}),
    ...(agg      ? { agg }   : {}),   // NEW
  });
  return `/api/series?${params.toString()}`;
}

  // ---- Inputs helpers
  function toLocalInputValue(d) {
    const pad = (n) => String(n).padStart(2, '0');
    const y = d.getFullYear();
    const m = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hh = pad(d.getHours());
    const mm = pad(d.getMinutes());
    return `${y}-${m}-${day}T${hh}:${mm}`;
  }

  // ---- Series utilities
  function normalizeEnergy(series) {
    if (!series) return series;
    if (!series.energy_wh && series.energy_kwh) {
      series.energy_wh = series.energy_kwh.map(p => ({ t: p.t, v: Number(p.v) * 1000 }));
    }
    return series;
  }

  const palette = ['#4e79a7','#f28e2b','#e15759','#76b7b2','#59a14f','#edc948','#b07aa1','#ff9da7'];
  function datasetsFrom(series, chosenField) {
    return Object.keys(series || {}).map((f, i) => {
      const data = (series[f] || []).sort((a,b)=>new Date(a.t)-new Date(b.t))
        .map(p => ({ x: new Date(p.t), y: p.v }));
      return {
        label: f, data,
        borderColor: (f === chosenField) ? '#0ea5e9' : palette[i % palette.length],
        backgroundColor: 'transparent',
        borderWidth: 1.6, tension: 0.2,
        pointRadius: 0, pointHoverRadius: 3, pointHitRadius: 6, spanGaps: true
      };
    });
  }

  function domainFromSeries(series) {
    let tMin = Infinity, tMax = -Infinity;
    for (const arr of Object.values(series || {})) {
      for (const p of arr || []) {
        const t = +new Date(p.t);
        if (Number.isFinite(t)) { if (t < tMin) tMin = t; if (t > tMax) tMax = t; }
      }
    }
    if (!Number.isFinite(tMin) || !Number.isFinite(tMax)) return null;
    const pad = Math.max(60000, Math.round((tMax - tMin) * 0.01));
    return { min: new Date(tMin - pad), max: new Date(tMax + pad) };
  }

  function domainFromRequest({ minutes, startISO, stopISO }) {
    if (startISO && stopISO) return { min: new Date(startISO), max: new Date(stopISO) };
    if (minutes != null) {
      const now = Date.now();
      const ms = Math.max(60_000, Number(minutes) * 60_000);
      return { min: new Date(now - ms), max: new Date(now) };
    }
    return null;
  }

  // ---- CSV export (supports rooms via tagKey)
  async function downloadRawCSV(canvas) {
    const req = canvas._lastReq;
    if (!req) throw new Error('No query context to export.');

    const meas = (req.category === 'plug') ? 'plugData'
               : (req.category === 'room') ? 'room_count'
               : 'env';

    const params = new URLSearchParams({
      measurement: meas,
      device: req.device,
      fields: (req.category === 'plug' && req.field === 'energy_wh')
                ? 'energy_wh,energy_kwh'
                : req.field,
      every: 'raw'
    });
    if (req.tagKey) params.set('tagKey', req.tagKey);
    if (req.minutes != null) params.set('minutes', String(req.minutes));
    if (req.startISO && req.stopISO) {
      params.set('start', req.startISO);
      params.set('stop',  req.stopISO);
    }

    const res = await fetch(`/api/series?${params.toString()}`, { cache:'no-store' });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.error || 'Download failed');

    if (req.category === 'plug' && req.field === 'energy_wh' && !json.series.energy_wh && json.series.energy_kwh) {
      json.series.energy_wh = (json.series.energy_kwh || []).map(p => ({ t:p.t, v:Number(p.v)*1000 }));
    }

    const field = req.field === 'energy_wh' ? 'energy_wh' : req.field;
    const arr = json.series?.[field] || [];

    const rows = [['time','value','field', req.tagKey === 'room' ? 'room' : 'device']];
    arr.forEach(p => rows.push([p.t, p.v, field, req.device]));
    const csv = rows.map(r => r.map(x => `"${String(x).replace(/"/g,'""')}"`).join(',')).join('\n');

    const blob = new Blob([csv], { type:'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `${req.device}_${field}_raw.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{ URL.revokeObjectURL(url); a.remove(); }, 0);
  }

  // --- query + draw core (uses overlay, supports tagKey)
 // --- query + draw core (uses overlay, supports tagKey + occupancy bar mode)
async function queryAndDrawExec({
  category,
  device,
  field,
  minutes,
  startISO,
  stopISO,
  every,
  canvas,
  overlay,
  tagKey,
  agg
}) {
  const setOverlay = (msg = 'Loading…', show = true) => {
    if (!overlay) return;
    overlay.style.display = show ? 'flex' : 'none';
    const msgEl = overlay.querySelector('.ldv-msg');
    if (msgEl) msgEl.textContent = msg || '';
  };

  setOverlay('Loading…', true);

  const url = buildQuery({ category, device, field, minutes, startISO, stopISO, every, tagKey, agg });
  let json;
  try {
    const res = await fetch(url, { cache: 'no-store' });
    json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || 'Query failed');
  } catch (e) {
    setOverlay(`Error: ${e.message || e}`, true);
    setTimeout(() => setOverlay('', false), 1800);
    const old = window.Chart && window.Chart.getChart(canvas);
    if (old) old.destroy();
    return;
  }

  // Normalise plug energy if needed
  if (category === 'plug' && field === 'energy_wh') {
    json.series = normalizeEnergy(json.series);
  }

  const series = json.series || {};
  const domain = domainFromSeries(series) || domainFromRequest({ minutes, startISO, stopISO });

  // If no data at all
  const hasAny = Object.values(series || {}).some(arr => (arr || []).length > 0);
  if (!hasAny) {
    setOverlay('No data for this selection.', true);
    const old = window.Chart && window.Chart.getChart(canvas);
    if (old) old.destroy();
    return;
  }

  // Occupancy mode: room count as bar chart
const isOcc = (category === 'room' && field === 'count');

const datasets = datasetsFrom(series, field);

if (isOcc) {
  datasets.forEach(ds => {
    ds.type = 'line';
    ds.borderColor = '#38bdf8';
    ds.backgroundColor = 'transparent';
    ds.borderWidth = 2;

    // 🔥 KEY: force perfect 90-degree step transitions
    ds.tension = 0;
    ds.stepped = 'middle';

    ds.pointRadius = 0;
  });
}

  const old = window.Chart && window.Chart.getChart(canvas);
  if (old) old.destroy();

  const ctx = canvas.getContext('2d');
  const chartType = isOcc ? 'line' : 'line';

  const chart = new Chart(ctx, {
    type: chartType,
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      parsing: false,
      animation: false,
      plugins: {
        legend: {
          display: true,
          labels: { boxWidth: 14, usePointStyle: !isOcc }
        },
        title: {
          display: false
        },
        // For non-occupancy we keep LTTB decimation. For occupancy we turn it off.
        decimation: isOcc
          ? { enabled: false }
          : { enabled: true, algorithm: 'lttb', samples: 20 },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label: (ctx) => {
              const v = ctx.parsed.y;
              if (v == null || Number.isNaN(v)) return '';
              // Nice label for occupancy counts
              if (field === 'count') {
                const n = Math.round(v);
                return `${ctx.dataset.label}: ${n} ${n === 1 ? 'person' : 'people'}`;
              }
              return `${ctx.dataset.label}: ${v}`;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: { tooltipFormat: 'MMM d, HH:mm' },
          adapters: {},
          min: domain?.min || undefined,
          max: domain?.max || undefined,
          ticks: { maxRotation: 0, autoSkip: true }
        },
        y: {
          beginAtZero: isOcc ? true : false,
          ticks: {
            // Let Chart.js pick good ticks; we just ensure ints for occupancy
            callback: (val) => {
              if (isOcc) return Number(val).toFixed(0);
              return val;
            }
          }
        }
      },
      elements: {
        point: {
          radius: isOcc ? 0 : 0,
          hoverRadius: isOcc ? 0 : 3,
          hitRadius: 6
        },
        line: {
          borderWidth: isOcc ? 2 : 1.6,
          tension: isOcc ? 0 : 0.2,
          stepped: isOcc ? 'middle' : false
        }
      }
    }
  });

  // Remember last request for CSV export
  canvas._lastReq = { category, device, field, minutes, startISO, stopISO, every, tagKey, agg };

  setOverlay('', false);
}
  
  // Open history when clicking a metric tile (room-aware)
window.addEventListener('openHistoryForMetric', async (ev) => {
  const { metric, roomName: rawRoom } = ev.detail || {};
  if (!metric) return;

  const m = window.METRICS || {};

  // 1) Resolve room (explicit → primary → first in list)
  let roomName =
    rawRoom ||
    (typeof m.getPrimaryRoomName === 'function' && m.getPrimaryRoomName()) ||
    (Array.isArray(m.ROOMS_LIST) && m.ROOMS_LIST.length ? m.ROOMS_LIST[0] : null);

  if (!roomName) {
    console.warn('openHistoryForMetric: no roomName available');
    return;
  }

  // Decide what we're charting
  const isOcc = (metric === 'count');
  const category = isOcc ? 'room' : 'sensor';

  let device;      // what goes into the "device" param for /api/series
  //let tagKey;      // optional tag key (for rooms)
 // let agg;         // optional aggregation (for rooms)
 let tagKey = (category === 'room') ? 'room' : undefined;
 let agg    = (category === 'room') ? 'max'  : undefined;

  if (category === 'sensor') {
    // Map room → deviceId via METRICS.ROOM_TO_DEVICE (env sensors)
    const dev =
      m.ROOM_TO_DEVICE && typeof m.ROOM_TO_DEVICE.get === 'function'
        ? m.ROOM_TO_DEVICE.get(roomName)
        : null;

    if (!dev) {
      console.warn('openHistoryForMetric: no device mapped for room', roomName);
      return;
    }
    device = dev;
  } else {
    // Room-based occupancy — treat room name as "device" + group by tagKey=room
    device = roomName;
    tagKey = 'room';
    agg    = 'max';   // e.g., max count per bucket
  }

  await ensureChartJs();
  const dom = openPopup();
  if (!dom) return;

  // Make popup tall + column layout
  const popup = document.querySelector('#popupMask .popup');
  if (popup) {
    popup.style.height = '70vh';
    popup.style.display = 'flex';
    popup.style.flexDirection = 'column';
  }
  const body = document.querySelector('#popupBody');
  if (body) {
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '8px';
    body.style.height = '100%';
  }

   const devices = [device];
  const defaultDevice = device;
  dom.title.textContent = `${roomName} • ${defaultDevice} — Live Data`;

   const {
    root,
    metricSel,
    devSel,
    presetButtons,
    startInp,
    stopInp,
    applyBtn,
    dlBtn,
    canvas,
    overlay
  } = buildUI({ devices, defaultDevice, category });

  dom.body.innerHTML = '';
  dom.body.appendChild(root);

  // Preselect the clicked metric if available AND compute a human label
  const defs = METRICS_BY_CATEGORY[category] || [];
  let metricLabel = metric;  // fallback

  if (defs.length) {
    const def = defs.find(d => d.field === metric) || defs[0];
    metricSel.value = def.field;
    metricLabel = def.label || def.field;
  }

  const getDevice = () => (devSel ? devSel.value : defaultDevice);
  const getField  = () => metricSel.value;
  const setActivePreset = (btn) =>
    presetButtons.forEach(b => b.classList.toggle('active', b === btn));

  async function queryAndDraw({ minutes = '60', startISO = null, stopISO = null } = {}) {
  const field = getField();
  const isOccField = (category === 'room' && field === 'count');

  // Use smart bucket sizing for both:
  // - env sensors: target ~20 points
  // - occupancy:   target ~50 bars
  const every = pickEvery({
    minutes,
    startISO,
    stopISO,
    targetPts: isOccField ? 50 : 20
  });

  dom.title.textContent = `${getDevice()} — ${metricLabel}`;

  await queryAndDrawExec({
    category,
    device: getDevice(),
    field,
    minutes,
    startISO,
    stopISO,
    every,
    canvas,
    overlay,
    tagKey,
    agg
  });
}


  // Presets
  presetButtons.forEach(btn =>
    btn.addEventListener('click', () => {
      const mins = Number(btn.dataset.minutes);
      const end = new Date();
      const start = new Date(end.getTime() - mins * 60_000);
      startInp.value = toLocalInputValue(start);
      stopInp.value  = toLocalInputValue(end);
      setActivePreset(btn);
      queryAndDraw({ minutes: String(mins) });
    })
  );

  // React to metric changes
  metricSel.addEventListener('change', () => queryAndDraw());
  if (devSel) devSel.addEventListener('change', () => queryAndDraw());

  // Apply custom range
  applyBtn.addEventListener('click', () => {
    const s = startInp.value ? new Date(startInp.value) : null;
    const e = stopInp.value  ? new Date(stopInp.value)  : null;
    if (!s || !e || isNaN(s) || isNaN(e) || e <= s) {
      overlay.style.display = 'flex';
      overlay.querySelector('.ldv-msg').textContent = 'Pick a valid start and stop.';
      setTimeout(() => { overlay.style.display = 'none'; }, 1600);
      return;
    }
    setActivePreset(null);
    queryAndDraw({ minutes: null, startISO: s.toISOString(), stopISO: e.toISOString() });
  });

  // CSV download
  if (dlBtn) dlBtn.addEventListener('click', async () => {
    try {
      overlay.style.display = 'flex';
      overlay.querySelector('.ldv-msg').textContent = 'Preparing CSV…';
      await downloadRawCSV(canvas);
      overlay.style.display = 'none';
    } catch (e) {
      overlay.querySelector('.ldv-msg').textContent = `CSV error: ${e.message || e}`;
      setTimeout(() => { overlay.style.display = 'none'; }, 1500);
    }
  });

  // Initial load: 1h
  {
    const end = new Date();
    const start = new Date(end.getTime() - 60 * 60_000);
    startInp.value = toLocalInputValue(start);
    stopInp.value  = toLocalInputValue(end);
    if (presetButtons[0]) setActivePreset(presetButtons[0]);
    queryAndDraw({ minutes: '60' }).catch(err => {
      overlay.style.display = 'flex';
      overlay.querySelector('.ldv-msg').textContent = `Error: ${err?.message || err}`;
    });
  }
});



  // ---- Event wiring
  window.addEventListener('openLiveData', async (ev) => {
    const { dbId, category } = ev.detail || {};
    if (!dbId || !category) return;

    await ensureChartJs();
    const dom = openPopup(); if (!dom) return;

    const popup = $('#popupMask .popup');
    if (popup) { popup.style.height='70vh'; popup.style.display='flex'; popup.style.flexDirection='column'; }
    const body = $('#popupBody'); if (body) { body.style.display='flex'; body.style.flexDirection='column'; body.style.gap='8px'; body.style.height='100%'; }

    const devices = resolveDevicesFor({ category, dbId });
    if (!devices.length) {
      dom.title.textContent = 'Live Data';
      const note = document.createElement('div'); note.className='ldv-empty'; note.textContent=`No mapping for dbId ${dbId} (${category}).`;
      dom.body.appendChild(note); setTimeout(closePopup, 2200); return;
    }

    const defaultDevice = devices[0];
    dom.title.textContent = `${defaultDevice} — Live Data`;

    const { root, metricSel, devSel, presetButtons, startInp, stopInp, applyBtn, dlBtn, canvas, overlay } =
      buildUI({ devices, defaultDevice, category });

    dom.body.innerHTML = '';
    dom.body.appendChild(root);

    const defs = METRICS_BY_CATEGORY[category] || [];
    if (defs.length) metricSel.value = defs[0].field;

    const getDevice = () => (devSel ? devSel.value : defaultDevice);
    const getField  = () => metricSel.value;
    const setActivePreset = (btn) => presetButtons.forEach(b => b.classList.toggle('active', b === btn));
    const tagKey = (category === 'room') ? 'room' : undefined; // NEW
    const agg    = (category === 'room') ? 'max' : undefined;

    async function queryAndDraw({ minutes = '60', startISO = null, stopISO = null } = {}) {
      const every = pickEvery({ minutes, startISO, stopISO, targetPts: 20 });
      dom.title.textContent = `${getDevice()} — Live Data`;
      await queryAndDrawExec({
        category,
        device: getDevice(),
        field: getField(),
        minutes, startISO, stopISO,
        every,
        canvas, overlay,
        tagKey ,
        agg   
      });
    }

    presetButtons.forEach(btn => btn.addEventListener('click', () => {
      const mins = Number(btn.dataset.minutes);
      const end = new Date();                    // now (local)
      const start = new Date(end.getTime() - mins * 60_000);
      startInp.value = toLocalInputValue(start);
      stopInp.value  = toLocalInputValue(end);
      setActivePreset(btn);
      queryAndDraw({ minutes: String(mins) });
    }));

    on(metricSel, 'change', () => queryAndDraw());
    if (devSel) on(devSel, 'change', () => queryAndDraw());

    on(applyBtn, 'click', () => {
      const s = startInp.value ? new Date(startInp.value) : null;
      const e = stopInp.value  ? new Date(stopInp.value)  : null;
      if (!s || !e || isNaN(s) || isNaN(e) || e <= s) {
        overlay.style.display='flex'; overlay.querySelector('.ldv-msg').textContent='Pick a valid start and stop.';
        setTimeout(() => { overlay.style.display='none'; }, 1600); return;
      }
      setActivePreset(null);
      queryAndDraw({ minutes: null, startISO: s.toISOString(), stopISO: e.toISOString() });
    });

    if (dlBtn) on(dlBtn, 'click', async () => {
      try {
        overlay.style.display='flex';
        overlay.querySelector('.ldv-msg').textContent='Preparing CSV…';
        await downloadRawCSV(canvas);
        overlay.style.display='none';
      } catch (e) {
        overlay.querySelector('.ldv-msg').textContent = `CSV error: ${e.message || e}`;
        setTimeout(()=> overlay.style.display='none', 1500);
      }
    });

    // initial: 1h
    {
      const end = new Date();
      const start = new Date(end.getTime() - 60 * 60_000);
      startInp.value = toLocalInputValue(start);
      stopInp.value  = toLocalInputValue(end);
      setActivePreset(presetButtons[0]);
      queryAndDraw({ minutes: '60' }).catch(err => {
        overlay.style.display='flex';
        overlay.querySelector('.ldv-msg').textContent = `Error: ${err?.message || err}`;
      });
    }
  });
})();
