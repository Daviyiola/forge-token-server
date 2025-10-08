// day_playback.js — unified: UI (popup), data fetch, raster, playback engine

(() => {
  const $  = (sel) => document.querySelector(sel);
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

  /* ========== Collect devices from your modules ========== */
  function collectDevices() {
    const out = { sensors: [], plugs: [], lights: [] };

    if (window.METRICS?.DBID_TO_DEVICE instanceof Map) {
      for (const [dbid, device] of window.METRICS.DBID_TO_DEVICE) {
        out.sensors.push({ dbid, device });
      }
    }
    if (window.PLUGS?.DBID_TO_DEVICES instanceof Map) {
      for (const [dbid, devices] of window.PLUGS.DBID_TO_DEVICES) {
        if (Array.isArray(devices) && devices.length) out.plugs.push({ dbid, devices: [...devices] });
      }
    }
    if (window.LIGHTS?.DEVICE_TO_DBIDS instanceof Map) {
      for (const [device, dbids] of window.LIGHTS.DEVICE_TO_DBIDS) {
        out.lights.push({ device, dbids: [...dbids] });
      }
    }
    return out;
  }
  function getPrimarySensorDevice() {
    try { return localStorage.getItem('primary_sensor_device') || null; } catch { return null; }
  }

  /* ========== UI layout (popup) ========== */
  function buildLayout() {
    const wrap = document.createElement('div');
    wrap.className = 'dpb-root';
    wrap.innerHTML = `
      <div class="dpb-row dpb-top">
        <div class="dpb-field">
          <label>Date</label>
          <input id="dpbDate" type="date" />
        </div>
        <div class="dpb-field">
          <label>Time window</label>
          <div class="dpb-time">
            <input id="dpbStart" type="time" step="60" />
            <span>to</span>
            <input id="dpbStop"  type="time" step="60" />
          </div>
        </div>
        <div class="dpb-field">
          <label>Speed</label>
          <select id="dpbSpeed">
            <option value="0.5">0.5×</option>
            <option value="1" selected>1×</option>
            <option value="2">2×</option>
            <option value="4">4×</option>
            <option value="8">8×</option>
          </select>
        </div>
      </div>

      <div class="dpb-row dpb-mid">
        <div class="dpb-col">
          <div class="dpb-group">
            <div class="dpb-legend">Sensors</div>
            <div id="dpbSensors" class="dpb-list"></div>
          </div>
          <div class="dpb-group">
            <div class="dpb-legend">Plugs</div>
            <div id="dpbPlugs" class="dpb-list"></div>
          </div>
          <div class="dpb-group">
            <div class="dpb-legend">Lights</div>
            <div id="dpbLights" class="dpb-list"></div>
          </div>
        </div>
        <div class="dpb-col dpb-col-wide">
          <div class="dpb-stage">
            <div class="dpb-stage-top">
              <div class="dpb-clock" id="dpbClock">—</div>
              <div class="dpb-rangeInfo" id="dpbRangeInfo">—</div>
            </div>
            <input id="dpbScrub" class="dpb-scrub" type="range" min="0" max="0" value="0" />
          </div>
        </div>
      </div>

      <div class="dpb-row dpb-bottom">
        <div class="dpb-controls">
          <button id="dpbBtnLoad"  class="dpb-btn">Load Day</button>
          <button id="dpbBtnPlay"  class="dpb-btn" disabled>Play</button>
          <button id="dpbBtnPause" class="dpb-btn" disabled>Pause</button>
          <button id="dpbBtnStop"  class="dpb-btn" disabled>Stop</button>
          <div class="dpb-spacer"></div>
          <button id="dpbBtnRec"    class="dpb-btn">Start Recording</button>
          <button id="dpbBtnExport" class="dpb-btn" disabled>Export</button>
          <div id="dpbStatus" class="dpb-status">Idle</div>
        </div>
      </div>
    `;
    return wrap;
  }

  function renderDeviceLists({ sensors, plugs, lights }) {
    const S = $('#dpbSensors'), P = $('#dpbPlugs'), L = $('#dpbLights');
    const primary = getPrimarySensorDevice();

    S.innerHTML = '';
    sensors.forEach(({ dbid, device }) => {
      const id = `sensor_${dbid}`;
      const row = document.createElement('label');
      row.className = 'dpb-item';
      row.innerHTML = `
        <input type="checkbox" id="${id}" data-type="sensor" data-device="${device}" checked />
        <span class="dbid">dbId ${dbid}</span>
        <span class="dev">${device}</span>
        ${device === primary ? '<span class="chip chip-primary">Primary</span>' : ''}
      `;
      S.appendChild(row);
    });

    P.innerHTML = '';
    plugs.forEach(({ dbid, devices }) => {
      const id = `plug_${dbid}`;
      const row = document.createElement('label');
      row.className = 'dpb-item';
      row.innerHTML = `
        <input type="checkbox" id="${id}" data-type="plug" data-devices="${devices.join(',')}" />
        <span class="dbid">dbId ${dbid}</span>
        <span class="dev">${devices.join('  •  ')}</span>
      `;
      P.appendChild(row);
    });

    L.innerHTML = '';
    lights.forEach(({ device, dbids }) => {
      const id = `light_${device}`;
      const row = document.createElement('label');
      row.className = 'dpb-item';
      row.innerHTML = `
        <input type="checkbox" id="${id}" data-type="light" data-device="${device}" />
        <span class="dev">${device}</span>
        <span class="dbid">dbIds: ${dbids.join(', ')}</span>
      `;
      L.appendChild(row);
    });
  }

  function setControlsEnabled(ready) {
    $('#dpbBtnPlay').disabled   = !ready;
    $('#dpbBtnPause').disabled  = !ready;
    $('#dpbBtnStop').disabled   = !ready;
    $('#dpbBtnExport').disabled = !ready;
  }
  function setStatus(t) { const el = $('#dpbStatus'); if (el) el.textContent = t || ''; }

  /* ========== Time + range helpers ========== */
  function pad(n){ return String(n).padStart(2,'0'); }
  function localDateTimeToISO(dateStr, timeStr) {
    const [y,m,d] = dateStr.split('-').map(Number);
    const [hh,mm] = timeStr.split(':').map(Number);
    const dt = new Date(y, m-1, d, hh, mm, 0, 0);
    return dt.toISOString();
  }
  function minutesSpan(startISO, stopISO) {
    return Math.max(0, Math.round((new Date(stopISO) - new Date(startISO)) / 60000));
  }
  function generateMinuteTicks(startISO, stopISO) {
    const ticks = [];
    let t = new Date(startISO).getTime();
    const end = new Date(stopISO).getTime();
    while (t <= end) { ticks.push(t); t += 60_000; }
    return ticks;
  }

  /* ========== /api/series helpers ========== */
  async function fetchSeries(params) {
    const qs = new URLSearchParams({ ...params, _ts: Date.now() });
    const res = await fetch(`/api/series?${qs.toString()}`, { cache: 'no-store' });
    const json = await res.json().catch(()=> ({}));
    if (!res.ok) throw new Error(json?.error || 'Query failed');
    return json;
  }

  // mean fields via aggregateWindow; "last" fields fetched raw then reduced per-minute later
  async function fetchFieldSet({ measurement, device, fieldsMean = [], fieldsLast = [], startISO, stopISO, every = '1m' }) {
    const out = {};

    if (fieldsMean.length) {
      const { series } = await fetchSeries({
        measurement, device,
        fields: fieldsMean.join(','),
        start: startISO, stop: stopISO,
        every
      });
      Object.assign(out, series || {});
    }

    if (fieldsLast.length) {
      const { series } = await fetchSeries({
        measurement, device,
        fields: fieldsLast.join(','),
        start: startISO, stop: stopISO,
        every: 'raw'
      });
      Object.assign(out, series || {});
    }

    return out;
  }

  /* ========== Rasterization (per minute) ========== */
  function rasterizeToMinutes({ ticks, series, lastFields = new Set() }) {
    const sorted = {};
    for (const f of Object.keys(series || {})) {
      sorted[f] = (series[f] || []).slice().sort((a,b)=> new Date(a.t)-new Date(b.t));
    }

    const result = {};
    for (const [field, arr] of Object.entries(sorted)) {
      let i = 0;
      let curVal = null;
      const values = ticks.map(tick => {
        while (i < arr.length && new Date(arr[i].t).getTime() <= tick) {
          curVal = arr[i].v;
          i++;
        }
        return (curVal == null || Number.isNaN(curVal)) ? null : curVal;
      });
      result[field] = values;
    }
    return result;
  }

  /* ========== Build selection from checkboxes ========== */
  function readSelection() {
    const sel = { sensors: [], plugs: [], lights: [] };

    document.querySelectorAll('#dpbSensors input[type="checkbox"]:checked').forEach(cb => {
      const device = cb.getAttribute('data-device');
      if (device) sel.sensors.push(device);
    });

    document.querySelectorAll('#dpbPlugs input[type="checkbox"]:checked').forEach(cb => {
      const devs = (cb.getAttribute('data-devices') || '').split(',').map(s=>s.trim()).filter(Boolean);
      sel.plugs.push(...devs);
    });

    document.querySelectorAll('#dpbLights input[type="checkbox"]:checked').forEach(cb => {
      const device = cb.getAttribute('data-device');
      if (device) sel.lights.push(device);
    });

    sel.sensors = [...new Set(sel.sensors)];
    sel.plugs   = [...new Set(sel.plugs)];
    sel.lights  = [...new Set(sel.lights)];
    return sel;
  }

  /* ========== Playback state ========== */
  const state = {
    ticks: [],       // [ms,...]
    snapshots: [],   // per-minute snapshots
    idx: 0,
    playing: false,
    timer: null,
    speed: 1,
  };

  function stopTimer() { if (state.timer) { clearInterval(state.timer); state.timer = null; } }
  function startTimer() {
    stopTimer();
    const period = Math.max(50, Math.round(1000 / state.speed)); // N× → N ticks/sec
    state.timer = setInterval(stepForward, period);
  }

  function stepForward() {
    if (!state.ticks.length) return;
    if (state.idx >= state.ticks.length) {
      stopTimer();
      state.playing = false;
      emitState();
      setStatus('Finished');
      return;
    }
    renderTick(state.idx);
    state.idx += 1;
  }

  // Dispatch both the frame and the coarse state here
  function renderTick(i) {
    const ts = state.ticks[i];
    const snap = state.snapshots[i];

    // UI clock + scrubber (if popup is open)
    const clock = $('#dpbClock');
    if (clock) clock.textContent = new Date(ts).toLocaleString();
    const scrub = $('#dpbScrub');
    if (scrub) scrub.value = String(i);

    // broadcast to rest of the app (viewer, metrics dock, lights/plug painting, etc.)
    window.dispatchEvent(new CustomEvent('playback:tick', { detail: { ts, snapshot: snap } }));

    emitState();
  }

  function updateScrubUI() {
    const scrub = $('#dpbScrub');
    if (!scrub) return;
    scrub.min = '0';
    scrub.max = String(Math.max(0, state.ticks.length - 1));
    scrub.value = String(Math.min(state.idx, Math.max(0, state.ticks.length - 1)));
  }

  function emitState() {
    const total = state.ticks.length;
    const idx   = Math.max(0, Math.min(state.idx, Math.max(0, total - 1)));
    const ts    = total ? state.ticks[idx] : null;
    const start = total ? state.ticks[0] : null;
    const end   = total ? state.ticks[total - 1] : null;
    window.dispatchEvent(new CustomEvent('playback:state', {
      detail: {
        ready: total > 0,
        playing: !!state.playing,
        idx, total, ts, start, end, speed: state.speed || 1
      }
    }));
  }

  /* ========== Loader (from popup UI) ========== */
  async function loadDay() {
    setControlsEnabled(false);
    setStatus('Loading day…');

    const dateStr  = $('#dpbDate').value;
    const startStr = $('#dpbStart').value;
    const stopStr  = $('#dpbStop').value;
    if (!dateStr || !startStr || !stopStr) { setStatus('Pick date and time window'); return; }

    const startISO = localDateTimeToISO(dateStr, startStr);
    const stopISO  = localDateTimeToISO(dateStr, stopStr);
    const mins = minutesSpan(startISO, stopISO);
    if (mins < 1) { setStatus('Invalid range'); return; }

    $('#dpbRangeInfo').textContent = `${new Date(startISO).toLocaleString()}  →  ${new Date(stopISO).toLocaleString()}`;
    const ticks = generateMinuteTicks(startISO, stopISO);
    const sel = readSelection();

    // fields
    const sensorFieldsMean = ['temp_f','rh_pct','tvoc_ppb','eco2_ppm','light_on_num'];
    const plugFieldsMean   = ['volts','amps','watts'];
    const plugFieldsLast   = ['relay_num','energy_wh','energy_kwh'];
    const lightFieldsLast  = ['light_on_num'];
    const lastFieldSet     = new Set(['relay_num','energy_wh','energy_kwh','light_on_num']);

    // init snapshots
    const snapshots = new Array(ticks.length).fill(null).map(() => ({ sensors:{}, plugs:{}, lights:{} }));

    // sensors
    for (const dev of sel.sensors) {
      const series = await fetchFieldSet({
        measurement: 'env', device: dev,
        fieldsMean: sensorFieldsMean, fieldsLast: [],
        startISO, stopISO, every: '1m'
      });
      const ras = rasterizeToMinutes({ ticks, series, lastFields: new Set() });
      for (let i=0;i<ticks.length;i++){
        (snapshots[i].sensors[dev] ||= {});
        for (const f of Object.keys(ras)) snapshots[i].sensors[dev][f] = ras[f][i];
      }
    }

    // plugs
    for (const dev of sel.plugs) {
      const series = await fetchFieldSet({
        measurement: 'plugData', device: dev,
        fieldsMean: plugFieldsMean, fieldsLast: plugFieldsLast,
        startISO, stopISO, every: '1m'
      });
      const ras = rasterizeToMinutes({ ticks, series, lastFields: lastFieldSet });
      for (let i=0;i<ticks.length;i++){
        (snapshots[i].plugs[dev] ||= {});
        for (const f of Object.keys(ras)) {
          if (f === 'energy_kwh' && ras.energy_wh) continue;
          snapshots[i].plugs[dev][f] = ras[f][i];
        }
        if (snapshots[i].plugs[dev].energy_wh == null && snapshots[i].plugs[dev].energy_kwh != null) {
          const kwh = snapshots[i].plugs[dev].energy_kwh;
          snapshots[i].plugs[dev].energy_wh = (kwh == null) ? null : Number(kwh)*1000;
        }
      }
    }

    // lights
    for (const dev of sel.lights) {
      const series = await fetchFieldSet({
        measurement: 'env', device: dev,
        fieldsMean: [], fieldsLast: lightFieldsLast,
        startISO, stopISO, every: '1m'
      });
      const ras = rasterizeToMinutes({ ticks, series, lastFields: lastFieldSet });
      for (let i=0;i<ticks.length;i++){
        (snapshots[i].lights[dev] ||= {});
        for (const f of Object.keys(ras)) snapshots[i].lights[dev][f] = ras[f][i];
      }
    }

    // finalize
    state.ticks = ticks;
    state.snapshots = snapshots;
    state.idx = 0;
    updateScrubUI();
    const clock = $('#dpbClock');
    if (clock && ticks.length) clock.textContent = new Date(ticks[0]).toLocaleString();
    setControlsEnabled(true);
    setStatus(`Loaded ${ticks.length} minutes • ${sel.sensors.length} sensor(s), ${sel.plugs.length} plug(s), ${sel.lights.length} light source(s).`);
    emitState();
  }

  /* ========== Popup lifecycle (open/controls) ========== */
  function openDayPlaybackPopup() {
    const mask  = $('#popupMask');
    const title = $('#popupTitle');
    const body  = $('#popupBody');
    if (!mask || !title || !body) return;

    title.textContent = 'Day Playback';
    body.innerHTML = '';
    body.appendChild(buildLayout());
    mask.style.display = 'flex';

    // defaults (today 09:00–18:00)
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    $('#dpbDate').value  = `${yyyy}-${mm}-${dd}`;
    $('#dpbStart').value = '09:00';
    $('#dpbStop').value  = '18:00';

    renderDeviceLists(collectDevices());
    setControlsEnabled(false);
    setStatus('Idle — choose date/devices, then Load Day');

    on($('#dpbBtnLoad'),  'click', () => loadDay().catch(e => setStatus(`Load failed: ${e.message||e}`)));
    on($('#dpbBtnPlay'),  'click', () => {
      if (!state.ticks.length) return;
      state.speed = Number($('#dpbSpeed').value || '1') || 1;
      state.playing = true; startTimer(); setStatus(`Playing at ${state.speed}×`); emitState();
    });
    on($('#dpbBtnPause'), 'click', () => { state.playing = false; stopTimer(); setStatus('Paused'); emitState(); });
    on($('#dpbBtnStop'),  'click', () => { state.playing = false; stopTimer(); state.idx = 0; if (state.ticks.length) renderTick(0); setStatus('Stopped'); });

    on($('#dpbSpeed'), 'change', () => {
      state.speed = Number($('#dpbSpeed').value || '1') || 1;
      if (state.playing) startTimer();
      emitState();
    });

    on($('#dpbScrub'), 'input', (e) => {
      const i = Number(e.target.value || '0')|0;
      state.idx = Math.max(0, Math.min(i, state.ticks.length-1));
      renderTick(state.idx);
    });

    on($('#dpbBtnRec'),    'click', () => window.AppToast?.('Recording stub (hook your recorder here)'));
    on($('#dpbBtnExport'), 'click', () => window.AppToast?.('Export stub (CSV / MP4 export can be wired here)'));
  }

  // Hook to open the popup (e.g., from your drawer button)
  //window.addEventListener('open:dayPlayback', openDayPlaybackPopup);

  /* ========== Public control API (for a bottom bar, etc.) ========== */
  function canPlay() { return state.ticks && state.ticks.length > 0; }
  function play()  { if (!canPlay()) return false; state.playing = true; startTimer(); emitState(); return true; }
  function pause() { state.playing = false; stopTimer(); emitState(); }
  function stop()  { state.playing = false; stopTimer(); state.idx = 0; if (canPlay()) renderTick(0); emitState(); }
  function seekToIndex(i) {
    if (!canPlay()) return;
    state.idx = Math.max(0, Math.min(i|0, state.ticks.length - 1));
    renderTick(state.idx);
  }
  // put this INSIDE the IIFE so it can see `state`, `startTimer`, `emitState`
function setSpeed(sp) {
  const s = Number(sp) || 1;
  if (state.speed === s) { emitState(); return; }
  state.speed = s;
  // if currently playing, restart the timer with the new period
  if (state.playing) startTimer();
  emitState();
}


  window.DayPB = {
    async load({ selection, range }) {
      const { startISO, stopISO } = range;
      const ticks = generateMinuteTicks(startISO, stopISO);

      const sensorFieldsMean = ['temp_f','rh_pct','tvoc_ppb','eco2_ppm','light_on_num'];
      const plugFieldsMean   = ['volts','amps','watts'];
      const plugFieldsLast   = ['relay_num','energy_wh','energy_kwh'];
      const lightFieldsLast  = ['light_on_num'];
      const lastFieldSet     = new Set(['relay_num','energy_wh','energy_kwh','light_on_num']);

      const snapshots = new Array(ticks.length).fill(null).map(() => ({ sensors:{}, plugs:{}, lights:{} }));

      for (const dev of (selection.sensors || [])) {
        const series = await fetchFieldSet({ measurement:'env', device:dev, fieldsMean:sensorFieldsMean, fieldsLast:[], startISO, stopISO, every:'1m' });
        const ras = rasterizeToMinutes({ ticks, series, lastFields:new Set() });
        for (let i=0;i<ticks.length;i++){
          (snapshots[i].sensors[dev] ||= {});
          for (const f of Object.keys(ras)) snapshots[i].sensors[dev][f] = ras[f][i];
        }
      }
      for (const dev of (selection.plugs || [])) {
        const series = await fetchFieldSet({ measurement:'plugData', device:dev, fieldsMean:plugFieldsMean, fieldsLast:plugFieldsLast, startISO, stopISO, every:'1m' });
        const ras = rasterizeToMinutes({ ticks, series, lastFields:lastFieldSet });
        for (let i=0;i<ticks.length;i++){
          (snapshots[i].plugs[dev] ||= {});
          for (const f of Object.keys(ras)) {
            if (f === 'energy_kwh' && ras.energy_wh) continue;
            snapshots[i].plugs[dev][f] = ras[f][i];
          }
          if (snapshots[i].plugs[dev].energy_wh == null && snapshots[i].plugs[dev].energy_kwh != null) {
            const kwh = snapshots[i].plugs[dev].energy_kwh;
            snapshots[i].plugs[dev].energy_wh = (kwh == null) ? null : Number(kwh) * 1000;
          }
        }
      }
      for (const dev of (selection.lights || [])) {
        const series = await fetchFieldSet({ measurement:'env', device:dev, fieldsMean:[], fieldsLast:lightFieldsLast, startISO, stopISO, every:'1m' });
        const ras = rasterizeToMinutes({ ticks, series, lastFields:lastFieldSet });
        for (let i=0;i<ticks.length;i++){
          (snapshots[i].lights[dev] ||= {});
          for (const f of Object.keys(ras)) snapshots[i].lights[dev][f] = ras[f][i];
        }
      }

      state.ticks = ticks;
      state.snapshots = snapshots;
      state.idx = 0;
      emitState();
    },

    play, pause, stop,
    seek(index) { seekToIndex(index); },
    setSpeed,    
     exit() {
    stop(); // stops timer and resets idx->0 (your stop() already does this)
    // (No DOM here — UI decides whether to hide the dock.)
  },
    isReady() { return canPlay(); },
    info() {
      const total = state.ticks.length;
      return {
        total, idx: state.idx,
        start: total ? state.ticks[0] : null,
        end:   total ? state.ticks[total - 1] : null
      };
    }
  };
})();

