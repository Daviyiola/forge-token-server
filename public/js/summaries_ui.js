// summaries_ui.js — popup UI for Summaries (Overview + Recommendations)

import { SUMMARIES } from './summaries.js';

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
    if (typeof k === 'string' || typeof k === 'number') {
      n.appendChild(document.createTextNode(String(k)));
    } else {
      n.appendChild(k);
    }
  });
  return n;
};
const btn  = (t, fn, cls='btn') => el('button', { type:'button', class:cls, onclick:fn }, t);

let activeTab = 'overview'; // 'overview' | 'recommendations'
let dayOffset = 0;          // 0 = today, -1 = yesterday, etc.
let isLoading = false;

// ---------------------------------------------
// Popup + room helpers
// ---------------------------------------------
function ensurePopup() {
  const mask  = $('#popupMask');
  const body  = $('#popupBody');
  const title = $('#popupTitle');
  const close = $('#popupClose');
  if (!mask || !body || !title) return null;

  if (!close.__summariesBound) {
    close.addEventListener('click', () => { mask.style.display = 'none'; });
    mask.addEventListener('click', (e) => {
      if (e.target === mask) mask.style.display = 'none';
    });
    close.__summariesBound = true;
  }

  return { mask, body, title };
}

function getRoomsList() {
  try {
    if (window.METRICS && Array.isArray(window.METRICS.ROOMS_LIST)) {
      return window.METRICS.ROOMS_LIST;
    }
  } catch {}
  return [];
}

function getPrimaryRoom() {
  try {
    if (window.METRICS && typeof window.METRICS.getPrimaryRoomName === 'function') {
      return window.METRICS.getPrimaryRoomName();
    }
  } catch {}
  return SUMMARIES.getState().roomName || null;
}

// ---------------------------------------------
// Open + build static shell
// ---------------------------------------------
function openSummariesUI() {
  const dom = ensurePopup();
  if (!dom) return;

  dom.title.textContent = 'Summaries';
  dom.mask.style.display = 'flex';
  dom.body.innerHTML = '';

  const root = el('div', {
    id: 'summariesRoot',
    style: {
      position: 'relative',
      padding: '12px 12px 10px',
      minHeight: '260px',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px',
      color: '#ffffff'
    }
  });

  const tabs    = buildTabs();
  const topRow  = buildRoomDateRow();
  const content = el('div', {
    id:'summariesContent',
    style:{
      paddingTop: '4px',
      display: 'flex',
      flexDirection: 'column',
      gap: '14px'
    }
  });

  const overlay = el('div', {
    id: 'summariesOverlay',
    style: {
      position: 'absolute',
      inset: '0',
      background: 'rgba(0,0,0,0.55)',
      display: isLoading ? 'flex' : 'none',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: '10'
    }
  },
    el('div', {
      style: {
        padding: '10px 16px',
        borderRadius: '999px',
        background: 'rgba(0,0,0,0.9)',
        border: '1px solid rgba(255,255,255,0.2)',
        fontSize: '13px',
        display: 'inline-flex',
        alignItems: 'center',
        gap: '6px',
        color: '#ffffff'
      }
    },
      '⏳',
      'Aggregating summary…'
    )
  );

  root.append(tabs, topRow, content, overlay);
  dom.body.append(root);

  render();              // empty state
  SUMMARIES.loadToday(); // async load
}

