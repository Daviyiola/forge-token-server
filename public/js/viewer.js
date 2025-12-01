// viewer.js — minimal viewer + category-gated selection menu (no external APIs)

// ==== CONFIG ====
const FALLBACK_URN = 'urn:REPLACE_WITH_YOUR_URN';
const DBIDS = {
  plugs:   new Set([2263, 2265, 2185, 2249, 2231, 2232, 2214, 2193, 2254, 2237, 2218, 2219, 2267]),
  sensors: new Set([2339, 3084, 3063, 3061, 3065, 3067]),
  lights:  new Set([2394, 2396, 2395, 2392, 2390, 2393, 2961, 2962, 2963, 2964, 2965, 2966, 3078, 3079, 3080, 3081, 3082, 3038])
};

// ==== TOKEN ====
function getAccessToken(onTokenReady) {
  fetch('/api/token')
    .then(r => r.json())
    .then(d => onTokenReady(d.access_token, d.expires_in))
    .catch(err => console.error('Token error:', err));
}

// ==== LIGHTWEIGHT UI HELPERS ====
function toast(msg, kind = 'info') {
  const el = document.getElementById('toast') || (() => {
    const n = document.createElement('div'); n.id = 'toast'; document.body.appendChild(n); return n;
  })();
  el.textContent = msg || '';
  el.style.background = (kind==='ok') ? '#0ea5e9' : (kind==='error') ? '#b00020' : '#333';
  el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(()=> el.classList.remove('show'), 2000);
}

function ensureLiveModal() {
  let mask = document.getElementById('modalMask');
  if (!mask) {
    mask = document.createElement('div');
    mask.id = 'modalMask';
    mask.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;display:none;align-items:center;justify-content:center';
    mask.innerHTML = `
      <div id="liveModal" role="dialog" aria-modal="true" aria-labelledby="liveTitle"
           style="width:min(85vw,1100px);height:min(70vh,800px);background:#121212;color:#fff;border-radius:14px;border:1px solid #222;display:grid;grid-template-rows:auto 1fr;box-shadow:0 25px 60px rgba(0,0,0,.45)">
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;border-bottom:1px solid #222;background:#111">
          <div class="ttl" id="liveTitle">Live Data</div>
          <button id="liveClose" type="button" style="background:#1f1f1f;color:#fff;border:none;border-radius:8px;padding:6px 9px;cursor:pointer">Close</button>
        </div>
        <div id="liveBody" style="padding:12px;overflow:auto;font:13px/1.45 system-ui,sans-serif;color:#ddd">
          <p>Placeholder for live data UI.</p>
          <ul><li><strong>dbId</strong>: <span id="liveDbId">—</span></li><li><strong>Category</strong>: <span id="liveCategory">—</span></li></ul>
        </div>
      </div>`;
    document.body.appendChild(mask);
    mask.addEventListener('click', (e)=> { if (e.target === mask) mask.style.display = 'none'; });
    mask.querySelector('#liveClose').addEventListener('click', ()=> mask.style.display = 'none');
  }
  return mask;
}

function openLiveModal(dbId, category) {
  const mask = ensureLiveModal();
  document.getElementById('liveDbId').textContent = dbId;
  document.getElementById('liveCategory').textContent = category;
  mask.style.display = 'flex';
}

// ==== VIEWER BOOT ====
let viewer, lastDbIdForMenu = null;

