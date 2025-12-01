// rules_ui.js — two-tab Rules UI (list + builder), with room column
// <script type="module" src="/js/rules_ui.js"></script>

import RULES from './rules.js';

const $  = (s, r=document) => r.querySelector(s);
const el = (tag, attrs={}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'style') Object.assign(n.style, v);
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  kids.flat().forEach(k => { if (k != null) n.append(k); });
  return n;
};
const btn  = (t, fn, cls='btn') => el('button', { class:cls, onclick:fn }, t);
const chip = (t) => el('span', { class:'chip' }, t);

// Use RULES.canCreate if available, else fall back to AppAuth
const canCreate = () => (RULES.canCreate ? RULES.canCreate() : (window.AppAuth?.isUnlocked ?? true));

let activeTab    = 'list';
let currentModel = null;
let currentFilter = null;

// ---------- base structure
function emptyRule() {
  return {
    name: '',
    enabled: true,
    priority: 100,
    cooldownSec: 30,
    conditions: { groups: [ { mode:'ALL', tests: [] } ] },
    actions: [ { type:'plug', deviceId:'', command:'ON' } ]
  };
}

// ---------- time helpers
function isoToLocalDatetimeValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function localDatetimeValueToIso(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------- test & group blocks (no parent refs)
function addDefaultTest(type) {
  if (type === 'env') return { type, roomName:null, metric:'temp_f', op:'>',   value:78 };
  if (type === 'occ') return { type, roomName:null, op:'>=', value:3, debounceSec:20 };
  if (type === 'time') {
    const d = new Date();
    d.setMinutes(Math.ceil(d.getMinutes()/10)*10, 0, 0);
    return { type:'time', roomName:null, op:'>=', startAtIso: d.toISOString(), repeatDays: 1 };
  }
  return { type:'env', roomName:null, metric:'temp_f', op:'>', value:78 };
}

function testRow(test, onChange, onRemove) {
  const row = el('div', { class:'ru-row' });

  // 1) Rule category
  const tSel = el('select', {
    onchange:e=>{
      Object.assign(test, addDefaultTest(e.target.value));
      onChange();
    }
  },
    el('option',{value:'env'}, 'Environment'),
    el('option',{value:'occ'}, 'Occupancy'),
    el('option',{value:'time'},'Time')
  );
  tSel.value = test.type || 'env';

  // 2) Room dropdown (for env + occ; optional for time)
  const rooms = RULES.getRoomsList ? RULES.getRoomsList() : [];
  const roomSel = el('select', {
    onchange:e=>{
      const v = e.target.value;
      test.roomName = v || null;
      onChange();
    }
  },
    el('option',{value:''},'(Primary room)')
  );
  rooms.forEach(r => roomSel.append(el('option',{value:r}, r)));
  roomSel.value = test.roomName || '';

  // 3) Operator
  const opSel = el('select', {
    onchange:e=>{ test.op = e.target.value; onChange(); }
  },
    ...['==','!=','>','>=','<','<='].map(v => el('option',{value:v}, v))
  );
  opSel.value = test.op || '>=';

  // 4–5) Type-specific controls
  let midA, midB;
  if (test.type === 'env') {
    midA = el('select',{
      onchange:e=>{ test.metric = e.target.value; onChange(); }
    },
      el('option',{value:'temp_f'},  'Temperature (°F)'),
      el('option',{value:'rh_pct'},  'Humidity (%)'),
      el('option',{value:'tvoc_ppb'},'TVOC (ppb)'),
      el('option',{value:'eco2_ppm'},'eCO₂ (ppm)'),
      el('option',{value:'light_on'},'Light (ON/OFF)')
    );
    midA.value = test.metric || 'temp_f';

    midB = el('input',{
      placeholder:'value',
      value:test.value ?? '',
      oninput:e=>{
        const v = e.target.value;
        test.value = v === '' ? '' : (isNaN(Number(v)) ? v : Number(v));
        onChange();
      }
    });
  }
  else if (test.type === 'occ') {
    // Occupancy threshold
    midA = el('input', {
      type: 'number',
      placeholder: 'count',
      value: test.value ?? 0,
      oninput: e => {
        test.value = Number(e.target.value || 0);
        onChange();
      }
    });

    // Stability duration
    const stab = el('input', {
      type: 'number',
      placeholder: 'seconds',
      value: test.debounceSec ?? 20,
      oninput: e => {
        test.debounceSec = Number(e.target.value || 0);
        onChange();
      },
      style: { width:'90px' }
    });
    midB = el('div', { class:'ru-flex' },
      el('label', { class:'lbl', style:{whiteSpace:'nowrap'} }, 'Stable (secs)'),
      stab
    );
  }
  else if (test.type === 'time') {
    // Date & time (local)
    const dt = el('input', {
      type: 'datetime-local',
      value: isoToLocalDatetimeValue(test.startAtIso),
      onchange: e => {
        test.startAtIso = localDatetimeValueToIso(e.target.value);
        onChange();
      }
    });
    dt.style.width = '100%';
    midA = dt;

    // Repeat every N days
    const repeat = el('input', {
      type: 'number', min:'1', step:'1',
      value: Number(test.repeatDays ?? 1),
      oninput: e => {
        test.repeatDays = Math.max(1, Number(e.target.value || 1));
        onChange();
      },
      style: { width:'90px' }
    });
    midB = el('label', { class:'lbl' }, 'Repeat ', repeat, ' (days)');
  }

  const del = btn('✕', onRemove, 'btn danger sm');

  // Columns: type | room | op | midA | midB | delete
  row.append(tSel, roomSel, opSel, midA, midB, del);
  return row;
}

function groupBlock(g, idx, onChange, onRemove) {
  const head = el('div',{class:'ru-group-hdr'},
    el('div',{class:'ttl sm'},`Condition set ${idx+1}`),
    el('div',{class:'grow'}),
    btn('+ Env', ()=>{ g.tests.push(addDefaultTest('env'));  onChange(); }, 'btn sm'),
    btn('+ Occ', ()=>{ g.tests.push(addDefaultTest('occ'));  onChange(); }, 'btn sm'),
    btn('+ Time',()=>{ g.tests.push(addDefaultTest('time')); onChange(); }, 'btn sm'),
    btn('Delete', onRemove, 'btn sm danger')
  );

  const rows = el('div',{class:'ru-tests'},
    ...(g.tests||[]).map((t,i)=>
      testRow(t, onChange, ()=>{ g.tests.splice(i,1); onChange(); })
    )
  );
  return el('div',{class:'ru-group'}, head, rows);
}

// ---------- actions UI
function actionRow(a, onChange, onRemove) {
  // Prefer RULES.listLivePlugs if available (handles 30s TTL), else fallback to PLUGS
  const live = RULES.listLivePlugs
    ? RULES.listLivePlugs()
    : (() => {
        const devMap = window.PLUGS?.DEVICE_TO_DBIDS;
        const arr = [];
        if (devMap instanceof Map) {
          Array.from(devMap.keys()).sort().forEach(dev => {
            const dbIds = devMap.get(dev) || [];
            const label = dbIds.length
              ? `${dev} (dbId ${dbIds.join(',')})`
              : dev;
            arr.push({ deviceId: dev, label });
          });
        }
        return arr;
      })();

  const tSel = el('select', {
    onchange: e => { a.type = e.target.value; onChange(); }
  },
    el('option', { value: 'plug'  }, 'Plug command'),
    el('option', { value: 'topic' }, 'Publish topic')
  );
  a.type = a.type || 'plug';
  tSel.value = a.type;

  let targetEl;
  if (a.type === 'topic') {
    targetEl = el('input', {
      placeholder: 'topic',
      value: a.topic || '',
      oninput: e => { a.topic = e.target.value; onChange(); }
    });
  } else {
    const opts = [
      el('option', { value: '' }, live.length ? 'Select plug…' : 'No live plugs')
    ];
    live.forEach(p => {
      opts.push(el('option', { value: p.deviceId }, p.label));
    });
    // sticky offline option if not in live list
    const has = live.some(p => p.deviceId === a.deviceId);
    if (a.deviceId && !has) {
      opts.push(el('option', { value: a.deviceId }, `${a.deviceId} • offline`));
    }

    const s = el('select', {
      onchange: e => { a.deviceId = e.target.value; onChange(); }
    }, opts);
    s.value = a.deviceId || '';
    targetEl = s;
  }

  const cmdEl = (a.type === 'topic')
    ? el('input', {
        placeholder: 'payload',
        value: a.payload ?? '',
        oninput: e => { a.payload = e.target.value; onChange(); }
      })
    : (() => {
        const s = el('select', {
          onchange: e => { a.command = e.target.value; onChange(); }
        },
          el('option', { value: 'ON'  }, 'ON'),
          el('option', { value: 'OFF' }, 'OFF')
        );
        s.value = a.command || 'ON';
        return s;
      })();

  const del = btn('✕', onRemove, 'btn sm danger');
  return el('div', { class: 'ru-row-act' }, tSel, targetEl, cmdEl, del);
}

async function fetchRuleLogs(ruleId) {
  const res = await fetch(`/api/rules/${encodeURIComponent(ruleId)}/logs`);
  if (!res.ok) throw new Error('Failed to fetch logs');
  const json = await res.json();
  // Expecting { items: [...] } from server
  return json.items || [];
}


// ---------- open popup
function openRulesPopup(filter) {
  currentFilter = filter || null;
  const mask  = $('#popupMask');
  const body  = $('#popupBody');
  const title = $('#popupTitle');
  if (!mask || !body || !title) return;

  title.textContent = 'Rules';
  mask.style.display = 'flex';
  body.innerHTML = '';

  const unlocked = canCreate();

  const tabs = el('div',{class:'ru-tabs'},
    btn('Rules',()=>{ activeTab='list'; render(); }, 'tab '+(activeTab==='list'?'active':'')),
    btn('Builder',()=>{ activeTab='builder'; render(); }, 'tab '+(activeTab==='builder'?'active':'')),
    el('div',{style:{flex:1}}),
    chip(unlocked ? 'unlocked' : 'locked')
  );
  body.append(tabs);
  render();
  $('#popupClose').onclick = () => { mask.style.display = 'none'; };

  function render() {
    const old = $('#ru-content');
    if (old) old.remove();
    const wrap = el('div',{id:'ru-content',style:{padding:'8px 4px 2px'}});
    body.append(wrap);
    if (activeTab === 'list') renderListTab(wrap);
    else renderBuilderTab(wrap, currentModel || emptyRule());
  }
}

// ---------- list tab
function renderListTab(root){
  root.innerHTML = '';

  const bar = el('div',{class:'ru-toolbar'},
    el('div',{class:'ttl'},'Automation Rules'),
    el('div',{class:'grow'}),
    currentFilter ? chip('filtered') : null,
    btn('New rule',()=>{
      if (!canCreate()) {
        window.AppToast?.('Unlock to create rules','error');
        return;
      }
      currentModel = emptyRule();
      activeTab = 'builder';
      openRulesPopup(currentFilter);
    },'btn btnP')
  );
  root.append(bar);

  RULES.list().then(items=>{
    let list = items;
    if (currentFilter?.deviceId) {
      list = list.filter(r =>
        (r.actions || []).some(a => a.type === 'plug' && a.deviceId === currentFilter.deviceId)
      );
    }

    const cont = el('div',{style:{marginTop:'8px'}});
    if (!list.length) {
      cont.textContent='No rules found.';
      root.append(cont);
      return;
    }

     list.forEach(r=>{
      const logsBox = el('div', {
        class:'ru-logs',
        style:{
          marginTop:'6px',
          padding:'6px 8px',
          borderTop:'1px solid #222',
          display:'none',
          maxHeight:'140px',
          overflowY:'auto',
          fontSize:'12px',
          opacity:0.9
        }
      });

      const card = el('div',{class:'ru-card'},
        el('div',{class:'ru-card-hdr'},
          el('div',{class:'ttl'},r.name || '(untitled)'),
          chip(r.enabled ? 'enabled' : 'disabled'),
          chip(`prio ${r.priority ?? 100}`),
          chip(`cooldown ${r.cooldownSec ?? 30}s`),
          el('div',{class:'grow'}),
          btn('Edit',()=>{
            currentModel = r;
            activeTab   = 'builder';
            openRulesPopup(currentFilter);
          }),
          btn(r.enabled ? 'Disable' : 'Enable', async()=>{
            await RULES.update(r.id,{enabled:!r.enabled});
            openRulesPopup(currentFilter);
          }),
          btn('Run',()=>RULES.tick?.()),
          btn('Logs', async()=>{
            // toggle visibility
            if (logsBox.dataset.open === '1') {
              logsBox.style.display = 'none';
              logsBox.dataset.open  = '0';
              return;
            }
            logsBox.style.display = 'block';
            logsBox.dataset.open  = '1';
            logsBox.textContent   = 'Loading logs…';
            try {
              const logs = await fetchRuleLogs(r.id);
              if (!logs.length) {
                logsBox.textContent = 'No logs yet for this rule.';
              } else {
                logsBox.innerHTML = '';
                logs
                  .slice()               // copy
                  .sort((a,b)=>{
                    const ta = new Date(a.ts || a.time || a.when || a.at || 0).getTime();
                    const tb = new Date(b.ts || b.time || b.when || b.at || 0).getTime();
                    return tb - ta;      // newest first
                  })
                  .forEach(entry=>{
                    const ts = entry.ts || entry.time || entry.when || entry.at;
                    const txt = entry.msg || entry.note || entry.action || '';
                    const line = el('div',{},
                      ts ? `[${ts}] ` : '',
                      txt || JSON.stringify(entry)
                    );
                    logsBox.append(line);
                  });
              }
            } catch (err) {
              console.error('log fetch error', err);
              logsBox.textContent = 'Failed to load logs.';
            }
          }),
          btn('Delete',async()=>{
            if (!canCreate()) { window.AppToast?.('Unlock to delete','error'); return; }
            if (confirm(`Delete "${r.name}"?`)) {
              await RULES.remove(r.id);
              openRulesPopup(currentFilter);
            }
          })
        ),
        el('div',{class:'ru-sub'},
          `Last fired: ${r.lastFiredAt || '—'} • Fires: ${r.fireCount ?? 0}`),
        logsBox
      );

      cont.append(card);
    });
    root.append(cont);
  });
}

// ---------- builder tab
function renderBuilderTab(root, m) {
  currentModel = m;
  root.innerHTML = '';

  // guards
  m.conditions = m.conditions || { groups: [] };
  m.conditions.groups = Array.isArray(m.conditions.groups) ? m.conditions.groups : [];
  m.actions = Array.isArray(m.actions) ? m.actions : [];

  const hdr = el('div', { class: 'ru-grid' },
    el('input', {
      placeholder: 'Rule name',
      value: m.name || '',
      oninput: e => m.name = e.target.value
    }),
    (() => {
      const l = el('label', { class: 'lbl' }, 'Enabled ');
      const cb = el('input', {
        type: 'checkbox',
        checked: m.enabled !== false,
        onchange: e => m.enabled = e.target.checked
      });
      l.prepend(cb);
      return l;
    })(),
    el('label', { class: 'lbl' }, 'Priority ',
      el('input', {
        type: 'number',
        value: m.priority ?? 100,
        oninput: e => m.priority = Number(e.target.value)
      })
    ),
    el('label', { class: 'lbl' }, 'Cooldown (s) ',
      el('input', {
        type: 'number',
        value: m.cooldownSec ?? 30,
        oninput: e => m.cooldownSec = Number(e.target.value)
      })
    )
  );

  const conds = el('div', { class: 'ru-sec' },
    el('div', { class: 'ttl' }, 'Conditions'),
    ...(m.conditions.groups).map((g, i) =>
      groupBlock(g, i,
        () => renderBuilderTab(root, m),
        () => { m.conditions.groups.splice(i, 1); renderBuilderTab(root, m); }
      )
    ),
    btn('+ Add another set (OR)', () => {
      m.conditions.groups.push({ mode: 'ALL', tests: [] });
      renderBuilderTab(root, m);
    }, 'btn sm')
  );

  // Prefill target plug if we came from a plug filter
  if (currentFilter?.deviceId) {
    if (!m.actions.length) {
      m.actions.push({ type: 'plug', deviceId: currentFilter.deviceId, command: 'ON' });
    } else if (m.actions[0].type === 'plug' && !m.actions[0].deviceId) {
      m.actions[0].deviceId = currentFilter.deviceId;
    }
  }

  const acts = el('div', { class: 'ru-sec' },
    el('div', { class: 'ttl' }, 'Actions'),
    ...(m.actions).map((a, i) =>
      actionRow(a, () => {}, () => { m.actions.splice(i, 1); renderBuilderTab(root, m); })
    ),
    btn('+ Add action', () => {
      m.actions.push({ type: 'plug', deviceId: '', command: 'ON' });
      renderBuilderTab(root, m);
    }, 'btn sm')
  );

  const ft = el('div', { class: 'ru-foot' },
    btn('Cancel', () => $('#popupMask').style.display = 'none'),
    btn(m.id ? 'Save changes' : 'Create rule', async () => {
      if (!canCreate()) { window.AppToast?.('Unlock to save','error'); return; }
      if (!m.name?.trim()) { window.AppToast?.('Name required','error'); return; }
      if (!m.actions.length) { window.AppToast?.('Add an action','error'); return; }

      for (const a of m.actions) {
        if (a.type === 'plug' && !a.deviceId) {
          window.AppToast?.('Select target plug','error');
          return;
        }
      }

      if (m.id) await RULES.update(m.id, m);
      else await RULES.create(m);

      activeTab = 'list';
      openRulesPopup(currentFilter);
    }, 'btn btnP')
  );

  root.append(hdr, conds, acts, ft);
}

// ---------- styles (same vibe as your older version, with 6-column row)
const style = document.createElement('style');
style.textContent = `
.ru-tabs{display:flex;gap:8px;border-bottom:1px solid #222;margin-bottom:8px;padding-bottom:6px;}
.tab{padding:6px 12px;border-radius:8px 8px 0 0;cursor:pointer;}
.tab.active{background:#13344a;color:#bfe0ff;}
.ru-toolbar{display:flex;align-items:center;gap:10px;margin-bottom:6px;}
.ru-card{border:1px solid #222;border-radius:12px;padding:10px;margin:8px 0;background:#121212;}
.ru-card-hdr{display:flex;align-items:center;gap:8px;}
.ru-sub{font-size:12px;opacity:.85;margin-top:4px;}
.ru-grid{display:grid;grid-template-columns:1.4fr auto auto auto;gap:10px;align-items:center;}
.ru-sec{margin-top:12px;}
.ru-group{border:1px solid #333;background:#1a1a1a;border-radius:10px;padding:8px;margin:6px 0;}
.ru-group-hdr{display:flex;align-items:center;gap:8px;margin-bottom:6px;}
.ru-tests{margin-top:4px;}
.ru-foot{display:flex;gap:10px;justify-content:flex-end;margin-top:14px;}
.chip.sm{font-size:11px;padding:2px 6px;}
.btn.sm{font-size:12px;padding:3px 8px;}
.btn.danger{background:#3a1a1a;}
.ru-flex{display:flex;align-items:center;gap:6px;}
.lbl{display:inline-flex;align-items:center;gap:6px;white-space:nowrap;}

.ru-row{
  display:grid;
  grid-template-columns:1.0fr 1.4fr 0.7fr 1.6fr 1.4fr auto;
  gap:10px;
  align-items:center;
  margin:6px 0;
}
.ru-row-act{
  display:grid;
  grid-template-columns:1.0fr 2.0fr 1.0fr auto;
  gap:10px;
  align-items:center;
  margin:6px 0;
}
`;
document.head.append(style);

// ---------- wiring
window.addEventListener('open:rules',ev=>{
  currentFilter = ev?.detail || null;
  activeTab = 'list';
  currentModel = emptyRule();
  openRulesPopup(currentFilter);
});
window.openRules = (opts)=>RULES.openUI ? RULES.openUI(opts||null) : openRulesPopup(opts||null);

// Open the Rules UI from the 3D viewer context menu for a specific PLUG
window.addEventListener('openRulesForPlug', (e) => {
  const { dbId, deviceId: rawDeviceId, deviceName, mode } = e.detail || {};

  // Fallback to PLUGS map if viewer couldn't supply deviceId
  const mappedId = (() => {
    const arr = window.PLUGS?.DBID_TO_DEVICES?.get?.(dbId);
    return Array.isArray(arr) && arr.length ? arr[0] : null;
  })();
  const deviceId = rawDeviceId || mappedId;

  const filter = deviceId
    ? { deviceId, dbId, deviceName, isPlug:true }
    : { dbId, deviceName, isPlug:true };

  if (mode === 'create') {
    currentModel = emptyRule();
    currentModel.name = dbId
      ? `${dbId} rule`
      : (deviceName || deviceId || 'New plug rule');
    currentModel.actions = [{ type: 'plug', deviceId: deviceId || '', command: 'ON' }];

    activeTab = 'builder';
    currentFilter = filter;
    openRulesPopup(filter);
  } else {
    currentFilter = filter;
    activeTab = 'list';
    openRulesPopup(filter);
  }
});
