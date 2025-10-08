// lights_metrics.js — live "light_on" theming + inline selection info (no commands)

const LIGHTS = (() => {
  // --- CONFIG: device -> [dbIds] (1 sensor can drive multiple elements)
  const DEVICE_TO_DBIDS = new Map([
    ['dtn-e41358088304', [2394, 2396, 2399, 2397, 2398, 2400]],   // <-- example; add your real mappings here
    // ['another-device', [DBID_A, DBID_B]],
  ]);
  const STALE_MS = 30_000;

  // --- Colors
  const COLOR_ON  = new THREE.Vector4(0.97, 0.88, 0.73, 1.0); // warm "on"
  const COLOR_OFF = null; // we'll clear theming color to show default model look

  // Build reverse index (dbId -> [deviceIds]) in case you need it later
  const DBID_TO_DEVICES = new Map();
  for (const [dev, ids] of DEVICE_TO_DBIDS) {
    ids.forEach(dbId => {
      const arr = DBID_TO_DEVICES.get(dbId) || [];
      if (!arr.includes(dev)) arr.push(dev);
      DBID_TO_DEVICES.set(dbId, arr);
    });
  }

  // --- state per device { on:boolean|null, ts_ms:number }
  const latest = new Map();

  // --- utils
  function toMs(x) {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  // seconds → ms
  const ms = (n < 1e10) ? n * 1000 : n;

  // guardrails
  const MIN_OK = Date.UTC(2010, 0, 1);        // Jan 1, 2010
  const MAX_FUTURE = Date.now() + 7 * 864e5;  // 7 days ahead
  if (ms < MIN_OK || ms > MAX_FUTURE) return Date.now();
  return ms;
}

  function secsAgo(ms) { return Math.max(0, Math.floor((Date.now() - ms) / 1000)); }

  // Theming helpers
  function getV() { return (typeof window.getViewer === 'function') ? window.getViewer() : null; }
  function setColor(dbId, vec4) {
    const v = getV(); if (!v || !v.model) return;
    if (vec4 === null) {
      if (typeof v.clearThemingColor === 'function') v.clearThemingColor(dbId);
      else if (v.model?.clearThemingColor) v.model.clearThemingColor(dbId);
      else { /* fallback: set a very mild neutral */ v.setThemingColor?.(dbId, new THREE.Vector4(0.55,0.55,0.55,0.0001), v.model, true); }
    } else {
      if (v.setThemingColor) v.setThemingColor(dbId, vec4, v.model, true);
      else v.model?.setThemingColor?.(dbId, vec4, true);
    }
    v.impl.sceneUpdated(true);
  }

  // Paint all mapped dbIds from latest device states
  function paintAll() {
    for (const [dev, ids] of DEVICE_TO_DBIDS) {
      const row = latest.get(dev);
      const on = row?.on === true;
      ids.forEach(dbId => setColor(dbId, on ? COLOR_ON : COLOR_OFF));
    }
  }

  // Inline selection strip: “● ON • 3s”
  function renderSelectionInfo(container, dbId) {
    const devices = DBID_TO_DEVICES.get(dbId) || [];
    const refresh = () => {
      // If multiple devices map to one dbId (rare here), consider ON if any is on
      let on = false, newest = 0, stale = true;
      devices.forEach(d => {
        const row = latest.get(d);
        if (!row) return;
        if (row.on === true) on = true;
        newest = Math.max(newest, row.ts_ms || 0);
      });
      if (newest) stale = (Date.now() - newest) > STALE_MS;

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

      const ageTxt = newest ? `${secsAgo(newest)}s` : '—';

      container.innerHTML = '';
      container.style.cssText = 'display:flex;gap:8px;align-items:center;margin:6px 0 2px;';
      container.appendChild(dot);
      container.appendChild(pill(on ? 'ON' : 'OFF'));
      const age = pill(ageTxt);
      if (stale) age.style.borderColor = '#705d1a', age.style.color = '#f5c542';
      container.appendChild(age);
    };

    refresh();
    const t = setInterval(refresh, 1000);
    const obs = new MutationObserver(() => {
      if (!document.body.contains(container)) { clearInterval(t); obs.disconnect(); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // MQTT
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
      const m = topic.match(/^dt\/dt-lab\/([^/]+)\/telemetry$/);
      if (!m) return;
      const dev = m[1];
      let obj = null;
      try { obj = JSON.parse(payload.toString()); } catch {}
      if (!obj || typeof obj.light_on === 'undefined') return;
      const on = (obj.light_on === true || String(obj.light_on).toLowerCase() === 'true');
      const ts = toMs(obj.ts_ms ?? obj.ts ?? Date.now());
      latest.set(dev, { on, ts_ms: ts });
      paintAll();
    });

    // staleness repaint
    setInterval(paintAll, 5000);
  }

  // boot
  ensureMqttClient().then(subscribeDevices).then(() => paintAll());

  // public api
  // public api
  const api = { renderSelectionInfo, DEVICE_TO_DBIDS};
  window.LIGHTS = api;
  return api;
})();
export default window.LIGHTS;
