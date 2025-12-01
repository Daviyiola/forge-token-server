// plug_metrics.js — live plug telemetry (power + relay) + playback coloring + viewer theming

const PLUGS = (() => {
  /* =========================
   * Config (maps)
   * ========================= */
  // dbId -> [deviceIds]; supports multiple devices per dbId (sum watts, toggle all)
  const DBID_TO_DEVICES = new Map([
    [2263, ['dtn-1244ef']],
    [2265, ['dtn-127bed']],
    [2185, ['dtn-12ff32']],
    [2249, ['dtn-1271c6']],
    [2231, ['dtn-aa4802']],
    [2232, ['dtn-aa641b']],
    [2214, ['dtn-12fa99']],
    [2193, ['dtn-aa5abc']],
    [2254, ['dtn-12b2e2']],
    [2237, ['dtn-12e7df']],
    [2218, ['dtn-127dd3']],
    [2219, ['dtn-12717a']],
    [2267, ['dtn-12a08e']],
    // add more as needed
  ]);

  // reverse index: deviceId -> [dbIds]
  const DEVICE_TO_DBIDS = new Map();
  for (const [dbId, devs] of DBID_TO_DEVICES) {
    devs.forEach(d => {
      const arr = DEVICE_TO_DBIDS.get(d) || [];
      if (!arr.includes(dbId)) arr.push(dbId);
      DEVICE_TO_DBIDS.set(d, arr);
    });
  }

  const STALE_MS = 30_000;

  /* =========================
   * Colors / Viewer helpers
   * ========================= */
  const COLOR_GRAY   = new THREE.Vector4(0.55, 0.55, 0.55, 1.0);
  const COLOR_YELLOW = new THREE.Vector4(0.96, 0.80, 0.28, 1.0);
  const COLOR_GREEN  = new THREE.Vector4(0.35, 0.78, 0.45, 1.0);

  function getViewer() {
    return (typeof window.getViewer === 'function') ? window.getViewer() : null;
  }
  function setColor(dbId, vec4) {
    const v = getViewer();
    if (!v || !v.model) return;
    if (v.setThemingColor) v.setThemingColor(dbId, vec4, v.model, true);
    else if (v.model.setThemingColor) v.model.setThemingColor(dbId, vec4, true);
    v.impl.sceneUpdated(true);
  }
  function colorFromWatts(w) {
    if (w == null || w < 1) return COLOR_GRAY;
    if (w <= 25) return COLOR_YELLOW;
    return COLOR_GREEN;
  }

  /* =========================
   * Live state (MQTT)
   * ========================= */
  // latest per device: { watts:number|null, relay:'ON'|'OFF'|null, ts_ms:number }
  const latest = new Map();

  const topicPower = dev => `dt/dt-lab/${dev}/sensor/power/state`;
  const topicRelay = dev => `dt/dt-lab/${dev}/switch/relay/state`;
  const cmdRelay   = dev => `${dev}/switch/relay/command`; // broker expects this bare topic

  function secsAgo(ms) { return Math.max(0, Math.floor((Date.now() - ms) / 1000)); }

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

  function paintAllLive() {
    for (const dbId of DBID_TO_DEVICES.keys()) {
      const { watts } = mergedForDbId(dbId);
      setColor(dbId, colorFromWatts(watts));
    }
  }

  /* =========================
   * Playback bridge
   * ========================= */
  let playbackMode = false;   // prefer snapshots when true
  let lastPB = null;          // last playback snapshot
  let pbGuard = null;         // timeout to fall back to live

  function enterPlaybackMode() {
    playbackMode = true;
    if (pbGuard) clearTimeout(pbGuard);
    // If no more ticks in 3s, drop back to live
    pbGuard = setTimeout(() => { playbackMode = false; lastPB = null; paintAllLive(); }, 3000);
  }

  function paintFromSnapshot(snapshot) {
    if (!snapshot || !snapshot.plugs) return;
    for (const [dbId, devs] of DBID_TO_DEVICES) {
      let sumW = 0, any = false;
      for (const dev of devs) {
        const row = snapshot.plugs[dev];
        if (row && typeof row.watts === 'number') {
          sumW += row.watts;
          any = true;
        }
      }
      const watts = any ? sumW : null;
      setColor(dbId, colorFromWatts(watts));
    }
  }

  function paintSmart() {
    if (playbackMode && lastPB) paintFromSnapshot(lastPB);
    else paintAllLive();
  }

  // Listen for day-playback events
  window.addEventListener('playback:tick', (ev) => {
    lastPB = ev?.detail?.snapshot || null;
    enterPlaybackMode();
    paintSmart();
  });

  window.addEventListener('playback:state', (ev) => {
    const d = ev?.detail || {};
    // If playback not ready or ended, revert to live
    if (!d.ready || (!d.playing && d.idx >= (d.total - 1))) {
      playbackMode = false;
      lastPB = null;
      paintAllLive();
    }
  });

  /* =========================
   * Selection info strip (viewer menu)
   * ========================= */
  function renderSelectionInfo(container, dbId) {
    const refresh = () => {
      // Prefer snapshot display if in playback mode
      if (playbackMode && lastPB) {
        const devs = DBID_TO_DEVICES.get(dbId) || [];
        let sumW = 0, any = false;
        devs.forEach(dev => {
          const row = lastPB.plugs?.[dev];
          if (row && typeof row.watts === 'number') { sumW += row.watts; any = true; }
        });
        const watts = any ? sumW : null;
        const dotColor = (watts == null || watts < 1) ? '#8b8b8b' : (watts <= 25 ? '#f5c542' : '#27b065');
        container.innerHTML = `
          <span style="width:8px;height:8px;border-radius:999px;display:inline-block;background:${dotColor};
                       box-shadow: inset 0 0 0 2px rgba(255,255,255,.08);"></span>
          <span style="font:700 12px/1 system-ui,sans-serif;padding:4px 8px;border-radius:10px;background:#1a1a1a;border:1px solid #2a2a2a;">
            ${typeof watts === 'number' ? watts.toFixed(1)+' W' : '—'}
          </span>
          <span style="font:700 12px/1 system-ui,sans-serif;padding:4px 8px;border-radius:10px;background:#1a1a1a;border:1px solid #2a2a2a;">
            Playback
          </span>
        `;
        return;
      }

      // Live
      const { watts, ts_ms, stale, relay } = mergedForDbId(dbId);
      const dotColor = (watts == null || watts < 1) ? '#8b8b8b' : (watts <= 25 ? '#f5c542' : '#27b065');
      const age  = ts_ms ? `${secsAgo(ts_ms)}s` : '—';
      container.innerHTML = `
        <span style="width:8px;height:8px;border-radius:999px;display:inline-block;background:${dotColor};
                     box-shadow: inset 0 0 0 2px rgba(255,255,255,.08);"></span>
        <span style="font:700 12px/1 system-ui,sans-serif;padding:4px 8px;border-radius:10px;background:#1a1a1a;border:1px solid #2a2a2a;">
          ${typeof watts === 'number' ? watts.toFixed(1)+' W' : '—'}
        </span>
        <span style="font:700 12px/1 system-ui,sans-serif;padding:4px 8px;border-radius:10px;background:#1a1a1a;border:1px solid #2a2a2a;">
          ${relay ?? '—'}
        </span>
        <span style="font:700 12px/1 system-ui,sans-serif;padding:4px 8px;border-radius:10px;background:#1a1a1a;
                     border:1px solid ${stale ? '#705d1a' : '#2a2a2a'};color:${stale ? '#f5c542' : 'inherit'};">
          ${age}
        </span>
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

  /* =========================
   * Commands
   * ========================= */
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
    doPublish();
  }

  /* =========================
   * MQTT wiring
   * ========================= */
  function ensureMqttClient() {
    if (window.MQTT_CLIENT) return Promise.resolve(window.MQTT_CLIENT);
    return fetch('/api/mqtt/config')
      .then(r => r.json())
      .then(cfg => {
        if (!cfg?.ok) throw new Error('Bad mqtt config');
        let { url, username, password } = cfg;
        // normalize mqtt[s]:// to wss://
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
        return new Promise(resolve => client.on('connect', () => resolve(client)));
      });
  }

  function subscribeDevices(client) {
    // Subscribe per device for power + relay
    const subs = [];
    for (const dev of DEVICE_TO_DBIDS.keys()) subs.push(topicPower(dev), topicRelay(dev));
    subs.forEach(tp => client.subscribe(tp, { qos: 1 }, (err) => {
      if (err) console.warn('[PLUGS] subscribe error', tp, err);
    }));

    client.on('message', (topic, payload) => {
      const mPower = topic.match(/^dt\/dt-lab\/([^/]+)\/sensor\/power\/state$/);
      const mRelay = topic.match(/^dt\/dt-lab\/([^/]+)\/switch\/relay\/state$/);
      if (!mPower && !mRelay) return;

      const dev = (mPower || mRelay)[1];
      const now = Date.now();
      let row = latest.get(dev) || { watts: null, relay: null, ts_ms: 0 };

      if (mPower) {
        const w = Number(payload.toString());
        if (Number.isFinite(w)) row.watts = w;
        row.ts_ms = now;
      } else if (mRelay) {
        const s = String(payload.toString()).trim().toUpperCase();
        row.relay = (s === 'ON' || s === 'OFF') ? s : row.relay;
        row.ts_ms = now;
      }

      latest.set(dev, row);
      paintSmart();
    });

    // Periodic repaint for staleness / idle state
    setInterval(paintSmart, 5_000);
  }

  // Boot
  ensureMqttClient().then(subscribeDevices).then(() => paintSmart());

  /* =========================
   * Public API
   * ========================= */
  const api = {
    renderSelectionInfo,
    toggleRelay,
    DBID_TO_DEVICES,
    DEVICE_TO_DBIDS
  };

  window.PLUGS = api;
  return api;
})();

export default window.PLUGS;
