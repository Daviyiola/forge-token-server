// day_playback_ui.js — config modal + bottom dock (non-blocking)
(() => {
  const $ = (s) => document.querySelector(s);
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

  // Build device lists from your live maps
  function collectDevices() {
    const out = { sensors: [], plugs: [], lights: [] };
    if (window.METRICS?.DBID_TO_DEVICE instanceof Map) {
      for (const [dbid, device] of window.METRICS.DBID_TO_DEVICE) out.sensors.push({ dbid, device });
    }
    if (window.PLUGS?.DBID_TO_DEVICES instanceof Map) {
      for (const [dbid, devices] of window.PLUGS.DBID_TO_DEVICES) if (devices?.length) out.plugs.push({ dbid, devices:[...devices] });
    }
    if (window.LIGHTS?.DEVICE_TO_DBIDS instanceof Map) {
      for (const [device, dbids] of window.LIGHTS.DEVICE_TO_DBIDS) out.lights.push({ device, dbids:[...dbids] });
    }
    return out;
  }

  // Small, simple config UI inside your existing popup shell
  function openConfigModal() {
    const mask = $('#popupMask'), title = $('#popupTitle'), body = $('#popupBody');
    if (!mask || !title || !body) return;
    title.textContent = 'Day Playback — Configure';
    body.innerHTML = '';

    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:grid;gap:12px;grid-template-columns:1fr;min-width:520px';

    const row1 = document.createElement('div');
    row1.style.cssText = 'display:flex;gap:10px;flex-wrap:wrap;align-items:center;';
    const date = document.createElement('input');  date.type='date';
    const s    = document.createElement('input');  s.type='time'; s.step='60';
    const e    = document.createElement('input');  e.type='time'; e.step='60';
    const speed= document.createElement('select');
    ['0.5','1','4','10','25'].forEach(v => {
      const o=document.createElement('option'); o.value=v; o.textContent=`${v}×`; if (v==='1') o.selected=true; speed.appendChild(o);
    });
    row1.append(
      labelWrap('Date', date),
      labelWrap('Start', s),
      labelWrap('Stop',  e),
      labelWrap('Speed', speed),
    );

    const lists = document.createElement('div');
    lists.style.cssText = 'display:grid;gap:8px;grid-template-columns:repeat(3,minmax(140px,1fr));align-items:start;';
    const sensorsBox = listBox('Sensors');
    const plugsBox   = listBox('Plugs');
    const lightsBox  = listBox('Lights');
    lists.append(sensorsBox.wrap, plugsBox.wrap, lightsBox.wrap);

    const btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
    const cancel = document.createElement('button'); cancel.textContent='Cancel';
    const start  = document.createElement('button'); start.textContent='Start';
    start.className = 'btnP';
    btns.append(cancel, start);

    wrap.append(row1, lists, btns);
    body.appendChild(wrap);
    mask.style.display = 'flex';

    // Defaults: today, 09:00–18:00
    const now = new Date();
    date.value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    s.value = '09:00'; e.value = '18:00';

    // Fill device lists from maps
    const maps = collectDevices();
    fillSensors(sensorsBox.list, maps.sensors);
    fillPlugs(plugsBox.list, maps.plugs);
    fillLights(lightsBox.list, maps.lights);

    on(cancel,'click', ()=> $('#popupMask').style.display='none');
    on(start,'click', async ()=> {
  if (!window.DayPB || typeof window.DayPB.load !== 'function') {
    window.AppToast?.('Playback engine not ready. Check script order.', 'error');
    return;
  }

  const selection = readSelectionFrom(lists);
  if (!selection.sensors.length && !selection.plugs.length && !selection.lights.length) {
    window.AppToast?.('Pick at least one device', 'info'); 
    return;
  }
  if (!date.value || !s.value || !e.value) {
    window.AppToast?.('Pick date/start/stop', 'info'); 
    return;
  }

  const startISO = localToISO(date.value, s.value);
  const stopISO  = localToISO(date.value, e.value);
  const sp = parseFloat(speed.value) || 1;

  // 1) Load data
  await window.DayPB.load({ selection, range:{ startISO, stopISO } });

  // 2) Apply playback speed to engine
  if (window.DayPB?.setSpeed) window.DayPB.setSpeed(sp);

  // 3) Show dock (creates the <select>), then reflect selected speed in the dock UI
  mountBottomDock();
  setDockSpeed(sp);

  // 4) Close modal and start playback
  $('#popupMask').style.display='none';
  window.DayPB.play();
});


  }

  function labelWrap(text, el) {
    const w=document.createElement('label'); w.style.cssText='display:grid;gap:6px;'; 
    const t=document.createElement('div'); t.textContent=text; t.style.cssText='font-size:12px;opacity:.8';
    el.style.cssText='padding:8px;border:1px solid #2a2a2a;border-radius:8px;background:#10151f;color:#fff;';
    w.append(t, el); return w;
  }
  function listBox(title) {
    const wrap=document.createElement('div');
    const h=document.createElement('div'); h.textContent=title; h.style.cssText='font-size:12px;opacity:.8;margin-bottom:6px;';
    const list=document.createElement('div'); list.style.cssText='display:grid;gap:6px;max-height:220px;overflow:auto;';
    wrap.append(h, list); return { wrap, list };
  }
  function fillSensors(list, sensors){
    const primary = localStorage.getItem('primary_sensor_device') || '';
    sensors.forEach(({dbid,device})=>{
      const lab=document.createElement('label'); lab.style.cssText='display:flex;gap:8px;align-items:center;';
      const cb=document.createElement('input'); cb.type='checkbox'; cb.dataset.type='sensor'; cb.dataset.device=device; cb.checked=true;
      const t=document.createElement('div'); t.textContent=`dbId ${dbid} • ${device}${device===primary?' (primary)':''}`; t.style.cssText='opacity:.9';
      lab.append(cb,t); list.appendChild(lab);
    });
  }
  function fillPlugs(list, plugs){
    plugs.forEach(({dbid,devices})=>{
      const lab=document.createElement('label'); lab.style.cssText='display:flex;gap:8px;align-items:center;';
      const cb=document.createElement('input'); cb.type='checkbox'; cb.dataset.type='plug'; cb.dataset.devices=devices.join(',');
      const t=document.createElement('div'); t.textContent=`dbId ${dbid} • ${devices.join(' · ')}`; t.style.cssText='opacity:.9';
      lab.append(cb,t); list.appendChild(lab);
    });
  }
  function fillLights(list, lights){
    lights.forEach(({device,dbids})=>{
      const lab=document.createElement('label'); lab.style.cssText='display:flex;gap:8px;align-items:center;';
      const cb=document.createElement('input'); cb.type='checkbox'; cb.dataset.type='light'; cb.dataset.device=device;
      const t=document.createElement('div'); t.textContent=`${device} • dbIds: ${dbids.join(', ')}`; t.style.cssText='opacity:.9';
      lab.append(cb,t); list.appendChild(lab);
    });
  }
  function readSelectionFrom(container){
    const sel = { sensors:[], plugs:[], lights:[] };
    container.querySelectorAll('input[type="checkbox"]:checked').forEach(cb=>{
      const type=cb.dataset.type;
      if (type==='sensor') sel.sensors.push(cb.dataset.device);
      if (type==='plug')   sel.plugs.push(...cb.dataset.devices.split(',').map(s=>s.trim()).filter(Boolean));
      if (type==='light')  sel.lights.push(cb.dataset.device);
    });
    sel.sensors=[...new Set(sel.sensors)]; sel.plugs=[...new Set(sel.plugs)]; sel.lights=[...new Set(sel.lights)];
    return sel;
  }
  function localToISO(dateStr, timeStr){
    const [y,m,d]=dateStr.split('-').map(Number);
    const [hh,mm]=timeStr.split(':').map(Number);
    return new Date(y, m-1, d, hh, mm, 0, 0).toISOString();
  }

  // =============== Bottom Dock (non-blocking controller) ===============
  let dock, prog, lbl, btnPlay, btnPause, btnStop, btnRec, btnExp, btnExit, speedSel;
  function mountBottomDock(){
    if (dock) { dock.classList.remove('hidden'); return; }
    dock = document.createElement('div');
    dock.id = 'playbackDock';
    dock.innerHTML = `
      <div class="pbx-left">
        <button class="pbx-btn" data-act="play">▶</button>
        <button class="pbx-btn" data-act="pause">⏸</button>
        <button class="pbx-btn" data-act="stop">⏹</button>
        <select class="pbx-speed">
          <option value="0.5">0.5×</option>
          <option value="1" selected>1×</option>
          <option value="4">4×</option>
          <option value="10">10×</option>
          <option value="25">25×</option>
        </select>
      </div>
      <input class="pbx-scrub" type="range" min="0" max="0" value="0" />
      <div class="pbx-right">
        <div class="pbx-time">—</div>
        <button class="pbx-btn ghost" data-act="rec">● Rec</button>
        <button class="pbx-btn ghost" data-act="exp">Export</button>
        <button class="pbx-btn ghost danger" data-act="exit">Exit</button>
      </div>
    `;
    document.body.appendChild(dock);
    prog = dock.querySelector('.pbx-scrub');
    lbl  = dock.querySelector('.pbx-time');
    btnPlay  = dock.querySelector('[data-act="play"]');
    btnPause = dock.querySelector('[data-act="pause"]');
    btnStop  = dock.querySelector('[data-act="stop"]');
    btnRec   = dock.querySelector('[data-act="rec"]');
    btnExp   = dock.querySelector('[data-act="exp"]');
    btnExit = dock.querySelector('[data-act="exit"]');
    speedSel = dock.querySelector('.pbx-speed');

    on(btnPlay,'click', ()=> DayPB.play());
    on(btnPause,'click',()=> DayPB.pause());
    on(btnStop,'click', ()=> DayPB.stop());
    on(btnRec,'click',  ()=> window.AppToast?.('Recording not yet supported'));
    on(btnExp,'click',  ()=> window.AppToast?.('Export not yet supported'));
    on(btnExit, 'click',  ()=> {
  try { DayPB.exit?.(); } catch {}
  // Hide the dock
  dock.classList.add('hidden');
  // Tell the rest of the app we’re back to live
  window.dispatchEvent(new CustomEvent('playback:mode', { detail: { mode: 'live' }}));
  // Optional nudge in case any live repaint needs a poke:
  window.dispatchEvent(new Event('playback:refresh-live'));
  window.AppToast?.('Returned to live');
});
    on(speedSel,'change', ()=>{
  const sp = parseFloat(speedSel.value) || 1;
  setDockSpeed(sp);
  if (window.DayPB?.setSpeed) window.DayPB.setSpeed(sp); // tell engine the new speed
    });

    on(prog,'input', ()=> DayPB.seek(parseInt(prog.value||'0',10)));

    // reflect state
    window.addEventListener('playback:state', ({detail:d})=>{
      prog.max   = String(Math.max(0, d.total-1));
      prog.value = String(d.idx);
      const cur  = d.ts ? new Date(d.ts)   : null;
      const st   = d.start ? new Date(d.start) : null;
      const en   = d.end ? new Date(d.end) : null;
      const fmt  = (x)=> x ? x.toLocaleString() : '—';
      lbl.textContent = `${fmt(cur)}  •  ${fmt(st)} → ${fmt(en)}  •  ${d.idx+1}/${d.total}  •  ${d.playing?'Playing':'Paused'}`;
    });
  }
  function setDockSpeed(sp){
  if (!speedSel) return;         // dock not mounted yet
  speedSel.value = String(sp);
}

  // Style (minimal)
  const style = document.createElement('style');
  style.textContent = `
    #playbackDock {
      position: fixed; left: 50%; transform: translateX(-50%);
      bottom: 12px; width: min(1100px, 92vw);
      background: rgba(17,22,33,.9); border: 1px solid #2a2f3b; border-radius: 12px;
      color: #e5e7eb; display: grid; grid-template-columns: auto 1fr auto; gap: 10px;
      padding: 10px; z-index: 50; box-shadow: 0 10px 30px rgba(0,0,0,.35);
    }
    #playbackDock.hidden { display:none; }
    #playbackDock .pbx-left, #playbackDock .pbx-right { display:flex; gap:8px; align-items:center; }
    #playbackDock .pbx-btn { background:#1c2432; color:#fff; border:1px solid #2b3445; border-radius:8px; padding:6px 10px; cursor:pointer; }
    #playbackDock .pbx-btn.ghost { background:transparent; }
    #playbackDock .pbx-scrub { width:100%; }
    #playbackDock .pbx-time { font:12px/1.2 system-ui,sans-serif; color:#cbd5e1; }
    #playbackDock .pbx-speed { padding:6px 8px; border-radius:8px; background:#10151f; border:1px solid #283241; color:#fff; }
  `;
  document.head.appendChild(style);

  // Hook the drawer button → config modal
  window.addEventListener('open:dayPlayback', openConfigModal);
})();
