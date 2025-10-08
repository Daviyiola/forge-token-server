// plug_metrics.js — live plug telemetry (power + relay) + viewer theming + menu info

const PLUGS = (() => {
  // ---- CONFIG ----
  // dbId -> [deviceIds]; supports multiple devices per dbId (sum watts, toggle all)
  const DBID_TO_DEVICES = new Map([
    [2244, ['dtn-12e7df', 'dtn-12b2e2']],
    [2245, ['dtn-aa5abc', 'dtn-12a08e']],
    [2226, ['dtn-127dd3', 'dtn-12717a']],
    // add more as needed
  ]);
  const STALE_MS = 30_000;

  // --- Colors (Vector4 for theming)
  const COLOR_GRAY   = new THREE.Vector4(0.55, 0.55, 0.55, 1.0);
  const COLOR_YELLOW = new THREE.Vector4(0.96, 0.80, 0.28, 1.0);
  const COLOR_GREEN  = new THREE.Vector4(0.35, 0.78, 0.45, 1.0);

  // topic helpers
  const topicPower = dev => `dt/dt-lab/${dev}/sensor/power/state`;
  const topicRelay = dev => `dt/dt-lab/${dev}/switch/relay/state`;
  const cmdRelay   = dev => `${dev}/switch/relay/command`; // publish (no dt/dt-lab prefix)

  // reverse index: device -> [dbIds]
  const DEVICE_TO_DBIDS = new Map();
  for (const [dbId, devs] of DBID_TO_DEVICES) {
    devs.forEach(d => {
      const arr = DEVICE_TO_DBIDS.get(d) || [];
      if (!arr.includes(dbId)) arr.push(dbId);
      DEVICE_TO_DBIDS.set(d, arr);
    });
  }

  // ---- State: latest sample per device ----
  // { watts:number|null, relay:'ON'|'OFF'|null, ts_ms:number }
  const latest = new Map();

  // ---- Utils ----
  function toMs(x) {
    const n = Number(x);
    if (!Number.isFinite(n) || n <= 0) return Date.now();
    if (n < 1e10) return n * 1000;   // seconds -> ms
    if (n > 1e15) return Date.now(); // garbage protection
    return n;
  }
  function secsAgo(ms) { return Math.max(0, Math.floor((Date.now() - ms) / 1000)); }

  // Theming
  function setColor(dbId, vec4) {
    const v = (typeof window.getViewer === 'function') ? window.getViewer() : null;
    if (!v || !v.model) return;
    if (v.setThemingColor) v.setThemingColor(dbId, vec4, v.model, true);
    else if (v.model.setThemingColor) v.model.setThemingColor(dbId, vec4, true);
    v.impl.sceneUpdated(true);
  }
  function colorFromWatts(w) {
    if (w == null || w < 1) return COLOR_GRAY;
    if (w <= 20) return COLOR_YELLOW;
    return COLOR_GREEN;
  }

  // Compute merged watts & freshness for a dbId (summing all devices mapped)
  function mergedForDbId(dbId) {
    const devs = DBID_TO_DEVICES.get(dbId) || [];
    let sumW = 0, any = false, newest = 0, anyRelay = null;
    devs.forEach(dev => {
      const row = latest.get(dev);
      if (row) {
        if (typeof row.watts === 'number') { sumW += row.watts; any = true; }
        newest = Math.max(newest, row.ts_ms || 0);
        if (row.relay) anyRelay = row.relay;
      }
    });
    return {
      watts: any ? sumW : null,
      relay: anyRelay,
      ts_ms: newest || null,
      stale: newest ? (Date.now() - newest) > STALE_MS : true,
    };
  }

  // Apply colors to every mapped dbId continuously
  function paintAll() {
    for (const dbId of DBID_TO_DEVICES.keys()) {
      const { watts } = mergedForDbId(dbId);
      setColor(dbId, colorFromWatts(watts));
    }
  }

  // ---- Selection menu renderer (called by viewer.js) ----
function renderSelectionInfo(container, dbId) {
  const refresh = () => {
    const { watts, ts_ms, stale, relay } = mergedForDbId(dbId);

    const wTxt = (typeof watts === 'number')
      ? `${watts.toFixed(1)} W`   // e.g. "14.0 W"
      : '—';
    const rTxt = relay ?? '—';
    const age  = ts_ms ? `${secsAgo(ts_ms)}s` : '—';

    // color dot from watts thresholds
    const dotColor = (watts == null || watts < 1) ? '#8b8b8b' : (watts <= 20 ? '#f5c542' : '#27b065');

    container.innerHTML = `
      <span style="width:8px;height:8px;border-radius:999px;display:inline-block;background:${dotColor};
                   box-shadow: inset 0 0 0 2px rgba(255,255,255,.08);"></span>
      <span style="font:700 12px/1 system-ui,sans-serif;padding:4px 8px;border-radius:10px;background:#1a1a1a;border:1px solid #2a2a2a;">${wTxt}</span>
      <span style="font:700 12px/1 system-ui,sans-serif;padding:4px 8px;border-radius:10px;background:#1a1a1a;border:1px solid #2a2a2a;">${rTxt}</span>
      <span style="font:700 12px/1 system-ui,sans-serif;padding:4px 8px;border-radius:10px;background:#1a1a1a;border:1px solid ${stale ? '#705d1a' : '#2a2a2a'};color:${stale ? '#f5c542' : 'inherit'};">${age}</span>
    `;
  };

  container.style.cssText = 'display:flex;gap:8px;align-items:center;margin:6px 0 2px;';
  refresh();
  const t = setInterval(refresh, 1000);
  const obs = new MutationObserver(() => {
    if (!document.body.contains(container)) { clearInterval(t); obs.disconnect(); }
  });
  obs.observe(document.body, { childList: true, subtree: true });
}



  // ---- Commands (no auth gate yet) ----
  function publish(dev, value) {
    if (!window.MQTT_CLIENT) return console.warn('[PLUGS] no MQTT client to publish');
    window.MQTT_CLIENT.publish(cmdRelay(dev), value, { qos: 1 }, (e) => {
      if (e) console.warn('[PLUGS] publish error', e);
    });
  }
  function toggleRelay(dbId, on) {
  const doPublish = () => {
    const devs = DBID_TO_DEVICES.get(dbId) || [];
    devs.forEach(dev => publish(dev, on ? 'ON' : 'OFF'));
    window.AppToast?.(`Sent ${on ? 'ON' : 'OFF'}`, 'ok');
  };
  if (window.AppAuth?.requireAuthThen) return window.AppAuth.requireAuthThen(doPublish);
  // fallback (if auth not loaded)
  doPublish();
}


  // ---- MQTT wiring ----
  function ensureMqttClient() {
    if (window.MQTT_CLIENT) return Promise.resolve(window.MQTT_CLIENT);
    return fetch('/api/mqtt/config')
      .then(r => r.json())
      .then(cfg => {
        if (!cfg?.ok) throw new Error('Bad mqtt config');
        let { url, username, password } = cfg;
        // normalize to WSS
        try {
          const u = new URL(url);
          if (u.protocol === 'mqtt:' || u.protocol === 'mqtts:') {
            u.protocol = 'wss:';
            if (!u.port) u.port = '8884';
            if (!u.pathname || u.pathname === '/') u.pathname = '/mqtt';
            url = u.toString();
          }
        } catch {
          url = `wss://${String(url).replace(/^mqt+t?s?:\/\//i, '').replace(/\/+$/,'')}:8884/mqtt`;
        }
        const clientId = 'web_' + Math.random().toString(16).slice(2);
        const client = mqtt.connect(url, {
          clientId, username, password,
          clean: true, connectTimeout: 15000, keepalive: 30,
          protocolVersion: 4, reconnectPeriod: 4000
        });
        window.MQTT_CLIENT = client;
        return new Promise(resolve => {
          client.on('connect', () => resolve(client));
        });
      });
  }

  function subscribeDevices(client) {
    // subscribe once per device for power+relay
    const subs = [];
    for (const dev of DEVICE_TO_DBIDS.keys()) {
      subs.push(topicPower(dev), topicRelay(dev));
    }
    subs.forEach(tp => client.subscribe(tp, { qos: 1 }, (err) => {
      if (err) console.warn('[PLUGS] subscribe error', tp, err);
    }));

    client.on('message', (topic, payload) => {
      // match power
      const mPower = topic.match(/^dt\/dt-lab\/([^/]+)\/sensor\/power\/state$/);
      const mRelay = topic.match(/^dt\/dt-lab\/([^/]+)\/switch\/relay\/state$/);
      if (!mPower && !mRelay) return;
      const dev = (mPower || mRelay)[1];

      let row = latest.get(dev) || { watts: null, relay: null, ts_ms: 0 };
      if (mPower) {
        const w = Number(payload.toString());
        if (Number.isFinite(w)) row.watts = w;
        row.ts_ms = Date.now();
      } else if (mRelay) {
        const s = String(payload.toString()).trim().toUpperCase();
        row.relay = (s === 'ON' || s === 'OFF') ? s : row.relay;
        row.ts_ms = Date.now();
      }
      latest.set(dev, row);

      // repaint all mapped dbIds when any plug message arrives
      paintAll();
    });

    // staleness repaint
    setInterval(paintAll, 5_000);
  }

  // boot
  ensureMqttClient().then(subscribeDevices).then(() => {
    // initial paint (gray until data)
    paintAll();
  });

  // public API
    // public API
  const api = {
    renderSelectionInfo,
    toggleRelay,
    DBID_TO_DEVICES,   // <— expose your map here
    DEVICE_TO_DBIDS    // (handy if needed elsewhere)
  };
  window.PLUGS = api;  // also attach to window here
  return api;
})();
export default window.PLUGS;