// ---------------------------------------------
// Tabs
// ---------------------------------------------
function buildTabs() {
  const tabs = el('div', {
    class:'sum-tabs',
    style: {
      display: 'flex',
      gap: '8px',
      borderBottom: '1px solid rgba(255,255,255,0.1)',
      paddingBottom: '6px'
    }
  },
    btn('Overview', () => { activeTab='overview'; render(); },
      'tab ' + (activeTab === 'overview' ? 'active' : '')),
    btn('Recommendations', () => { activeTab='recommendations'; render(); },
      'tab ' + (activeTab === 'recommendations' ? 'active' : ''))
  );

  [...tabs.querySelectorAll('.tab')].forEach(b => {
    Object.assign(b.style, {
      flex: '0 0 auto',
      padding: '6px 12px',
      borderRadius: '999px',
      border: 'none',
      fontSize: '13px',
      cursor: 'pointer',
      background: 'transparent',
      color: '#ffffff'
    });
    if (b.classList.contains('active')) {
      b.style.background = 'rgba(255,255,255,0.15)';
      b.style.color = '#ffffff';
      b.style.fontWeight = '600';
    }
  });

  return tabs;
}

// ---------------------------------------------
// Room + date row
// ---------------------------------------------
function buildRoomDateRow() {
  const state   = SUMMARIES.getState();
  const rooms   = getRoomsList();
  const primary = getPrimaryRoom() || (rooms[0] || 'Room');

  const labelDate = getDateLabelFromState(state) || 'Today';

  // Room select
  const roomSelect = el('select', {
    id: 'summariesRoomSelect',
    style: {
      width: '100%',
      padding: '6px 10px',
      borderRadius: '999px',
      border: '1px solid rgba(255,255,255,0.25)',
      background: '#051222',
      color: '#ffffff',
      fontSize: '12px',
      outline: 'none'
    },
    onchange: (e) => {
        const room = e.target.value;
        if (window.METRICS && typeof window.METRICS.setPrimaryRoomByName === 'function') {
            window.METRICS.setPrimaryRoomByName(room);
        }
        if (SUMMARIES && typeof SUMMARIES.setRoomName === 'function') {
            SUMMARIES.setRoomName(room);
        }
        // Keep the same dayOffset when switching rooms
        SUMMARIES.loadOffset(dayOffset);
        }
  });

  rooms.forEach(r => {
    const opt = el('option', { value:r }, r);
    if (r === primary) opt.selected = true;
    roomSelect.appendChild(opt);
  });

  const roomWrapper = el('div', {
    style: {
      flex: '1 1 0',
      display: 'flex',
      flexDirection: 'column',
      gap: '4px'
    }
  },
    el('span', {
      style: { fontSize: '11px', fontWeight:'600' }
    }, 'Room'),
    roomSelect
  );

  // Date
  const dateLabel = el('span', {
    id:'summariesDateLabel',
    style: {
      fontSize: '12px',
      whiteSpace: 'nowrap',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      color: '#ffffff'
    }
  }, labelDate);

  const prevBtn = btn('◀', () => {
    dayOffset -= 1;
    SUMMARIES.loadOffset(dayOffset);
  }, 'btn sm');
  const nextBtn = btn('▶', () => {
    if (dayOffset < 0) {
      dayOffset += 1;
      SUMMARIES.loadOffset(dayOffset);
    }
  }, 'btn sm');

  [prevBtn, nextBtn].forEach(b => {
    Object.assign(b.style, {
      borderRadius: '999px',
      border: '1px solid rgba(255,255,255,0.3)',
      background: '#051222',
      color: '#ffffff',
      fontSize: '11px',
      padding: '4px 8px',
      cursor: 'pointer'
    });
  });

  const datePill = el('div', {
    style: {
      flex: '1 1 0',
      display: 'flex',
      flexDirection: 'column',
      gap: '4px'
    }
  },
    el('span', {
      style: { fontSize: '11px', fontWeight:'600' }
    }, 'Date'),
    el('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        gap: '6px'
      }
    },
      prevBtn,
      el('div', {
        style: {
          flex: '1 1 0',
          padding: '6px 10px',
          borderRadius: '999px',
          border: '1px solid rgba(255,255,255,0.25)',
          background: '#051222',
          fontSize: '12px'
        }
      }, dateLabel),
      nextBtn
    )
  );

  const row = el('div', {
    class:'sum-room-date-row',
    style: {
      display: 'flex',
      flexDirection: 'row',
      gap: '10px',
      marginTop: '4px'
    }
  },
    roomWrapper,
    datePill
  );

  return row;
}

