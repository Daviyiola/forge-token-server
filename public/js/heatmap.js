// public/js/heatmap.js
// Minimal, reliable canvas heatmap + legend renderers

export const PALETTES = {
  viridis: [
    [68,1,84],[71,44,122],[59,81,139],[44,113,142],[33,144,141],
    [39,173,129],[92,200,99],[170,220,50],[253,231,37]
  ]
};

export const format = {
  num(v){ return (v==null || Number.isNaN(v)) ? '–' : String(Math.round(v*100)/100); }
};

const clamp = (v, lo, hi)=> Math.max(lo, Math.min(hi, v));

function interp(a, b, t){ return a + (b - a) * t; }

function lerpColor(stops, t) {
  if (t <= 0) return stops[0];
  if (t >= 1) return stops[stops.length - 1];
  const x = t * (stops.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const c0 = stops[i], c1 = stops[i + 1];
  return [Math.round(interp(c0[0], c1[0], f)),
          Math.round(interp(c0[1], c1[1], f)),
          Math.round(interp(c0[2], c1[2], f))];
}

export function renderHeatmap(canvas, { data, min, max, palette='viridis' }) {
  const rows = data.length;
  const cols = rows ? data[0].length : 0;
  const parent = canvas.parentElement;
  const W = parent.clientWidth - 16; // padding
  const H = Math.max(260, parent.clientHeight - 140); // leave room for rails + legend

  canvas.width = W;
  canvas.height = H;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0,0,W,H);

  if (!rows || !cols) return { cellW:0, cellH:0, x0:0, y0:0, W, H };

  const x0 = 0, y0 = 0;
  const cellW = Math.floor(W / cols);
  const cellH = Math.floor(H / rows);
  const pal = PALETTES[palette] || PALETTES.viridis;
  const span = (max - min) || 1;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = data[r][c];
      const x = x0 + c * cellW;
      const y = y0 + r * cellH;

      if (v == null || Number.isNaN(v)) {
        ctx.fillStyle = '#1b1e27';
        ctx.fillRect(x, y, cellW, cellH);
        continue;
      }
      const t = clamp((v - min) / span, 0, 1);
      const [r0,g0,b0] = lerpColor(pal, t);
      ctx.fillStyle = `rgb(${r0},${g0},${b0})`;
      ctx.fillRect(x, y, cellW, cellH);
    }
  }

  // subtle grid
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  for (let r=0;r<=rows;r++){
    const y = y0 + r*cellH + 0.5;
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + cols*cellW, y); ctx.stroke();
  }
  for (let c=0;c<=cols;c++){
    const x = x0 + c*cellW + 0.5;
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y0 + rows*cellH); ctx.stroke();
  }

  return { cellW, cellH, x0, y0, W, H };
}

export function drawLegend(canvas, { min, max, unit='', palette='viridis', label='' }) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width = canvas.parentElement.clientWidth - 16;
  const H = canvas.height = 40;
  ctx.clearRect(0,0,W,H);

  const pal = PALETTES[palette] || PALETTES.viridis;
  const grad = ctx.createLinearGradient(0,0,W,0);
  for (let i=0; i<pal.length; i++){
    const t = i/(pal.length-1);
    grad.addColorStop(t, `rgb(${pal[i][0]},${pal[i][1]},${pal[i][2]})`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, 16);

  ctx.fillStyle = '#cbd5e1';
  ctx.font = '12px Inter, system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(`${format.num(min)} ${unit}`, 0, 20);
  const rtxt = `${format.num(max)} ${unit}`;
  const w = ctx.measureText(rtxt).width;
  ctx.fillText(rtxt, W - w, 20);

  if (label) {
    ctx.fillStyle = '#93a2b8';
    ctx.textAlign = 'center';
    ctx.fillText(label, W/2, 20);
    ctx.textAlign = 'start';
  }
}