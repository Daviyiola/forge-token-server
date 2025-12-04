// public/js/heatmap_ui.js
import { renderHeatmap, drawLegend, PALETTES, format } from '/js/heatmap.js';

(() => {
  const $ = (s)=>document.querySelector(s);
  const on = (el,ev,fn)=> el && el.addEventListener(ev,fn);

  // ===== Constants
  const TZ = 'America/New_York';
  const MAX_DAYS = 7;           // hard cap (inclusive calendar labels)
  const DEFAULT_DAYS = 7;       // default span
  const POINT_BUDGET = 100_000; // server cap mirrors this

  // ===== State
  let current = {
    metric: 'co2',
    agg: 'auto',
    bin: '60m',
    rooms: '',
    scaleAuto: true,
    min: 0,
    max: 1000,
    palette: 'viridis'
  };

  window.addEventListener('open:heatmap', openModal);

  function openModal(){
    ensureModal();
    const modal = $('#hmModal');
    modal.classList.remove('hidden');
    primeForm();
    render();
  }

  // ===== Modal and layout
  function ensureModal(){
    if ($('#hmModal')) return;
    const tpl = document.createElement('div');
    tpl.innerHTML = `
      <div id="hmModal" class="heatmap-modal hidden" role="dialog" aria-modal="true" aria-label="Utilization Heatmap">
        <div class="hm-header">
          <div class="hm-title" id="hmSummary">Utilization Heatmap</div>
          <div class="hm-actions">
            <button id="hmExport" class="btn">Export PNG</button>
            <button id="hmClose" class="btn">Close</button>
          </div>
        </div>

        <div class="hm-body">
          <aside class="hm-controls" id="hmControls">
            <div class="form-row">
              <label for="hmMetric">Metric</label>
              <select id="hmMetric">
                <option value="occupancy">Occupancy</option>
                <option value="energy">Energy</option>
                <option value="power">Power</option>
                <option value="temp">Temp</option>
                <option value="rh">Rel Humidity</option>
                <option value="co2" selected>CO₂</option>
                <option value="tvoc">TVOC</option>
                <option value="lights">Lights</option>
              </select>
            </div>

            <div class="form-row">
              <label for="hmAgg">Aggregation</label>
              <select id="hmAgg">
                <option value="auto" selected>Auto (per metric)</option>
                <option value="mean">Mean</option>
                <option value="median">Median</option>
                <option value="p95">P95</option>
                <option value="max">Max</option>
                <option value="presence_pct">Presence %</option>
                <option value="sum">Sum</option>
                <option value="seat_hours">Seat·hours</option>
                <option value="seat_minutes">Seat·minutes</option>
              </select>
              <div class="hint" id="hmAggHint">Energy uses Sum (kWh); Occupancy defaults to Seat·hours; Lights can use Presence %.</div>
            </div>

            <div class="form-row">
              <label>Date Range (NY time)</label>
              <div class="inline">
                <input id="hmStart" type="datetime-local">
                <input id="hmEnd" type="datetime-local">
              </div>
              <div class="hint">Default shows last 7 days, never more than 8 calendar labels.</div>
            </div>

            <div class="form-row">
              <label for="hmBin">Bin</label>
              <select id="hmBin">
                <option value="60m" selected>60 min</option>
                <option value="30m">30 min</option>
              </select>
            </div>

            <div class="form-row">
              <label for="hmRooms">Filters</label>
              <input id="hmRooms" type="text" placeholder="Rooms (comma-separated)">
              <div class="hint">Selecting rooms auto-includes their mapped devices on the server.</div>
            </div>

            <div class="form-row inline">
              <label><input id="hmScaleAuto" type="checkbox" checked> Auto scale</label>
              <input id="hmMin" type="text" placeholder="Min" disabled>
              <input id="hmMax" type="text" placeholder="Max" disabled>
            </div>

            <div class="apply-row">
              <button id="hmApply" class="btn apply">Apply</button>
            </div>
          </aside>

          <main class="hm-canvaswrap" id="hmCanvasWrap">
            <div class="hm-summary" id="hmHeader">—</div>
            <div class="hm-rails">
              <div class="hm-days" id="hmDays"></div>
            </div>
            <canvas id="hmCanvas"></canvas>
            <div class="hm-tip" id="hmTip" role="tooltip" aria-hidden="true"></div>
            <div class="hm-hours" id="hmHours"></div>

            <div class="hm-busy" id="hmBusy"><div class="spinner"></div><div>Generating heat map…</div></div>

            <div class="hm-legend">
              <canvas id="hmLegend" height="40"></canvas>
              <div class="hm-legend-meta" id="hmLegendMeta"></div>
            </div>
          </main>
        </div>

        <div class="hm-tabbar" id="hmTabs">
          <div class="tab active" data-tab="cfg">Config</div>
          <div class="tab" data-tab="map">Heatmap</div>
        </div>
      </div>`;
    document.body.appendChild(tpl.firstElementChild);

    // Events
    on($('#hmClose'),'click', ()=> $('#hmModal').classList.add('hidden'));
    on($('#hmExport'),'click', exportPng);
    on($('#hmApply'),'click', ()=> render());
    on($('#hmScaleAuto'),'change', toggleScaleInputs);
    window.addEventListener('resize', ()=> render());

    // Mobile tabs
    document.querySelectorAll('#hmTabs .tab').forEach(tab=>{
      on(tab,'click', ()=>{
        document.querySelectorAll('#hmTabs .tab').forEach(t=>t.classList.remove('active'));
        tab.classList.add('active');
        const wantCfg = tab.dataset.tab === 'cfg';
        $('#hmControls').classList.toggle('mobile-visible', wantCfg);
        $('#hmCanvasWrap').classList.toggle('mobile-hidden', wantCfg);
      });
    });
  }

 function primeForm(){
  // Default window: today and previous 6 days
  const now = new Date();

  // End = now (whatever the current time is)
  const end = toLocalDateTimeInput(now);

  // Start = local midnight of (today - 6 days)
  const startDate = new Date(now);
  startDate.setHours(0, 0, 0, 0);                  // snap to 00:00
  startDate.setDate(startDate.getDate() - (DEFAULT_DAYS - 1));

  const start = toLocalDateTimeInput(startDate);

  $('#hmStart').value = start;
  $('#hmEnd').value   = end;
  $('#hmRooms').value = current.rooms;
  $('#hmMetric').value = current.metric;
  $('#hmAgg').value    = current.agg;
  $('#hmBin').value    = current.bin;
  $('#hmScaleAuto').checked = current.scaleAuto;
  $('#hmMin').value = current.min;
  $('#hmMax').value = current.max;
  toggleScaleInputs();
}

  function toggleScaleInputs(){
    const auto = $('#hmScaleAuto').checked;
    $('#hmMin').disabled = auto; $('#hmMax').disabled = auto;
  }

  async function render(){
    // Read form
    current.metric = $('#hmMetric').value;
    current.agg    = $('#hmAgg').value;
    current.bin    = $('#hmBin').value;
    current.rooms  = $('#hmRooms').value.trim();
    current.scaleAuto = $('#hmScaleAuto').checked;
    current.min = parseFloat($('#hmMin').value) || 0;
    current.max = parseFloat($('#hmMax').value) || 1000;

    const { start, end } = clampRange($('#hmStart').value, $('#hmEnd').value);
    $('#hmStart').value = start; $('#hmEnd').value = end;

    $('#hmBusy').classList.add('show');

    const res = await fetch('/api/heatmap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        metric: current.metric,
        agg:    current.agg,
        start:  new Date(start).toISOString(),
        stop:   new Date(end).toISOString(),
        bin:    current.bin,
        rooms:  current.rooms ? current.rooms.split(',').map(s=>s.trim()).filter(Boolean) : [],
        tz:     TZ,
        pointBudget: POINT_BUDGET
      })
    });
    if (!res.ok) {
      $('#hmBusy').classList.remove('show');
      throw new Error('Server error');
    }
    const payload = await res.json();

    const build = {
      grid: payload?.matrix?.values || [],
      days: payload?.matrix?.days || [],
      truncated: !!payload?.truncated,
      loadedDays: payload?.loadedDays ?? (payload?.matrix?.values?.[0]?.length || 0),
      meta: {
        min:  payload?.meta?.min ?? 0,
        max:  payload?.meta?.max ?? 1,
        unit: payload?.meta?.unit || '',
        metricLabel: (payload?.meta?.metric || current.metric).toUpperCase(),
        aggLabel: (payload?.meta?.agg || current.agg || 'auto').toString().toUpperCase(),
        legendMeta: `${payload?.meta?.metric || current.metric} aggregated by ${payload?.meta?.agg || current.agg || 'auto'}`
      }
    };

    // Compose headers
    const hdr = `${build.meta.metricLabel} • ${build.meta.aggLabel} • ${build.meta.unit} • ${fmtRange(new Date(start), new Date(end))}`;
    $('#hmHeader').textContent = hdr;
    $('#hmSummary').textContent = hdr;

    // Header rails (days top, hours left)
    drawDays($('#hmDays'), build.days);
    drawHours($('#hmHours'));

    // Render heatmap
    const layout = renderHeatmap($('#hmCanvas'), {
    data: build.grid,
    min: current.scaleAuto ? build.meta.min : current.min,
    max: current.scaleAuto ? build.meta.max : current.max,
    unit: build.meta.unit,
    palette: current.palette
    });

    // Sync rails to cell sizes
    syncRails(layout, build.days);

    // Tooltip
    attachTooltip(layout, build);

    // Legend
    drawLegend($('#hmLegend'), {
      min: current.scaleAuto ? build.meta.min : current.min,
      max: current.scaleAuto ? build.meta.max : current.max,
      unit: build.meta.unit,
      palette: current.palette,
      label: `${build.meta.metricLabel} (${build.meta.unit})`
    });
    $('#hmLegendMeta').textContent = build.meta.legendMeta + (build.truncated ? ` • Loaded last ${build.loadedDays} day(s) due to dataset size.` : '');

    $('#hmBusy').classList.remove('show');
  }

  // ===== Rails
  function drawDays(el, labels){
    el.innerHTML = '';
    if (!labels || !labels.length) return;
    for (let i=0;i<labels.length;i++){
      const d = document.createElement('div');
      d.className = 'hm-day';
      d.textContent = labels[i];
      el.appendChild(d);
    }
  }

  function drawHours(el){
    el.innerHTML = '';
    for (let h=0; h<24; h++){
      const d = document.createElement('div');
      d.className = 'hm-hour';
      d.textContent = String(h).padStart(2,'0')+':00';
      el.appendChild(d);
    }
  }

  // Make rail element sizes match canvas cell sizes
    function syncRails(layout, dayLabels){
    const daysEl  = $('#hmDays');
    const hoursEl = $('#hmHours');
    const canvas  = $('#hmCanvas');

    // Rebuild labels to correct counts
    drawDays(daysEl, dayLabels);
    drawHours(hoursEl);

    // Day widths = exact cellW
    const dayNodes = daysEl.querySelectorAll('.hm-day');
    dayNodes.forEach(n => { n.style.width  = `${layout.cellW}px`; });

    // Hour heights = exact cellH
    const hourNodes = hoursEl.querySelectorAll('.hm-hour');
    hourNodes.forEach(n => {
        n.style.height     = `${layout.cellH}px`;
        n.style.lineHeight = `${layout.cellH}px`;
    });

    // Align hour column with the canvas top and clamp its total height to canvas' pixel height
    const top = canvas.offsetTop;                 // y start of the grid
    hoursEl.style.top    = `${top}px`;
    hoursEl.style.height = `${layout.cellH * 24}px`;  // exactly 24 rows
    hoursEl.style.overflow = 'hidden';
    }


  // ===== Export (full area)