// Helpers for date label
function getDateLabelFromState(state) {
  if (state && state.summary && state.summary.range) {
    return formatDateLabelFromRange(state.summary.range);
  }
  if (state && state.range) {
    return formatDateLabelFromRange(state.range);
  }
  return null;
}

function formatDateLabelFromRange(range) {
  if (!range) return null;
  const iso = range.startISO || range.start;
  if (!iso) return null;
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  } catch {
    return null;
  }
}

function updateDateLabel(summary) {
  const lbl = $('#summariesDateLabel');
  if (!lbl) return;

  if (!summary) {
    lbl.textContent = 'Today';
    return;
  }
  const txt =
    formatDateLabelFromRange(summary.range) ||
    summary.periodLabel ||
    'Today';

  lbl.textContent = txt;
}

// ---------------------------------------------
// Main render
// ---------------------------------------------
function render() {
  const content = $('#summariesContent');
  if (!content) return;

  const state   = SUMMARIES.getState();
  const summary = state.summary;
  isLoading     = !!state.loading;

  const overlay = $('#summariesOverlay');
  if (overlay) overlay.style.display = isLoading ? 'flex' : 'none';

  updateDateLabel(summary);

  content.innerHTML = '';
  if (isLoading && !summary) {
    content.append(
      el('p', { style:{ fontSize:'13px', marginTop:'8px' } }, 'Preparing your summary…')
    );
    return;
  }
  if (!summary) {
    content.append(
      el('p', { style:{ fontSize:'13px', marginTop:'8px' } },
        state.error || 'No summary available for this period.'
      )
    );
    return;
  }

  if (activeTab === 'overview') {
    renderOverview(content, summary);
  } else {
    renderRecommendations(content, summary);
  }
}