function bootViewer(containerOrId = 'viewer') {
  if (!window.Autodesk || !Autodesk.Viewing) {
    console.error('Autodesk Viewer script not loaded. Include viewer3D.min.js before viewer.js.');
    return;
  }

  const container = (typeof containerOrId === 'string')
    ? document.getElementById(containerOrId)
    : containerOrId;
  if (!container) { console.error('viewer.js: #viewer container not found'); return; }

  const urn =
    container.getAttribute('data-urn') ||
    (typeof window !== 'undefined' && window.MODEL_URN) ||
    FALLBACK_URN;
  if (!urn || !urn.startsWith('urn:')) {
    console.error('viewer.js: invalid/missing URN. Set #viewer[data-urn] or window.MODEL_URN.');
    return;
  }

  Autodesk.Viewing.Initializer(
    { env: 'AutodeskProduction', api: 'derivativeV2', region: 'US', getAccessToken },
    () => {
      viewer = new Autodesk.Viewing.GuiViewer3D(container, { extensions: [] });
      const started = viewer.start();
      if (started !== 0) { console.error('Viewer start failed:', started); return; }

      Autodesk.Viewing.Document.load(
        urn,
        (doc) => {
          const node = doc.getRoot().getDefaultGeometry();
          viewer.loadDocumentNode(doc, node, {}).then(() => {
            try { viewer.fitToView(); } catch {}
            wireSelectionMenu();
            console.log('Model loaded.');
          }).catch(err => console.error('loadDocumentNode error:', err));
        },
        (err) => console.error('Document.load error:', err)
      );

      window.addEventListener('resize', () => { try { viewer.resize(); } catch {} });
    }
  );
}

// ==== SELECTION MENU ====

function hasRoomMapping(dbId) {
  try { return !!window.METRICS?.getRoomByDbId?.(dbId); } catch { return false; }
}

function categoryForDbId(dbId) {
  if (hasRoomMapping(dbId)) return 'room';      // NEW: treat mapped items as "room"
  if (DBIDS.plugs.has(dbId))   return 'plug';
  if (DBIDS.sensors.has(dbId)) return 'sensor';
  if (DBIDS.lights.has(dbId))  return 'light';
  return null;
}

function getDbIdScreenAnchor(dbId) {
  const model = viewer.model;
  if (!model) return null;
  const it = model.getData().instanceTree;
  const frags = model.getFragmentList();
  if (!it || !frags) return null;

  const bbox = new THREE.Box3(); let hasAny = false;
  it.enumNodeFragments(dbId, (fragId) => {
    const fb = new THREE.Box3(); frags.getWorldBounds(fragId, fb);
    if (!hasAny) { bbox.copy(fb); hasAny = true; } else bbox.union(fb);
  }, true);
  if (!hasAny || !isFinite(bbox.min.x)) return null;

  const center = bbox.getCenter(new THREE.Vector3());
  const pt = viewer.worldToClient(center);
  const rect = viewer.container.getBoundingClientRect();

  const pad = 16;
  let pageX = rect.left + pt.x + window.scrollX;
  let pageY = rect.top  + pt.y + window.scrollY;
  const minX = rect.left + window.scrollX + pad;
  const minY = rect.top  + window.scrollY + pad;
  const maxX = rect.left + window.scrollX + rect.width  - pad;
  const maxY = rect.top  + window.scrollY + rect.height - pad;
  pageX = Math.max(minX, Math.min(pageX, maxX));
  pageY = Math.max(minY, Math.min(pageY, maxY));
  return { x: Math.round(pageX), y: Math.round(pageY) };
}

function hideSelectionMenu() {
  const el = document.getElementById('selMenu');
  if (el) el.style.display = 'none';
  lastDbIdForMenu = null;
}