function exportPng(){
  const wrap   = $('#hmCanvasWrap');
  const canvas = $('#hmCanvas');
  const daysEl = $('#hmDays');
  const leg    = $('#hmLegend');

  // Dynamically measure rails and legend
  const dayRailH = daysEl ? daysEl.offsetHeight : 40;
  const titleH   = 28;

  const tmp = document.createElement('canvas');
  tmp.width  = wrap.clientWidth;
  tmp.height = wrap.clientHeight;
  const ctx = tmp.getContext('2d');

  // Title
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '16px Inter, system-ui, sans-serif';
  ctx.fillText($('#hmHeader').textContent, 10, 20);

  // Copy heatmap: draw just below day rail and title
  const yGrid = titleH + dayRailH + 12;
  ctx.drawImage(canvas, 0, yGrid);

  // Day labels
  const days = Array.from(document.querySelectorAll('#hmDays .hm-day')).map(d=>d.textContent);
  if (days.length) {
    ctx.fillStyle = '#cbd5e1';
    ctx.font = '12px Inter, system-ui, sans-serif';
    const colW = canvas.width / days.length;
    days.forEach((t,i)=> ctx.fillText(t, 10 + i*colW + 4, titleH + 8));
  }

  // Legend at the bottom
  if (leg) ctx.drawImage(leg, 10, tmp.height - leg.height - 20);

  const a = document.createElement('a');
  a.href = tmp.toDataURL('image/png');
  a.download = 'heatmap.png';
  a.click();
}


  // ===== Helpers
  function clampRange(startStr, endStr){
  let s = new Date(startStr);
  let e = new Date(endStr);

  // Ensure chronological order
  if (e < s) {
    const tmp = s;
    s = e;
    e = tmp;
  }

  const dayMs     = 24 * 3600 * 1000;
  const maxSpanMs = (MAX_DAYS - 1) * dayMs; // with MAX_DAYS = 7 → 6 days span

  // Snap START to local midnight: we only care about the calendar day
  s.setHours(0, 0, 0, 0);

  // If the span is wider than allowed, move start up but keep it at midnight
  if (e - s > maxSpanMs) {
    s = new Date(e.getTime() - maxSpanMs);
    s.setHours(0, 0, 0, 0);
  }

  return {
    start: toLocalDateTimeInput(s),
    end:   toLocalDateTimeInput(e)
  };
}

  function toLocalDateTimeInput(d){
    const pad = (n)=> String(n).padStart(2,'0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fmtRange(s,e){
    return `${s.toLocaleString('en-US',{timeZone:TZ})} → ${e.toLocaleString('en-US',{timeZone:TZ})}`;
  }
})();