// ---------------------------------------------
// Tab renderers
// ---------------------------------------------
function renderOverview(root, summary) {
  const dividerStyle = {
    borderTop:'1px solid rgba(255,255,255,0.18)',
    paddingTop:'8px',
    marginTop:'4px'
  };

  // OCCUPANCY + LIGHTS
  const sec1 = el('section', {
    class:'sum-section',
    style: { display:'flex', flexDirection:'column', gap:'8px' }
  },
    el('div', {
      class:'sum-sec-title',
      style:{ fontSize:'14px', fontWeight:'700' }
    }, 'Occupancy & Lights'),
    el('div', {
      class:'sum-row',
      style:{
        display:'flex',
        flexDirection:'row',
        gap:'12px'
      }
    },
      buildCard('Occupancy', [
        line('Peak count',
          summary.occupancy?.peakCount != null
            ? String(Math.round(summary.occupancy.peakCount))
            : '—'
        ),
        line('First seen',
          summary.occupancy?.firstSeenISO
            ? formatTime(summary.occupancy.firstSeenISO)
            : '—'
        ),
        line('Last seen',
          summary.occupancy?.lastSeenISO
            ? formatTime(summary.occupancy.lastSeenISO)
            : '—'
        ),
        line('Average Occupancy (8am to 8pm)',
          summary.occupancy?.avg8to8 != null
            ? String(Math.round(summary.occupancy.avg8to8))
            : '—'
        )
      ]),
      buildCard('Lights', [
        line('On time',
          formatHoursFromMinutes(summary.occupancyLights?.lights?.onMinutes)
        ),
        line('Waste (on + empty)',
          formatHoursFromMinutes(summary.occupancyLights?.lights?.wastedMinutes)
        ),
        line('On % of day',
          summary.occupancyLights?.lights?.presencePct != null
            ? summary.occupancyLights.lights.presencePct + '%'
            : '—'
        )
      ])
    )
  );

  // COMFORT + AIR QUALITY
  const sec2 = el('section', {
    class:'sum-section',
    style: { display:'flex', flexDirection:'column', gap:'8px', ...dividerStyle }
  },
    el('div', {
      class:'sum-sec-title',
      style:{ fontSize:'14px', fontWeight:'700' }
    }, 'Comfort & Air quality'),
    el('div', {
      class:'sum-row',
      style:{
        display:'flex',
        flexDirection:'row',
        gap:'12px'
      }
    },
      buildCard('Comfort', [
        line('Temp avg',
          summary.comfort?.temp?.avg != null
            ? summary.comfort.temp.avg.toFixed(1) + ' °F'
            : '—'
        ),
        line('Temp min–max',
          summary.comfort?.temp?.min != null && summary.comfort.temp.max != null
            ? `${summary.comfort.temp.min.toFixed(1)}–${summary.comfort.temp.max.toFixed(1)} °F`
            : '—'
        ),
        line('Temp in band %',
          summary.comfort?.temp?.withinBandPct != null
            ? summary.comfort.temp.withinBandPct + '%'
            : '—'
        ),
        line('Humidity avg',
          summary.comfort?.rh?.avg != null
            ? summary.comfort.rh.avg.toFixed(1) + ' %'
            : '—'
        ),
        line('Humidity min–max',
          summary.comfort?.rh?.min != null && summary.comfort.rh.max != null
            ? `${summary.comfort.rh.min.toFixed(1)}–${summary.comfort.rh.max.toFixed(1)} %`
            : '—'
        )
      ]),
      buildCard('Air quality', [
        line('TVOC avg',
          summary.comfort?.tvoc?.avg != null
            ? Math.round(summary.comfort.tvoc.avg) + ' ppb'
            : '—'
        ),
        line('TVOC min–max',
          summary.comfort?.tvoc?.min != null && summary.comfort.tvoc.max != null
            ? `${Math.round(summary.comfort.tvoc.min)}–${Math.round(summary.comfort.tvoc.max)} ppb`
            : '—'
        ),
        line('CO₂ avg',
          summary.comfort?.co2?.avg != null
            ? Math.round(summary.comfort.co2.avg) + ' ppm'
            : '—'
        ),
        line('CO₂ min–max',
          summary.comfort?.co2?.min != null && summary.comfort.co2.max != null
            ? `${Math.round(summary.comfort.co2.min)}–${Math.round(summary.comfort.co2.max)} ppm`
            : '—'
        ),
        line('CO₂ >1000 ppm',
          summary.comfort?.co2?.exceedMinutes != null
            ? `${Math.round(summary.comfort.co2.exceedMinutes)} min`
            : '—'
        )
      ])
    )
  );

  // ENERGY + HIGHLIGHTS
  const energyCard = (summary.roomName === 'WWH015'
    ? buildCard('Energy (approx.)', [
        line('Total kWh',
          summary.energy?.kwhTotal != null
            ? summary.energy.kwhTotal.toFixed(2) + ' kWh'
            : '—'
        ),
        line('Peak power',
          summary.energy?.peakWatts != null
            ? Math.round(summary.energy.peakWatts) + ' W'
            : '—'
        ),
        line('Avg power',
          summary.energy?.avgWatts != null
            ? Math.round(summary.energy.avgWatts) + ' W'
            : '—'
        )
      ])
    : buildCard('Energy', [
        line('', 'No plug data for this room.')
      ])
  );

  const highlightsCard = buildCard('Highlights',
    summary.highlights && summary.highlights.length
      ? summary.highlights.map(h => highlightLine(h))
      : [highlightLine('No notable highlights detected for this day.')]
  );

  const sec3 = el('section', {
    class:'sum-section',
    style: { display:'flex', flexDirection:'column', gap:'8px', ...dividerStyle }
  },
    el('div', {
      class:'sum-sec-title',
      style:{ fontSize:'14px', fontWeight:'700' }
    }, 'Energy & Highlights'),
    el('div', {
      class:'sum-row',
      style:{
        display:'flex',
        flexDirection:'row',
        gap:'12px'
      }
    },
      energyCard,
      highlightsCard
    )
  );

  root.append(sec1, sec2, sec3);
}

