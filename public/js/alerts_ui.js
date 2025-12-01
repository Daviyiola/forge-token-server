// alerts_ui.js — Alerts popup (3 tabs: Alerts, Alerts List, Create Alert)
// <script type="module" src="/js/alerts_ui.js"></script>

import { ALERTS } from './alerts.js';

const $  = (s, r=document) => r.querySelector(s);
const el = (tag, attrs={}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  kids.flat().forEach(k => {
    if (k == null) return;
    if (typeof k === 'string' || typeof k === 'number') n.appendChild(document.createTextNode(String(k)));
    else n.appendChild(k);
  });
  return n;
};
const btn  = (t, fn, cls='btn') => el('button', { class:cls, onclick:fn }, t);
const chip = (t, cls='chip')   => el('span', { class:cls }, t);

let activeTab    = 'events';  // 'events' | 'defs' | 'builder'
let currentModel = null;
const canEdit    = () => (window.AppAuth?.isAuthed?.() ?? true);

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------
function emptyAlert() {
  return {
    id: null,
    name: '',
    enabled: true,
    severity: 'warn',
    scope: { mode:'any', room:null },  // {mode:'any'} or {mode:'room', room:'WWH015'}
    conditions: [ { mode:'ALL', tests: [] } ],
    holdSec: 30,
    cooldownSec: 300
  };
}

function addDefaultTest(type) {
  if (type === 'occ') return { type:'occ', op:'>=', value:5 };
  return { type:'env', metric:'temp_f', op:'>', value:78 };
}

function envMetricLabel(metric) {
  switch (metric) {
    case 'temp_f':   return 'Temperature (°F)';
    case 'rh_pct':   return 'Humidity (%)';
    case 'tvoc_ppb': return 'TVOC (ppb)';
    case 'eco2_ppm': return 'eCO₂ (ppm)';
    case 'light_on': return 'Light ON (1/0)';
    default:         return metric || 'metric';
  }
}

// ---------------------------------------------------------------------------
// Condition builder
// ---------------------------------------------------------------------------
function testRow(test, onChange, onRemove) {
  const row = el('div', { class:'al-row' });

  const tSel = el('select', {
    onchange: e => {
      const t = e.target.value;
      Object.assign(test, addDefaultTest(t));
      onChange();
    }
  },
    el('option', { value:'env' }, 'Environment'),
    el('option', { value:'occ' }, 'Occupancy')
  );
  tSel.value = test.type || 'env';

  const opSel = el('select', {
    onchange: e => { test.op = e.target.value; onChange(); }
  },
    ...['==','!=','>','>=','<','<=','contains'].map(v =>
      el('option', { value:v }, v)
    )
  );
  opSel.value = test.op || '>=';

  let midA, midB;
  if ((test.type || 'env') === 'env') {
    midA = el('select', {
      onchange: e => { test.metric = e.target.value; onChange(); }
    },
      el('option', { value:'temp_f' },   'Temperature (°F)'),
      el('option', { value:'rh_pct' },   'Humidity (%)'),
      el('option', { value:'tvoc_ppb' }, 'TVOC (ppb)'),
      el('option', { value:'eco2_ppm' }, 'eCO₂ (ppm)'),
      el('option', { value:'light_on' }, 'Light (ON)')
    );
    midA.value = test.metric || 'temp_f';

    midB = el('input', {
      placeholder: 'value',
      value: test.value ?? '',
      oninput: e => {
        const v = e.target.value;
        test.value = v === '' ? '' : (isNaN(Number(v)) ? v : Number(v));
        onChange();
      }
    });
  } else {
    // occupancy
    midA = el('label', { class:'lbl' },
      'Count ≥ ',
      el('input', {
        type:'number',
        value: test.value ?? 5,
        oninput: e => { test.value = Number(e.target.value || 0); onChange(); },
        style:{ width:'80px', marginLeft:'6px' }
      })
    );
    midB = el('label', { class:'lbl' },
      'Stable (secs)',
      el('input', {
        type:'number',
        value: test.debounceSec ?? 10,
        oninput: e => { test.debounceSec = Number(e.target.value || 0); onChange(); },
        style:{ width:'80px', marginLeft:'6px' }
      })
    );
  }

  const del = btn('✕', onRemove, 'btn sm danger');

  row.append(tSel, opSel, midA, midB, del);
  return row;
}

