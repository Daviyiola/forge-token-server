// app_ui.js — drawer, popups, password/lock chip, toasts shared with viewer.js

/* ===== Drawer ===== */
const menuBtn     = document.getElementById('menuBtn');
const drawer      = document.getElementById('drawer');
const drawerClose = document.getElementById('drawerClose');
const drawerNav   = document.getElementById('drawerNav');

function openDrawer(){
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden','false');
}
function closeDrawer(){
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden','true');
}
menuBtn.addEventListener('click', openDrawer);
drawerClose.addEventListener('click', closeDrawer);
window.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') closeDrawer(); });

/* ===== Popups (70% x 85%) ===== */
const popupMask  = document.getElementById('popupMask');
const popupTitle = document.getElementById('popupTitle');
const popupBody  = document.getElementById('popupBody');
const popupClose = document.getElementById('popupClose');

function openPopup(title, html){
  popupTitle.textContent = title || 'Popup';
  popupBody.innerHTML = html || '';
  popupMask.style.display = 'flex';
}
function closePopup(){
  popupMask.style.display = 'none';
  popupBody.innerHTML = '';
}
popupClose.addEventListener('click', closePopup);
popupMask.addEventListener('click', (e)=>{ if (e.target === popupMask) closePopup(); });

drawerNav.addEventListener('click', (e)=>{
  const btn = e.target.closest('.nav-item');
  if (!btn) return;
  const key = btn.dataset.open;
  closeDrawer();
  if (key === 'day') { 
  window.dispatchEvent(new Event('open:dayPlayback'));
  return;
}
  if (key === 'heatmap') { window.dispatchEvent(new Event('open:heatmap'));    return; }
  if (key === 'rules') {
  window.dispatchEvent(new Event('open:rules'));
  return;
}

  if (key === 'alerts') {
  window.dispatchEvent(new Event('open:alerts'));
  return;
};
  if (key === 'summaries') {
  window.dispatchEvent(new Event('open:summaries'));
  return;
}
});

/* ===== Toast (shared) ===== */
function toast(msg, kind='info'){
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg || '';
  el.style.background = (kind==='ok') ? '#0ea5e9' : (kind==='error') ? '#b00020' : '#333';
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(()=> el.classList.remove('show'), 2400);
}
window.AppToast = toast;

/* ===== Auth / Lock chip =====
   The server should expose POST /api/auth/verify {password}
   and compare against an env var (see server snippet below).
*/
const authMask  = document.getElementById('authMask');
const pwInput   = document.getElementById('pwInput');
const pwErr     = document.getElementById('pwErr');
const pwSubmit  = document.getElementById('pwSubmit');
const pwCancel  = document.getElementById('pwCancel');
const lockChip  = document.getElementById('lockChip');

const UNLOCK_HOURS = 12;
const KEY_UNTIL = 'dtlab_auth_until_ts';

function isAuthed(){
  const until = Number(localStorage.getItem(KEY_UNTIL) || 0);
  return Date.now() < until;
}
function setAuthed(hours=UNLOCK_HOURS){
  const until = Date.now() + hours*60*60*1000;
  localStorage.setItem(KEY_UNTIL, String(until));
  updateChip();
}
function clearAuth(){
  localStorage.removeItem(KEY_UNTIL);
  updateChip();
}
function openPwModal(){
  pwInput.value = '';
  pwErr.textContent = '';
  pwSubmit.disabled = true;
  authMask.style.display = 'flex';
  setTimeout(()=> pwInput.focus(), 0);
}
function closePwModal(){
  authMask.style.display = 'none';
}

pwInput.addEventListener('input', ()=>{
  pwSubmit.disabled = pwInput.value.trim().length === 0;
  pwErr.textContent = '';
});
pwCancel.addEventListener('click', closePwModal);

async function verifyPassword(pass){
  const ctl = new AbortController();
  const t = setTimeout(()=> ctl.abort(), 10000);
  try{
    const res = await fetch('/api/auth/verify', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ password: pass }),
      signal: ctl.signal
    });
    clearTimeout(t);
    if (!res.ok) {
      const txt = await res.text().catch(()=> '');
      throw new Error(`HTTP ${res.status}: ${txt || res.statusText}`);
    }
    const data = await res.json().catch(()=> ({}));
    return !!data?.ok;
  }catch(err){
    clearTimeout(t);
    throw err;
  }
}

let pendingAction = null;
function requireAuthThen(fn){
  if (isAuthed()) { fn?.(); return; }
  pendingAction = fn;
  openPwModal();
}
window.AppAuth = { isAuthed, requireAuthThen, clearAuth };

pwSubmit.addEventListener('click', async ()=>{
  const entered = pwInput.value.trim();
  if (!entered) return;

  pwSubmit.disabled = true;
  pwErr.textContent = '';
  try {
    const ok = await verifyPassword(entered);
    if (!ok) { pwErr.textContent = 'Incorrect password.'; pwSubmit.disabled = false; return; }
    setAuthed(UNLOCK_HOURS);
    closePwModal();
    toast('Controls unlocked', 'ok');
    const fn = pendingAction; pendingAction = null;
    if (typeof fn === 'function') { try { fn(); } catch(e){} }
  } catch (e) {
    pwErr.textContent = 'Network/auth error. Try again.';
    pwSubmit.disabled = false;
  }
});

authMask.addEventListener('click', (e)=>{ if (e.target === authMask) closePwModal(); });
window.addEventListener('keydown', (e)=>{ if (e.key === 'Escape') closePwModal(); });

/* Chip behavior */
function updateChip(){
  lockChip.classList.toggle('chip-unlocked', isAuthed());
  lockChip.classList.toggle('chip-locked', !isAuthed());
  const dot = lockChip.querySelector('.dot');
  const lab = lockChip.querySelector('.label');
  if (isAuthed()){
    lab.textContent = 'Unlocked';
    lockChip.title = 'Click to lock controls';
  } else {
    lab.textContent = 'Locked';
    lockChip.title = 'Click to unlock controls';
  }
}
lockChip.addEventListener('click', ()=>{
  if (isAuthed()){
    clearAuth();
    toast('Controls locked', 'info');
  } else {
    openPwModal();
  }
});
updateChip();
