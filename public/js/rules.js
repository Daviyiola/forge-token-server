// rules.js — rules engine + MQTT + Firebase REST bridge

const RULES = (() => {
  const API_BASE = '/api/rules';

  let _rules = [];
  let _loadedOnce = false;

  // Live telemetry state
  const envByDevice = new Map();   // deviceId -> { temp_f, rh_pct, tvoc_ppb, eco2_ppm, light_on, ts_ms }
  const occByRoom   = new Map();   // roomName -> { count, ts_ms }
  const relayByDev  = new Map();   // plug deviceId -> { relay:'ON'|'OFF', ts_ms }

  /* ---------- Room / sensor helpers from METRICS ---------- */

  function getRoomToDeviceMap() {
    const m = window.METRICS;
    if (!m) return new Map();

    // Preferred: from app_metrics hard-coded maps
    if (m.ROOM_TO_DEVICE instanceof Map) return m.ROOM_TO_DEVICE;

    if (m.DEVICE_TO_ROOM instanceof Map) {
      const mp = new Map();
      m.DEVICE_TO_ROOM.forEach((room, dev) => {
        if (!room || !dev) return;
        if (!mp.has(room)) mp.set(room, dev);
      });
      m.ROOM_TO_DEVICE = mp;
      return mp;
    }

    // Fallback: derive from DBID maps if present
    if (m.DBID_TO_ROOM && m.DBID_TO_DEVICE &&
        typeof m.DBID_TO_ROOM.forEach === 'function' &&
        typeof m.DBID_TO_DEVICE.get === 'function') {
      const mp = new Map();
      m.DBID_TO_ROOM.forEach((room, dbId) => {
        if (!room) return;
        const dev = m.DBID_TO_DEVICE.get(dbId);
        if (!dev) return;
        if (!mp.has(room)) mp.set(room, dev);
      });
      m.ROOM_TO_DEVICE = mp;
      return mp;
    }

    return new Map();
  }

  function getRoomsList() {
    const m = window.METRICS;
    if (Array.isArray(m?.ROOMS_LIST)) return m.ROOMS_LIST.slice();
    const mp = getRoomToDeviceMap();
    return Array.from(mp.keys()).sort();
  }

  /* ---------- REST helpers ---------- */

  async function list() {
    const res = await fetch(API_BASE);
    if (!res.ok) throw new Error('rules list failed');
    const data = await res.json();
    _rules = Array.isArray(data.items) ? data.items : [];
    _loadedOnce = true;
    window.dispatchEvent(new CustomEvent('rules:updated', { detail: _rules }));
    return _rules;
  }

  async function create(model) {
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(model),
    });
    if (!res.ok) throw new Error('rules create failed');
    const data = await res.json();
    await list();
    return data;
  }

  async function update(id, patch) {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw new Error('rules update failed');
    const data = await res.json();
    await list();
    return data;
  }

  async function remove(id) {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    });
    if (!res.ok) throw new Error('rules delete failed');
    await list();
  }

  // Logs (optional; if server does not have these, UI will just show an error)
  async function fetchLogs(id, limit = 50) {
    const res = await fetch(`${API_BASE}/${encodeURIComponent(id)}/logs?limit=${limit}`);
    if (!res.ok) throw new Error('logs fetch failed');
    const data = await res.json();
    return Array.isArray(data.items) ? data.items : [];
  }

  async function logFire(rule, actionsApplied) {
    try {
      await fetch(`${API_BASE}/${encodeURIComponent(rule.id)}/logs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          at: new Date().toISOString(),
          summary: `${rule.name || rule.id} fired; actions: ${actionsApplied.length}`,
          actions: actionsApplied
        })
      });
    } catch (e) {
      console.warn('[RULES] logFire failed', e);
    }
  }

  /* ---------- MQTT wiring ---------- */

    let mqttClient = null;

  function ensureMqttClient() {
    // Reuse cached client if we already have one
    if (mqttClient) return Promise.resolve(mqttClient);

    // Reuse global client if another module created it
    if (window.MQTT_CLIENT) {
      mqttClient = window.MQTT_CLIENT;
      return Promise.resolve(mqttClient);
    }

    // Otherwise create our own, same pattern as plug_metrics / light_metrics
    return fetch('/api/mqtt/config')
      .then(r => r.json())
      .then(cfg => {
        if (!cfg?.ok) throw new Error('Bad mqtt config');
        let { url, username, password } = cfg;

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
          clean: true,
          connectTimeout: 15000,
          keepalive: 30,
          protocolVersion: 4,
          reconnectPeriod: 4000
        });

        mqttClient = client;
        if (!window.MQTT_CLIENT) window.MQTT_CLIENT = client;

        return new Promise(resolve => {
          client.on('connect', () => {
            console.log('[RULES] MQTT connected');
            resolve(client);
          });
        });
      });
  }

  function publishRelayCommand(deviceId, command) {
  if (window.PLUGS && typeof window.PLUGS.sendCommand === 'function') {
    console.log('[RULES] via PLUGS.sendCommand', deviceId, command);
    window.PLUGS.sendCommand(deviceId, command);
    return;
  }

  if (!mqttClient) {
    console.warn('[RULES] no mqtt client');
    return;
  }

  const topic = `${deviceId}/switch/relay/command`;   // THE ONLY VALID COMMAND TOPIC
  const payload = command === 'ON' ? 'ON' : 'OFF';

  console.log('[RULES] publish', topic, payload);
  mqttClient.publish(topic, payload, { qos: 1, retain: false });
}


  function toMs(x) {
    const n = typeof x === 'string' ? parseInt(x, 10) : x;
    if (!Number.isFinite(n)) return Date.now();
    return (n >= 1e12) ? n : n * 1000;
  }

  function wireMqtt(client) {
    if (!client) return;

    // Sensor env snapshots
    client.subscribe('dt/dt-lab/+/telemetry', { qos: 0 }, () => {});
    // Room occupancy
    client.subscribe('dt/dt-lab/+/count', { qos: 0 }, () => {});
    // Plug relay state
    client.subscribe('dt/dt-lab/+/switch/relay/state', { qos: 0 }, () => {});

    client.on('message', (topic, payload) => {
      // env sensors
      let m = topic.match(/^dt\/dt-lab\/([^/]+)\/telemetry$/);
      if (m) {
        const dev = m[1];
        let obj = null;
        try { obj = JSON.parse(payload.toString()); } catch { return; }
        const ts = toMs(obj.ts_ms ?? obj.ts ?? Date.now());
        envByDevice.set(dev, {
          temp_f:   obj.temp_f   != null ? Number(obj.temp_f)   : null,
          rh_pct:   obj.rh_pct   != null ? Number(obj.rh_pct)   : null,
          tvoc_ppb: obj.tvoc_ppb != null ? Number(obj.tvoc_ppb) : null,
          eco2_ppm: obj.eco2_ppm != null ? Number(obj.eco2_ppm) : null,
          light_on: typeof obj.light_on !== 'undefined' ? !!obj.light_on : null,
          ts_ms: ts
        });
        return;
      }

      // occupancy
      m = topic.match(/^dt\/dt-lab\/([^/]+)\/count$/);
      if (m) {
        let obj = null;
        try { obj = JSON.parse(payload.toString()); } catch { return; }
        if (!obj || typeof obj.room !== 'string') return;
        const room = obj.room;
        const count = Number(obj.count);
        if (!Number.isFinite(count)) return;
        const ts = toMs(obj.t ?? Date.now());
        occByRoom.set(room, { count, ts_ms: ts });
        return;
      }

      // plug relay state
      m = topic.match(/^dt\/dt-lab\/([^/]+)\/switch\/relay\/state$/);
      if (m) {
        const dev = m[1];
        const s = String(payload.toString()).trim().toUpperCase();
        const relay = (s === 'ON' || s === 'OFF') ? s : null;
        if (!relay) return;
        relayByDev.set(dev, { relay, ts_ms: Date.now() });
      }
    });
  }

  ensureMqttClient().then(wireMqtt).catch(e => {
    console.warn('[RULES] MQTT bootstrap failed', e);
  });

  /* ---------- Evaluators ---------- */

  function cmp(val, op, target) {
    if (val == null || target == null) return false;
    const a = Number(val), b = Number(target);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
    switch (op) {
      case '==': return a === b;
      case '!=': return a !== b;
      case '>':  return a >  b;
      case '>=': return a >= b;
      case '<':  return a <  b;
      case '<=': return a <= b;
      default:   return false;
    }
  }

  function evalEnvTest(t) {
    const metric   = t.metric || 'temp_f';
    const roomName = t.roomName || null;
    let dev = null;

    if (roomName) {
      const map = getRoomToDeviceMap();
      dev = map.get(roomName) || null;
    } else {
      // fall back to primary sensor device (as you already store)
      try {
        const cached = localStorage.getItem('primary_sensor_device');
        if (cached) dev = cached;
      } catch {}
    }
    if (!dev) return false;

    const row = envByDevice.get(dev);
    if (!row) return false;

    let val = null;
    if (metric === 'temp_f')   val = row.temp_f;
    if (metric === 'rh_pct')   val = row.rh_pct;
    if (metric === 'tvoc_ppb') val = row.tvoc_ppb;
    if (metric === 'eco2_ppm') val = row.eco2_ppm;
    if (metric === 'light_on') val = row.light_on ? 1 : 0;

    return cmp(val, t.op || '>=', t.value);
  }

  function evalOccTest(t) {
    const room = t.roomName || window.METRICS?.primaryRoomName || null;
    if (!room) return false;
    const row = occByRoom.get(room);
    if (!row) return false;
    const now = Date.now();
    const debounceSec = Number(t.debounceSec || 0);
    if (debounceSec > 0 && (now - row.ts_ms) < debounceSec * 1000) {
      // not stable long enough
      return false;
    }
    return cmp(row.count, t.op || '>=', t.value);
  }

  // time based with per-day semantics + repeat every N days
  function evalTimeTest(t) {
    if (!t.startAtIso) return false;
    const base = new Date(t.startAtIso);
    if (!base || isNaN(base.getTime())) return false;

    const repeatDays = Math.max(1, Number(t.repeatDays || 1));
    const now = new Date();

    const dayMs = 24 * 3600 * 1000;
    const baseDate = new Date(base.getFullYear(), base.getMonth(), base.getDate());
    const todayDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.floor((todayDate - baseDate) / dayMs);

    if (diffDays < 0) return false;              // not yet started
    if (diffDays % repeatDays !== 0) return false; // today is not an active repeat day

    const threshold = new Date(
      todayDate.getFullYear(),
      todayDate.getMonth(),
      todayDate.getDate(),
      base.getHours(),
      base.getMinutes(),
      0, 0
    );

    const nowMs = now.getTime();
    const thrMs = threshold.getTime();
    const endOfDayMs = todayDate.getTime() + dayMs - 1;

    const op = t.op || '==';

    switch (op) {
      case '==':
        // within ±1 min
        return Math.abs(nowMs - thrMs) <= 60 * 1000;
      case '!=':
        return Math.abs(nowMs - thrMs) > 60 * 1000;
      case '>':
        // from threshold until end of that same day
        return nowMs > thrMs && nowMs <= endOfDayMs;
      case '>=':
        return nowMs >= thrMs && nowMs <= endOfDayMs;
      case '<':
        return nowMs < thrMs;
      case '<=':
        return nowMs <= thrMs;
      default:
        return false;
    }
  }

  function evalTest(t) {
    if (!t || !t.type) return false;
    if (t.type === 'env')  return evalEnvTest(t);
    if (t.type === 'occ')  return evalOccTest(t);
    if (t.type === 'time') return evalTimeTest(t);
    return false;
  }

  function evalRuleConditions(rule) {
    const groups = Array.isArray(rule.conditions?.groups)
      ? rule.conditions.groups
      : [];
    if (!groups.length) return false;

    // groups OR’ed together
    for (const g of groups) {
      const tests = Array.isArray(g.tests) ? g.tests : [];
      if (!tests.length) continue;

      if (g.mode === 'ANY') {
        if (tests.some(evalTest)) return true;
      } else {
        if (tests.every(evalTest)) return true;
      }
    }
    return false;
  }

  /* ---------- Firing and cooldown (with plug state check) ---------- */

  const localLastFire = new Map(); // ruleId -> ms

  function desiredRelayForAction(a) {
    if (!a || a.type !== 'plug') return null;
    const cmd = String(a.command || '').toUpperCase();
    if (cmd !== 'ON' && cmd !== 'OFF') return null;
    return cmd;
  }

  function currentRelayForDevice(dev) {
    const row = relayByDev.get(dev);
    return row ? row.relay : null;
  }

  async function tick() {
    if (!_loadedOnce) {
      try { await list(); } catch (e) { console.warn('[RULES] list failed', e); }
    }
    if (!_rules.length) return;

    const now = Date.now();

    for (const rule of _rules) {
      if (!rule.enabled) continue;

      const last = localLastFire.get(rule.id) || 0;
      const cooldownMs = Math.max(0, Number(rule.cooldownSec || 0)) * 1000;
      if (cooldownMs && (now - last) < cooldownMs) continue;

      const condOk = evalRuleConditions(rule);
      if (!condOk) continue;

      const actions = Array.isArray(rule.actions) ? rule.actions : [];
      const applied = [];

      for (const a of actions) {
        if (!a || !a.type) continue;

        if (a.type === 'plug') {
          const targetRelay = desiredRelayForAction(a);
          if (!targetRelay) continue;
          const dev = a.deviceId;
          if (!dev) continue;

          const cur = currentRelayForDevice(dev);
          if (cur != null && cur === targetRelay) {
          console.log('[RULES] skip plug, already', targetRelay, dev);
          continue;
        }
        
          publishRelayCommand(dev, targetRelay);
          applied.push({ type: 'plug', deviceId: dev, command: targetRelay });
        } else if (a.type === 'topic') {
          if (!mqttClient) continue;
          if (!a.topic) continue;
          const payload = a.payload ?? '';
          mqttClient.publish(a.topic, String(payload), { qos: 1 });
          applied.push({ type: 'topic', topic: a.topic });
        }
      }

      if (applied.length) {
        localLastFire.set(rule.id, now);
        update(rule.id, {
          lastFiredAt: new Date().toISOString(),
          fireCount: Number(rule.fireCount || 0) + 1
        }).catch(() => {});
        logFire(rule, applied).catch(() => {});
      }
    }
  }

  setInterval(tick, 3_000);

  /* ---------- UI bridge ---------- */

  function openUI(filter) {
    window.dispatchEvent(new CustomEvent('open:rules', { detail: filter || null }));
  }

  function canCreate() {
    if (window.AppAuth && typeof window.AppAuth.isUnlocked !== 'undefined') {
      return !!window.AppAuth.isUnlocked;
    }
    return true;
  }

  const api = {
    list, create, update, remove,
    fetchLogs,
    tick,
    openUI,
    getRoomsList,
    canCreate
  };

  window.RULES = api;
  return api;
})();

export default window.RULES;