function buildCard(title, lines) {
  return el('div', {
    class:'sum-card',
    style: {
      flex: '1 1 0',
      borderRadius: '16px',
      padding: '10px 14px',
      background: '#081a33',
      border: '1px solid #16355a',
      display: 'flex',
      flexDirection: 'column',
      gap: '4px',
      minWidth: '0',
      color: '#ffffff'
    }
  },
    el('div', {
      class:'ttl',
      style:{ fontSize:'13px', fontWeight:'600', marginBottom:'4px' }
    }, title),
    ...lines
  );
}

function renderRecommendations(root, summary) {
  const recs = summary.recommendations || [];
  if (!recs.length) {
    root.append(el('p', { style:{ fontSize:'13px', marginTop:'8px' } },
      'No recommendations for this period.'
    ));
    return;
  }

  const list = el('div', {
    class:'sum-recs',
    style:{
      display:'flex',
      flexDirection:'column',
      gap:'10px',
      marginTop:'4px'
    }
  });

  recs.forEach(r => {
    const card = el('div', {
      class:'sum-rec-card',
      style:{
        borderRadius:'16px',
        padding:'10px 14px',
        background:'#081a33',
        border:'1px solid #16355a',
        color:'#ffffff'
      }
    },
      el('div', {
        class:'ttl sm',
        style:{ fontSize:'13px', fontWeight:'600', marginBottom:'4px' }
      }, r.title || 'Recommendation'),
      el('p', {
        style:{ fontSize:'12px', lineHeight:'1.5', margin:0 }
      }, r.body || '')
    );
    list.append(card);
  });

  root.append(list);
}

// ---------------------------------------------
// Small helpers
// ---------------------------------------------
function line(label, value) {
  const row = el('div', {
    class:'sum-line',
    style:{
      display:'flex',
      justifyContent:'space-between',
      gap:'6px',
      fontSize:'12px',
      color:'#ffffff'
    }
  });
  if (label) row.append(
    el('span', { class:'k', style:{ fontWeight:'500' } }, label + ':')
  );
  row.append(
    el('span', {
      class:'v',
      style:{ textAlign:'right', flex:'1 1 auto' }
    }, value == null ? '—' : value)
  );
  return row;
}

function highlightLine(text) {
  return el('div', {
    style:{
      fontSize:'12px',
      display:'flex',
      alignItems:'flex-start',
      gap:'6px',
      color:'#ffffff'
    }
  },
    el('span', { style:{ fontWeight:'700' } }, '•'),
    el('span', { style:{ flex:'1 1 auto' } }, text)
  );
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });
  } catch {
    return '—';
  }
}

// Keep this for any remaining minute based displays, but not for lights or CO2 card
function formatMinutes(mins) {
  if (mins == null || !Number.isFinite(mins)) return '—';
  const m = Math.round(mins);
  if (m < 60) return `${m} min`;
  const h = m / 60;
  if (h < 10) return `${h.toFixed(1)} h`;
  return `${Math.round(h)} h`;
}

// Lights card and lights highlights: minutes → hours (1 decimal)
function formatHoursFromMinutes(mins) {
  if (mins == null || !Number.isFinite(mins)) return '—';
  const hours = mins / 60;
  return `${hours.toFixed(1)} hours`;
}

// ---------------------------------------------
// Wiring
// ---------------------------------------------
window.openSummaries = () => window.dispatchEvent(new Event('open:summaries'));

window.addEventListener('open:summaries', () => {
  activeTab = 'overview';
  dayOffset = 0;
  openSummariesUI();
});

window.addEventListener('summaries:updated', () => {
  render();
});
window.addEventListener('summaries:loading', (e) => {
  isLoading = !!(e && e.detail);
  const overlay = $('#summariesOverlay');
  if (overlay) overlay.style.display = isLoading ? 'flex' : 'none';
});