// REPLACE your current showSelectionMenuAt with this version
function showSelectionMenuAt(dbId, title, category) {
  // Ensure/resolve a menu + a buttons container
  let menu = document.getElementById('selMenu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'selMenu';
    menu.innerHTML = `
      <div class="title" id="selTitle">Selected</div>
      <div id="selButtons"></div>
    `;
    Object.assign(menu.style, {
      position:'fixed', display:'none', zIndex:'5', minWidth:'260px',
      background:'#111', color:'#fff', borderRadius:'12px', padding:'10px 12px',
      boxShadow:'0 12px 32px rgba(0,0,0,.35)', font:'13px/1.3 system-ui,sans-serif'
    });
    document.body.appendChild(menu);
  }

  const titleEl = document.getElementById('selTitle');
  if (titleEl) titleEl.textContent = title || `dbId ${dbId}`;

  // <- This is the variable your error complained about:
  let btns = document.getElementById('selButtons');
  if (!btns) {
    btns = document.createElement('div');
    btns.id = 'selButtons';
    menu.appendChild(btns);
  }
  btns.innerHTML = '';

  // Always: View live data
  const viewBtn = document.createElement('button');
  viewBtn.className = 'btn';
  viewBtn.textContent = 'View live data';
  viewBtn.onclick = () => {
    hideSelectionMenu();
    // open the new Live Data popup
    window.dispatchEvent(new CustomEvent('openLiveData', {
      detail: { dbId, category }
    }));
  };


  if (category === 'light') {
  // Build View button first but append it after the info row
  const viewBtn = document.createElement('button');
  viewBtn.className = 'btn';
  viewBtn.textContent = 'View live data';
  viewBtn.onclick = () => {
    hideSelectionMenu();
    // open the new Live Data popup
    window.dispatchEvent(new CustomEvent('openLiveData', {
      detail: { dbId, category }
    }));
  };


  // Inline info row (above “View live data”)
  const info = document.createElement('div');
  info.id = `lightRow-${dbId}`;
  info.style.cssText = 'display:flex;gap:10px;align-items:center;margin:6px 0 2px;';
  window.LIGHTS?.renderSelectionInfo(info, dbId);
  btns.appendChild(info);

  btns.appendChild(viewBtn);
}

  // Add after sensor button block (or anywhere suitable in the button build)
if (window.METRICS?.getRoomByDbId?.(dbId)) {
  const roomBtn = document.createElement('button');
  roomBtn.className = 'btn';
  roomBtn.textContent = 'Set as Primary Room';
  roomBtn.onclick = () => {
    const ok = window.METRICS?.setPrimaryRoomByDbId?.(dbId);
    hideSelectionMenu();
    if (ok) toast(`dbId ${dbId} set as primary room`, 'ok');
    else    toast(`No room mapping for dbId ${dbId}`, 'error');
  };
  btns.appendChild(roomBtn);
}


if (category === 'plug') {
  // Inline metrics row FIRST
  const info = document.createElement('div');
  info.id = `plugRow-${dbId}`;
  info.style.cssText = 'display:flex;gap:8px;align-items:center;margin:6px 0 2px;';
  window.PLUGS?.renderSelectionInfo(info, dbId);
  btns.appendChild(info);

  // Then the View button
  const viewBtn = document.createElement('button');
  viewBtn.className = 'btn';
  viewBtn.textContent = 'View live data';
  viewBtn.onclick = () => {
    hideSelectionMenu();
    // open the new Live Data popup
    window.dispatchEvent(new CustomEvent('openLiveData', {
      detail: { dbId, category }
    }));
  };

  btns.appendChild(viewBtn);

  // ON/OFF buttons (auth-gated via AppAuth)
  const onBtn = document.createElement('button');
  onBtn.className = 'btn'; onBtn.textContent = 'Turn On';
  onBtn.onclick = () => { hideSelectionMenu(); window.PLUGS?.toggleRelay(dbId, true); };
  btns.appendChild(onBtn);

  const offBtn = document.createElement('button');
  offBtn.className = 'btn'; offBtn.textContent = 'Turn Off';
  offBtn.onclick = () => { hideSelectionMenu(); window.PLUGS?.toggleRelay(dbId, false); };
  btns.appendChild(offBtn);

  // Resolve a deviceId / name for rules payload (best-effort)
  const devId = (() => {
  const arr = window.PLUGS?.DBID_TO_DEVICES?.get?.(dbId);
  return Array.isArray(arr) && arr.length ? arr[0] : null;
})();

// Simple label (you can customize later)
const devName = devId ? devId : (`Plug ${dbId}`);

  function openRules(mode) {
    hideSelectionMenu();
    const payload = { dbId, deviceId: devId, deviceName: devName, mode }; // mode: 'edit' | 'create'
    const run = () => {
      // Let rules_ui.js open the Rules popup + filter/prefill using this payload
      window.dispatchEvent(new CustomEvent('openRulesForPlug', { detail: payload }));
      // Also politely close the drawer if it’s open
      try { document.getElementById('drawer')?.classList.remove('open'); } catch {}
    };
    // Auth-gate via your lock chip
    if (window.AppAuth?.isAuthed?.()) run();
    else window.AppAuth?.requireAuthThen?.(run);
  }

  const createRuleBtn = document.createElement('button');
  createRuleBtn.className = 'btn';
  createRuleBtn.textContent = 'Create rule';
  createRuleBtn.onclick = () => openRules('create');
  btns.appendChild(createRuleBtn);

  // const editRulesBtn = document.createElement('button');
  // editRulesBtn.className = 'btn';
  // editRulesBtn.textContent = 'Edit rules';
  // editRulesBtn.onclick = () => openRules('edit');
  // btns.appendChild(editRulesBtn);
} else {
  // non-plug categories keep original order
  const viewBtn = document.createElement('button');
  viewBtn.className = 'btn';
  viewBtn.textContent = 'View live data';
  viewBtn.onclick = () => {
    hideSelectionMenu();
    // open the new Live Data popup
    window.dispatchEvent(new CustomEvent('openLiveData', {
      detail: { dbId, category }
    }));
  };

  btns.appendChild(viewBtn);
}


  if (category === 'sensor') {
    const primBtn = document.createElement('button');
    primBtn.className = 'btn'; primBtn.textContent = 'Set as Primary Sensor';
    primBtn.onclick = () => {
      const ok = window.METRICS?.setPrimaryByDbId?.(dbId);
      hideSelectionMenu();
      if (ok) toast(`dbId ${dbId} set as primary sensor`, 'ok');
      else    toast(`No device mapping for dbId ${dbId}`, 'error');
    };
    btns.appendChild(primBtn);
  }

  const p = getDbIdScreenAnchor(dbId);
  if (!p) return;
  menu.style.left = (p.x + 14) + 'px';
  menu.style.top  = (p.y + 14) + 'px';
  menu.style.display = 'block';
  showSelectionMenuAt._timer && clearTimeout(showSelectionMenuAt._timer);
  showSelectionMenuAt._timer = setTimeout(hideSelectionMenu, 8000);
}