function attachTooltip(layout, build){
  const $ = (s)=>document.querySelector(s);
  const canvas = $('#hmCanvas');
  const tip = $('#hmTip');
  const grid = build.grid;
  const unit = build.meta.unit || '';
  const days = build.days || [];

  // Precompute safe bounds
  const rows = grid.length;
  const cols = rows ? grid[0].length : 0;
  if (!rows || !cols) {
    tip.setAttribute('aria-hidden','true');
    tip.style.display = 'none';
    return;
  }

  function hourLabel(rowIdx){
    return String(rowIdx).padStart(2,'0') + ':00';
  }

  function showTip(e){
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const col = Math.floor(x / layout.cellW);
    const row = Math.floor(y / layout.cellH);

    if (col < 0 || col >= cols || row < 0 || row >= rows) {
      hideTip();
      return;
    }

    const v = grid[row][col];
    const day = days[col] || '';
    const hour = hourLabel(row);

    // Compose
    tip.innerHTML = `
      <div class="t-line"><span class="t-k">Day:</span> <span class="t-v">${day}</span></div>
      <div class="t-line"><span class="t-k">Hour:</span> <span class="t-v">${hour}</span></div>
      <div class="t-line"><span class="t-k">Value:</span> <span class="t-v">${format.num(v)} ${unit}</span></div>
    `;
    tip.style.display = 'block';
    tip.style.left = `${e.clientX + 12}px`;
    tip.style.top  = `${e.clientY + 12}px`;
    tip.setAttribute('aria-hidden','false');
  }

  function hideTip(){
    tip.setAttribute('aria-hidden','true');
    tip.style.display = 'none';
  }

  canvas.onmousemove = showTip;
  canvas.onmouseleave = hideTip;
}