function groupBlock(group, idx, onChange, onRemove) {
  const head = el('div', { class:'al-group-hdr' },
    el('div', { class:'ttl sm' }, `Condition set ${idx + 1}`),
    el('div', { class:'grow' }),
    btn('+ Env', () => { group.tests.push(addDefaultTest('env')); onChange(); }, 'btn sm'),
    btn('+ Occ', () => { group.tests.push(addDefaultTest('occ')); onChange(); }, 'btn sm'),
    btn('Delete', onRemove, 'btn sm danger')
  );

  const rows = el('div', { class:'al-tests' },
    ...(group.tests || []).map((t, i) =>
      testRow(t, onChange, () => { group.tests.splice(i,1); onChange(); })
    )
  );

  return el('div', { class:'al-group' }, head, rows);
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------
function openAlertsUI() {
  const mask = $('#popupMask');
  const body = $('#popupBody');
  const title = $('#popupTitle');
  if (!mask || !body || !title) return;

  title.textContent = 'Alerts';
  mask.style.display = 'flex';
  body.innerHTML = '';

  const authed = canEdit();
  const lockChip = chip(authed ? 'unlocked' : 'locked', 'chip ' + (authed ? 'ok' : 'warn'));

  const tabs = el('div', { class:'al-tabs' },
    btn('Alerts',       () => { activeTab='events';   render(); }, 'tab ' + (activeTab==='events'   ? 'active' : '')),
    btn('Alerts List',  () => { activeTab='defs';     render(); }, 'tab ' + (activeTab==='defs'     ? 'active' : '')),
    btn('Create Alert', () => {
      if (!canEdit()) { window.AppToast?.('Unlock to create alerts', 'error'); return; }
      currentModel = emptyAlert();
      activeTab='builder'; render();
    }, 'tab ' + (activeTab==='builder' ? 'active' : '')),
    el('div', { class:'grow' }),
    lockChip
  );

  body.append(tabs);
  const content = el('div', { id:'alertsContent', style:{ padding:'8px 4px 4px' } });
  body.append(content);

  $('#popupClose').onclick = () => { mask.style.display='none'; };

  render();
  // refresh badge + events when opening
  ALERTS.refreshBadgeCount().catch(()=>{});
}

function render() {
  const root = $('#alertsContent');
  if (!root) return;
  root.innerHTML = '';

  if (activeTab === 'events') renderEventsTab(root);
  else if (activeTab === 'defs') renderDefsTab(root);
  else renderBuilderTab(root, currentModel || emptyAlert());
}

// ---------------------------------------------------------------------------
// Tab: Active alerts (events)
// ---------------------------------------------------------------------------
function renderEventsTab(root) {
  root.innerHTML = '';
  const bar = el('div', { class:'al-toolbar' },
    el('div', { class:'ttl' }, 'Active & Recent Alerts'),
    el('div', { class:'grow' }),
    btn('Refresh', () => renderEventsTab(root), 'btn sm')
  );
  root.append(bar);

  const tableWrap = el('div', { class:'al-table-wrap' }, 'Loading…');
  root.append(tableWrap);

  ALERTS.listEvents({ limit: 200 }).then(items => {
    tableWrap.innerHTML = '';
    if (!items.length) {
      tableWrap.textContent = 'No alerts fired yet.';
      return;
    }

    const tbl = el('table', { class:'al-table' },
      el('thead', {},
        el('tr', {},
          el('th', {}, 'Time'),
          el('th', {}, 'Severity'),
          el('th', {}, 'Alert'),
          el('th', {}, 'Room'),
          el('th', {}, 'Message'),
          el('th', {}, 'Values'),
          el('th', {}, 'Status')
        )
      ),
      el('tbody')
    );

    const tbd = tbl.querySelector('tbody');
    items.forEach(ev => {
      const d = ev.ts ? new Date(ev.ts) : null;
      const when = d ? d.toLocaleString() : ev.tsISO || '—';

      const sevClass = ev.severity === 'crit'
        ? 'chip crit'
        : ev.severity === 'warn'
          ? 'chip warn'
          : 'chip ok';

      const valuesStr = ev.values
        ? Object.entries(ev.values).map(([k,v]) => `${k}: ${v}`).join(', ')
        : '';

      const row = el('tr', {},
        el('td', {}, when),
        el('td', {}, chip(ev.severity || 'warn', sevClass)),
        el('td', {}, ev.name || ''),
        el('td', {}, ev.room || '—'),
        el('td', {}, ev.message || ''),
        el('td', {}, valuesStr),
        el('td', {},
          ev.acked
            ? chip('ack', 'chip sm ok')
            : btn('Ack', async () => {
                if (!canEdit()) { window.AppToast?.('Unlock to ack alerts','error'); return; }
                await ALERTS.ackEvent(ev.id);
                renderEventsTab(root);
              }, 'btn sm')
        )
      );
      tbd.append(row);
    });

    tableWrap.append(tbl);
  }).catch(e => {
    console.error('alerts: events load failed', e);
    tableWrap.textContent = 'Error loading alerts.';
  });
}

// ---------------------------------------------------------------------------
// Tab: Alert definitions
// ---------------------------------------------------------------------------
function renderDefsTab(root) {
  root.innerHTML = '';
  const bar = el('div', { class:'al-toolbar' },
    el('div', { class:'ttl' }, 'Alert Definitions'),
    el('div', { class:'grow' }),
    btn('New alert', () => {
      if (!canEdit()) { window.AppToast?.('Unlock to create alerts', 'error'); return; }
      currentModel = emptyAlert();
      activeTab = 'builder';
      render();
    }, 'btn btnP sm')
  );
  root.append(bar);

  const listWrap = el('div', { style:{ marginTop:'8px' } }, 'Loading…');
  root.append(listWrap);

  ALERTS.list().then(items => {
    listWrap.innerHTML = '';
    if (!items.length) {
      listWrap.textContent = 'No alerts defined yet.';
      return;
    }

    items.forEach(a => {
      const sevChip = chip(a.severity || 'warn', 'chip ' + (
        a.severity === 'crit' ? 'crit' :
        a.severity === 'warn' ? 'warn' : 'ok'
      ));

      const scopeStr = (a.scope && a.scope.mode === 'room')
        ? `Room: ${a.scope.room || '—'}`
        : 'Any room';

      const card = el('div', { class:'al-card' },
        el('div', { class:'al-card-hdr' },
          el('div', { class:'ttl' }, a.name || '(untitled alert)'),
          sevChip,
          chip(a.enabled ? 'enabled' : 'disabled', 'chip sm ' + (a.enabled ? 'ok' : 'warn')),
          chip(scopeStr, 'chip sm'),
          chip(`hold ${a.holdSec ?? 30}s`, 'chip sm'),
          chip(`cooldown ${a.cooldownSec ?? 300}s`, 'chip sm'),
          el('div', { class:'grow' }),
          btn('Edit', () => {
            currentModel = JSON.parse(JSON.stringify(a));
            activeTab = 'builder';
            render();
          }, 'btn sm'),
          btn(a.enabled ? 'Disable' : 'Enable', async () => {
            if (!canEdit()) { window.AppToast?.('Unlock to update alerts','error'); return; }
            await ALERTS.update(a.id, { enabled: !a.enabled });
            renderDefsTab(root);
          }, 'btn sm'),
          btn('Delete', async () => {
            if (!canEdit()) { window.AppToast?.('Unlock to delete alerts','error'); return; }
            if (!confirm(`Delete alert "${a.name}"?`)) return;
            await ALERTS.remove(a.id);
            renderDefsTab(root);
          }, 'btn sm danger')
        ),
        el('div', { class:'al-sub' },
          `Last fired: ${a.lastFiredAt || '—'} • Fires: ${a.fireCount ?? 0}`
        )
      );
      listWrap.append(card);
    });
  }).catch(e => {
    console.error('alerts: list load failed', e);
    listWrap.textContent = 'Error loading alerts.';
  });
}

// ---------------------------------------------------------------------------
// Tab: Create/Edit alert
// ---------------------------------------------------------------------------
function renderBuilderTab(root, model) {
  currentModel = model;
  root.innerHTML = '';

  // guards
  model.conditions = Array.isArray(model.conditions) && model.conditions.length
    ? model.conditions
    : [ { mode:'ALL', tests: [] } ];
  model.scope = model.scope || { mode:'any', room:null };

  const rooms = Array.isArray(window.METRICS?.ROOMS_LIST) ? window.METRICS.ROOMS_LIST : [];

  const hdr = el('div', { class:'al-grid' },
    el('input', {
      placeholder:'Alert name',
      value: model.name || '',
      oninput: e => { model.name = e.target.value; }
    }),
    (() => {
      const l = el('label', { class:'lbl' }, 'Enabled ');
      const cb = el('input', {
        type:'checkbox',
        checked: model.enabled !== false,
        onchange: e => { model.enabled = e.target.checked; }
      });
      l.prepend(cb);
      return l;
    })(),
    (() => {
      const s = el('select', {
        onchange: e => { model.severity = e.target.value; }
      },
        el('option', { value:'info' }, 'Info'),
        el('option', { value:'warn' }, 'Warning'),
        el('option', { value:'crit' }, 'Critical')
      );
      s.value = model.severity || 'warn';
      return el('label', { class:'lbl' }, 'Severity ', s);
    })(),
    (() => {
      const modeSel = el('select', {
        onchange: e => { model.scope.mode = e.target.value; renderBuilderTab(root, model); }
      },
        el('option', { value:'any' }, 'Any room'),
        el('option', { value:'room' }, 'Specific room')
      );
      modeSel.value = model.scope.mode || 'any';

      let roomSel = null;
      if (model.scope.mode === 'room') {
        roomSel = el('select', {
          onchange: e => { model.scope.room = e.target.value || null; }
        },
          el('option', { value:'' }, '(Select room)'),
          ...rooms.map(r => el('option', { value:r }, r))
        );
        roomSel.value = model.scope.room || '';
      }

      return el('div', { class:'al-scope' },
        el('label', { class:'lbl' }, 'Scope ', modeSel),
        roomSel ? el('label', { class:'lbl', style:{marginLeft:'6px'} }, 'Room ', roomSel) : null
      );
    })(),
    el('label', { class:'lbl' }, 'Hold (secs) ',
      el('input', {
        type:'number',
        value: model.holdSec ?? 30,
        oninput: e => { model.holdSec = Number(e.target.value || 0); },
        style:{ width:'90px', marginLeft:'6px' }
      })
    ),
    el('label', { class:'lbl' }, 'Cooldown (secs) ',
      el('input', {
        type:'number',
        value: model.cooldownSec ?? 300,
        oninput: e => { model.cooldownSec = Number(e.target.value || 0); },
        style:{ width:'90px', marginLeft:'6px' }
      })
    )
  );

  const conds = el('div', { class:'al-sec' },
    el('div', { class:'ttl' }, 'Conditions'),
    ...(model.conditions).map((g, i) =>
      groupBlock(g, i,
        () => renderBuilderTab(root, model),
        () => { model.conditions.splice(i,1); renderBuilderTab(root, model); }
      )
    ),
    btn('+ Add another set (OR)', () => {
      model.conditions.push({ mode:'ALL', tests: [] });
      renderBuilderTab(root, model);
    }, 'btn sm')
  );

  const ft = el('div', { class:'al-foot' },
    btn('Cancel', () => { $('#popupMask').style.display='none'; }, 'btn'),
    btn(model.id ? 'Save changes' : 'Create alert', async () => {
      if (!canEdit()) { window.AppToast?.('Unlock to save alerts', 'error'); return; }
      if (!model.name?.trim()) { window.AppToast?.('Name required', 'error'); return; }
      if (!Array.isArray(model.conditions) || !model.conditions.length) {
        window.AppToast?.('Add at least one condition', 'error');
        return;
      }

      try {
        if (model.id) {
          await ALERTS.update(model.id, model);
        } else {
          await ALERTS.create(model);
        }
        activeTab = 'defs';
        render();
      } catch (e) {
        console.error('alerts: save failed', e);
        window.AppToast?.('Failed to save alert', 'error');
      }
    }, 'btn btnP')
  );

  root.append(hdr, conds, ft);
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
const style = document.createElement('style');
style.textContent = `
.al-tabs{display:flex;gap:8px;border-bottom:1px solid #222;margin-bottom:8px;padding-bottom:6px;align-items:center;}
.tab{padding:6px 12px;border-radius:8px 8px 0 0;cursor:pointer;}
.tab.active{background:#13344a;color:#bfe0ff;}
.al-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:6px;}
.al-card{border:1px solid #222;border-radius:12px;padding:10px;margin:8px 0;background:#121212;}
.al-card-hdr{display:flex;align-items:center;gap:8px;}
.al-sub{font-size:12px;opacity:.85;margin-top:4px;}
.al-grid{display:grid;grid-template-columns:1.4fr auto auto auto auto auto;gap:10px;align-items:center;margin-bottom:8px;}
.al-sec{margin-top:12px;}
.al-row{display:grid;grid-template-columns:1.0fr 0.7fr 1.8fr 1.4fr auto;gap:10px;align-items:center;margin:6px 0;}
.al-group{border:1px solid #333;background:#1a1a1a;border-radius:10px;padding:8px;margin:6px 0;}
.al-group-hdr{display:flex;align-items:center;gap:8px;margin-bottom:6px;}
.al-tests{margin-top:4px;}
.al-foot{display:flex;gap:10px;justify-content:flex-end;margin-top:14px;}
.al-table-wrap{margin-top:8px;max-height:52vh;overflow:auto;}
.al-table{width:100%;border-collapse:collapse;font-size:13px;}
.al-table th,.al-table td{border-bottom:1px solid #222;padding:4px 6px;text-align:left;}
.al-table th{position:sticky;top:0;background:#111;}
.chip.sm{font-size:11px;padding:2px 6px;}
.chip.ok{background:#133a22;color:#c9ffd7;}
.chip.warn{background:#4a3513;color:#ffe2b9;}
.chip.crit{background:#4a1313;color:#ffc9c9;}
.btn.sm{font-size:12px;padding:3px 8px;}
.btn.danger{background:#3a1a1a;}
.lbl{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}
.al-scope{display:flex;align-items:center;}
.grow{flex:1;}
`;
document.head.append(style);

// ---------------------------------------------------------------------------
// Wiring: open from menu / nav
// ---------------------------------------------------------------------------
window.openAlerts = () => window.dispatchEvent(new Event('open:alerts'));

window.addEventListener('open:alerts', () => {
  activeTab = 'events';
  currentModel = null;
  openAlertsUI();
});