function updateMenuAnchorIfVisible() {
  if (!lastDbIdForMenu) return;
  const p = getDbIdScreenAnchor(lastDbIdForMenu);
  const el = document.getElementById('selMenu');
  if (!p || !el || el.style.display === 'none') return;
  el.style.left = (p.x + 14) + 'px';
  el.style.top  = (p.y + 14) + 'px';
}

function wireSelectionMenu() {
  const menuEl = document.getElementById('selMenu'); // may be null (we create on demand)

  viewer.addEventListener(Autodesk.Viewing.SELECTION_CHANGED_EVENT, (e) => {
    const ids = e.dbIdArray || [];
    if (!ids.length) { hideSelectionMenu(); return; }
    const dbId = Number(ids[0]);

    const category = categoryForDbId(dbId);
    if (!category) { hideSelectionMenu(); return; }

    viewer.getProperties(dbId, (props) => {
      const name = props?.name || `dbId ${dbId}`;
      lastDbIdForMenu = dbId;
      showSelectionMenuAt(dbId, name, category);
    });
  });

  viewer.addEventListener(Autodesk.Viewing.CAMERA_CHANGE_EVENT, updateMenuAnchorIfVisible);
  viewer.container.addEventListener('mousedown', (ev) => {
    if (menuEl && !menuEl.contains(ev.target)) hideSelectionMenu();
  });
  viewer.addEventListener(Autodesk.Viewing.ESCAPE_EVENT, hideSelectionMenu);
  window.addEventListener('resize', hideSelectionMenu);
}

// ==== ROBUST AUTOSTART ====
// Fire immediately if DOM is already ready; else wait for DOMContentLoaded.
(function autoStart() {
  const start = () => bootViewer('viewer');
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();

// Also expose for manual boot if you want: window.bootViewer('viewer')
window.bootViewer = bootViewer;
window.getViewer = () => viewer;
