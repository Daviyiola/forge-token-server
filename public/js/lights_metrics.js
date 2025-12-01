// lights_metrics.js — live "light_on" theming + playback coloring + inline selection info

const LIGHTS = (() => {
  /* =========================
   * Config (maps)
   * ========================= */
  // deviceId -> [dbIds]
  const DEVICE_TO_DBIDS = new Map([
    ['dtn-e41358088304', [2394, 2396, 2395, 2392, 2390, 2393]],
    ['dtn-d0bdbf0b65f4', [2961, 2962, 2963, 2964, 2965, 2966]],
    ['dtn-a01cbf0b65f4', [3078, 3079, 3080, 3081, 3082, 3083]],
    // add more as needed
  ]);

  // reverse index: dbId -> [deviceIds]
  const DBID_TO_DEVICES = new Map();
  for (const [dev, ids] of DEVICE_TO_DBIDS) {
    ids.forEach(dbId => {
      const arr = DBID_TO_DEVICES.get(dbId) || [];
      if (!arr.includes(dev)) arr.push(dev);
      DBID_TO_DEVICES.set(dbId, arr);
    });
  }

  const STALE_MS = 30_000;

  /* =========================
   * Colors
   * ========================= */
  const COLOR_ON  = new THREE.Vector4(0.97, 0.88, 0.73, 1.0); // warm "on"
  const COLOR_OFF = null; // clear theming to default model look

  /* =========================
   * State
   * ========================= */
  // Live MQTT latest: device -> { on:boolean|null, ts_ms:number }
  const live = new Map();

  // Playback override (if active): device -> { on:boolean|null }
  let playbackActive = false;
  const playback = new Map();

  /* =========================
   * Utils
   * ========================= */
  function toMs(x) {
    const n = Number(x);
    if (!Number.isFinite(n) || n <= 0) return Date.now();
    const ms = (n < 1e10) ? n * 1000 : n;
    const MIN_OK = Date.UTC(2010, 0, 1);
    const MAX_FUTURE = Date.now() + 7 * 864e5;
    if (ms < MIN_OK || ms > MAX_FUTURE) return Date.now();
    return ms;
  }
  function secsAgo(ms) { return Math.max(0, Math.floor((Date.now() - ms) / 1000)); }

  function getV() { return (typeof window.getViewer === 'function') ? window.getViewer() : null; }
  function setColor(dbId, vec4) {
    const v = getV(); if (!v || !v.model) return;
    if (vec4 === null) {
      if (typeof v.clearThemingColor === 'function') v.clearThemingColor(dbId);
      else if (v.model?.clearThemingColor) v.model.clearThemingColor(dbId);
      else v.setThemingColor?.(dbId, new THREE.Vector4(0.55,0.55,0.55,0.0001), v.model, true);
    } else {
      if (v.setThemingColor) v.setThemingColor(dbId, vec4, v.model, true);
      else v.model?.setThemingColor?.(dbId, vec4, true);
    }
    v.impl.sceneUpdated(true);
  }

  /* =========================
   * Painting (chooses playback if active)
   * ========================= */
  function isOnForDevice(dev) {
    if (playbackActive) {
      const p = playback.get(dev);
      if (p) return !!p.on;
      // if no snapshot for this dev, treat as OFF
      return false;
    }
    const row = live.get(dev);
    return row?.on === true;
  }

  function paintAll() {
    for (const [dev, ids] of DEVICE_TO_DBIDS) {
      const on = isOnForDevice(dev);
      ids.forEach(dbId => setColor(dbId, on ? COLOR_ON : COLOR_OFF));
    }
  }

  /* =========================
   * UI: inline selection info chip
   * ========================= */
  function renderSelectionInfo(container, dbId) {
    const devices = DBID_TO_DEVICES.get(dbId) || [];
    const refresh = () => {
      let on = false, newest = 0, stale = true;

      if (playbackActive) {
        // If multiple devices map to this dbId, ON if any is on in the snapshot
        on = devices.some(d => playback.get(d)?.on === true);
        // No meaningful “age” in playback; show pause/playing via your dock instead
        newest = Date.now();
        stale = false;
      } else {
        devices.forEach(d => {
          const row = live.get(d);
          if (!row) return;
          if (row.on === true) on = true;
          newest = Math.max(newest, row.ts_ms || 0);
        });
        if (newest) stale = (Date.now() - newest) > STALE_MS;
      }

      const dot = document.createElement('span');
      dot.style.cssText = `
        width:8px;height:8px;border-radius:999px;display:inline-block;
        box-shadow: inset 0 0 0 2px rgba(255,255,255,.08);
        background:${on ? '#f5cf68' : '#666'};
      `;

      const pill = (txt) => {
        const s = document.createElement('span');
        s.textContent = txt;
        s.style.cssText = 'font:600 12px/1 system-ui,sans-serif;padding:4px 8px;border-radius:10px;background:#1a1a1a;border:1px solid #2a2a2a;';
        return s;
      };

      const ageTxt = playbackActive ? 'playback' : (newest ? `${secsAgo(newest)}s` : '—');

      container.innerHTML = '';
      container.style.cssText = 'display:flex;gap:8px;align-items:center;margin:6px 0 2px;';
      container.appendChild(dot);
      container.appendChild(pill(on ? 'ON' : 'OFF'));
      const age = pill(ageTxt);
      if (!playbackActive && stale) { age.style.borderColor = '#705d1a'; age.style.color = '#f5c542'; }
      container.appendChild(age);
    };

    refresh();
    const t = setInterval(refresh, 1000);
    const obs = new MutationObserver(() => {
      if (!document.body.contains(container)) { clearInterval(t); obs.disconnect(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  /* =========================
   * Playback bridge
   * ========================= */
  // Update the per-device playback state from a frame
  function applyPlaybackFrame(snap) {
    // snap.lights is { deviceId: { light_on_num: 0|1|null } }
    playback.clear();
    if (snap && snap.lights) {
      for (const [dev, obj] of Object.entries(snap.lights)) {
        const v = (obj?.light_on_num);
        playback.set(dev, { on: v != null && Number(v) > 0.5 });
      }
    }
  }

  window.addEventListener('playback:tick', (ev) => {
    if (!playbackActive) return;
    applyPlaybackFrame(ev.detail?.snapshot || {});
    paintAll();
  });

  window.addEventListener('playback:state', (ev) => {
    const d = ev.detail || {};
    // prefer snapshots whenever playback “ready” (a range is loaded)
    playbackActive = !!d.ready;
    if (!playbackActive) playback.clear();
    // repaint immediately (switching modes)
    paintAll();
  });

  /* =========================
   * Live MQTT wiring
   * ========================= */
  function ensureMqttClient() {
    if (window.MQTT_CLIENT) return Promise.resolve(window.MQTT_CLIENT);
    return fetch('/api/mqtt/config').then(r => r.json()).then(cfg => {
      if (!cfg?.ok) throw new Error('Bad mqtt config');
      let { url, username, password } = cfg;
      try {
        const u = new URL(url);
        if (u.protocol === 'mqtt:' || u.protocol === 'mqtts:') {
          u.protocol = 'wss:'; if (!u.port) u.port = '8884'; if (!u.pathname || u.pathname === '/') u.pathname = '/mqtt';
          url = u.toString();
        }
      } catch {
        url = `wss://${String(url).replace(/^mqt+t?s?:\/\//i,'').replace(/\/+$/,'')}:8884/mqtt`;
      }
      const clientId = 'web_' + Math.random().toString(16).slice(2);
      const client = mqtt.connect(url, {
        clientId, username, password, clean: true,
        connectTimeout: 15000, keepalive: 30, protocolVersion: 4, reconnectPeriod: 4000
      });
      window.MQTT_CLIENT = client;
      return new Promise(resolve => client.on('connect', () => resolve(client)));
    });
  }

  function subscribeDevices(client) {
    // Subscribe to dt/dt-lab/<device>/telemetry for all devices in the map
    const topics = Array.from(DEVICE_TO_DBIDS.keys()).map(d => `dt/dt-lab/${d}/telemetry`);
    topics.forEach(tp => client.subscribe(tp, { qos: 0 }, (err) => {
      if (err) console.warn('[LIGHTS] subscribe error', tp, err);
    }));

    client.on('message', (topic, payload) => {
      // Ignore live updates if we’re in playback mode, but still keep “live” fresh in the background
      const m = topic.match(/^dt\/dt-lab\/([^/]+)\/telemetry$/);
      if (!m) return;
      const dev = m[1];
      let obj = null;
      try { obj = JSON.parse(payload.toString()); } catch {}
      if (!obj || typeof obj.light_on === 'undefined') return;
      const on = (obj.light_on === true || String(obj.light_on).toLowerCase() === 'true');
      const ts = toMs(obj.ts_ms ?? obj.ts ?? Date.now());
      live.set(dev, { on, ts_ms: ts });
      if (!playbackActive) paintAll();
    });

    // periodic repaint to catch staleness
    setInterval(() => { if (!playbackActive) paintAll(); }, 5000);
  }

  ensureMqttClient().then(subscribeDevices).then(() => paintAll());

  /* =========================
   * Public API
   * ========================= */
  const api = {
    renderSelectionInfo,
    DEVICE_TO_DBIDS,  // used by day_playback_ui to list lights
    DBID_TO_DEVICES,  // handy for selection info, etc.
  };
  window.LIGHTS = api;
  return api;
})();

export default window.LIGHTS;
