// alerts.js — client-side alert engine (Option A: grouped conditions)
// <script type="module" src="/js/alerts.js"></script>

export const ALERTS = (() => {
  const state = {
    loaded: false,
    items: [],           // alert definitions
    envByRoom: new Map(),// roomName -> { ts, fields:{ temp_f, rh_pct, ... } }
    occByRoom: new Map(),// roomName -> { ts, count }
    breaches: new Map(), // key: `${alertId}::${roomName}` -> { breachStart, lastFireTs, breached }
    lastTick: 0,
    tickMs: 2000,        // evaluate every ~2s
    badgeCount: 0
  };

  const log = (...args) => {
    // console.debug('[ALERTS]', ...args);
  };

  const authHeaders = () => {
    // If you have auth token header logic, plug it in here.
    // For now this is just JSON header.
    return {
      'Content-Type': 'application/json'
    };
  };

  async function apiGet(path) {
    const res = await fetch(path, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
    return res.json();
  }

  async function apiPut(path, body) {
    const res = await fetch(path, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`PUT ${path} failed: ${res.status}`);
    return res.json();
  }

  async function apiDelete(path) {
    const res = await fetch(path, {
      method: 'DELETE',
      headers: authHeaders()
    });
    if (!res.ok) throw new Error(`DELETE ${path} failed: ${res.status}`);
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // Alert definitions CRUD
  // ---------------------------------------------------------------------------
  async function list() {
    const data = await apiGet('/api/alerts');
    const items = data.items || [];
    state.items = items;
    state.loaded = true;
    window.dispatchEvent(new CustomEvent('alerts:updated', { detail: items }));
    return items;
  }

  async function create(model) {
    const payload = sanitizeModel(model);
    const data = await apiPost('/api/alerts', payload);
    await list();
    return data;
  }

  async function update(id, patch) {
    const data = await apiPut(`/api/alerts/${encodeURIComponent(id)}`, patch);
    await list();
    return data;
  }

  async function remove(id) {
    await apiDelete(`/api/alerts/${encodeURIComponent(id)}`);
    await list();
  }

  function sanitizeModel(m) {
    const copy = JSON.parse(JSON.stringify(m || {}));
    copy.conditions = Array.isArray(copy.conditions) ? copy.conditions : [];
    copy.scope = copy.scope || { mode: 'any' };
    copy.holdSec = Number(copy.holdSec ?? 30);
    copy.cooldownSec = Number(copy.cooldownSec ?? 300);
    copy.severity = copy.severity || 'warn';
    copy.enabled = copy.enabled !== false;
    return copy;
  }

  // ---------------------------------------------------------------------------
  // Events (fired alerts) + badge
  // ---------------------------------------------------------------------------
  async function listEvents({ limit = 200, severity = null, onlyOpen = false } = {}) {
    const params = new URLSearchParams();
    if (limit) params.set('limit', String(limit));
    if (severity) params.set('severity', severity);
    if (onlyOpen) params.set('onlyOpen', '1');

    const data = await apiGet(`/api/alerts/events?${params.toString()}`);
    return data.items || [];
  }

  async function ackEvent(id) {
    await apiPost(`/api/alerts/events/${encodeURIComponent(id)}/ack`, {});
    // refresh badge count after ack
    await refreshBadgeCount();
  }

  async function refreshBadgeCount() {
    try {
      const items = await listEvents({ limit: 200, onlyOpen: true });
      const c = items.length;
      state.badgeCount = c;
      const badge = document.getElementById('navAlertsBadge');
      if (badge) badge.textContent = c > 0 ? String(c) : '';

      window.dispatchEvent(new CustomEvent('alerts:badge', { detail: c }));
    } catch (e) {
      console.warn('alerts:badge refresh failed', e);
    }
  }

  async function fireEvent({ alert, roomName, values, message }) {
    try {
      const body = {
        alertId: alert.id,
        name: alert.name,
        severity: alert.severity || 'warn',
        room: roomName || null,
        message: message || '',
        values: values || {}
      };
      await apiPost('/api/alerts/events', body);
      // refresh badge & defs metadata
      refreshBadgeCount();
      list().catch(()=>{});
    } catch (e) {
      console.error('alerts: fireEvent failed', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Live ingestion from sensors
  // These are called by your telemetry pipeline (env + occupancy)
  // ---------------------------------------------------------------------------
  function ingestEnv(sample) {
    // sample: { roomName, fields:{temp_f, rh_pct, tvoc_ppb, eco2_ppm, light_on}, ts }
    if (!sample || !sample.roomName) return;
    const r = sample.roomName;
    state.envByRoom.set(r, {
      ts: sample.ts || Date.now(),
      fields: sample.fields || {}
    });
    scheduleTick();
  }

  function ingestOcc(sample) {
    // sample: { roomName, count, ts }
    if (!sample || !sample.roomName) return;
    const r = sample.roomName;
    state.occByRoom.set(r, {
      ts: sample.ts || Date.now(),
      count: Number(sample.count || 0)
    });
    scheduleTick();
  }

  // ---------------------------------------------------------------------------
  // Evaluation
  // Alert conditions (Option A: groups of tests)
  // ---------------------------------------------------------------------------
  function scheduleTick() {
    const now = Date.now();
    if (now - state.lastTick < state.tickMs * 0.5) return; // avoid spam
    state.lastTick = now;
    setTimeout(tick, state.tickMs);
  }

  async function tick() {
    if (!state.loaded) {
      try { await list(); } catch(e) { console.warn('alerts: list failed', e); }
    }

    const alerts = state.items || [];
    if (!alerts.length) return;

    const allRooms = new Set([
      ...state.envByRoom.keys(),
      ...state.occByRoom.keys()
    ]);

    const now = Date.now();

    for (const alert of alerts) {
      if (!alert.enabled) continue;

      const groups = Array.isArray(alert.conditions) ? alert.conditions : [];
      if (!groups.length) continue;

      const scope = alert.scope || { mode: 'any' };
      let rooms = [];
      if (scope.mode === 'room' && scope.room) {
        rooms = [scope.room];
      } else {
        rooms = Array.from(allRooms);
      }
      if (!rooms.length) continue;

      for (const roomName of rooms) {
        if (!roomName) continue;
        const key = `${alert.id}::${roomName}`;
        let st = state.breaches.get(key) || {
          breachStart: null,
          lastFireTs: 0,
          breached: false
        };

        const nowFields = state.envByRoom.get(roomName)?.fields || {};
        const nowOcc = state.occByRoom.get(roomName)?.count ?? null;

        const groupMatch = groups.some(g => evalGroup(g, nowFields, nowOcc));
        const holdMs = (alert.holdSec ?? 30) * 1000;
        const cooldownMs = (alert.cooldownSec ?? 300) * 1000;

        if (groupMatch) {
          if (!st.breachStart) {
            st.breachStart = now;
          }
          const elapsed = now - st.breachStart;
          if (!st.breached && elapsed >= holdMs) {
            const sinceLast = now - (st.lastFireTs || 0);
            if (!st.lastFireTs || sinceLast >= cooldownMs) {
              // FIRE
              st.breached = true;
              st.lastFireTs = now;
              const msg = buildMessage(alert, roomName, groups, nowFields, nowOcc);
              const values = Object.assign({}, nowFields);
              if (nowOcc != null) values.count = nowOcc;
              fireEvent({ alert, roomName, values, message: msg });
              log('Alert fired', alert.name, 'room', roomName, values);
            }
          }
        } else {
          // reset breach
          st.breached = false;
          st.breachStart = null;
        }

        state.breaches.set(key, st);
      }
    }
  }

  function evalGroup(group, fields, occCount) {
    if (!group || !Array.isArray(group.tests) || !group.tests.length) return false;
    // For simplicity: all tests must pass within a group (AND).
    // Multiple groups are OR'ed at alert level.
    return group.tests.every(t => evalTest(t, fields, occCount));
  }

  function evalTest(test, fields, occCount) {
    if (!test) return false;
    const type = test.type || 'env';
    const op = test.op || '>';
    let actual;

    if (type === 'occ') {
      actual = occCount;
      if (actual == null) return false;
    } else {
      const metric = test.metric || 'temp_f';
      actual = fields[metric];
      if (actual == null) return false;
    }

    const want = test.value;
    return compare(actual, op, want);
  }

  function compare(actual, op, want) {
    if (op === 'contains') {
      return String(actual).includes(String(want));
    }

    const a = Number(actual);
    const b = Number(want);
    const numOk = !Number.isNaN(a) && !Number.isNaN(b);

    if (!numOk) {
      const sa = String(actual);
      const sb = String(want);
      switch (op) {
        case '==': return sa === sb;
        case '!=': return sa !== sb;
        default: return false;
      }
    }

    switch (op) {
      case '==': return a === b;
      case '!=': return a !== b;
      case '>':  return a > b;
      case '>=': return a >= b;
      case '<':  return a < b;
      case '<=': return a <= b;
      default:   return false;
    }
  }

  function buildMessage(alert, roomName, groups, fields, occCount) {
    const pieces = [];
    if (fields.temp_f != null) pieces.push(`temp ${fields.temp_f}°F`);
    if (fields.rh_pct != null) pieces.push(`RH ${fields.rh_pct}%`);
    if (fields.tvoc_ppb != null) pieces.push(`TVOC ${fields.tvoc_ppb} ppb`);
    if (fields.eco2_ppm != null) pieces.push(`eCO₂ ${fields.eco2_ppm} ppm`);
    if (occCount != null) pieces.push(`count ${occCount}`);
    const vals = pieces.join(', ');
    return `Alert "${alert.name}" triggered in ${roomName}${vals ? ` — ${vals}` : ''}`;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  const api = {
    list,
    create,
    update,
    remove,
    listEvents,
    ackEvent,
    refreshBadgeCount,
    ingestEnv,
    ingestOcc,
    tick
  };

  // Expose on window and return
  window.ALERTS = api;
  return api;
})();
