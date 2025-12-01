// server.js
const express = require('express');
const axios = require('axios');
const path = require('path');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

require('dotenv').config();

// === APS credentials ===
const CLIENT_ID = process.env.APS_CLIENT_ID;
const CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const BUCKET_KEY = (process.env.APS_BUCKET || `${(CLIENT_ID || '').toLowerCase()}-samples`).replace(/[^a-z0-9-]/g, '');

// === MQTT (pass-through config) ===
const MQTT_URL = process.env.MQTT_URL;
const MQTT_USERNAME = process.env.MQTT_USERNAME;
const MQTT_PASSWORD = process.env.MQTT_PASSWORD;
const MQTT_TOPICS = (process.env.MQTT_TOPICS || 'dt/dt-lab/+/telemetry')
  .split(',').map(s => s.trim()).filter(Boolean);

// === Influx client ===
const { InfluxDB } = require('@influxdata/influxdb-client');
const INFLUX_URL    = process.env.INFLUX_URL;
const INFLUX_ORG    = process.env.INFLUX_ORG;
const INFLUX_BUCKET = process.env.INFLUX_BUCKET;
const INFLUX_TOKEN  = process.env.INFLUX_TOKEN;

let queryApi = null;
if (!INFLUX_URL || !INFLUX_ORG || !INFLUX_TOKEN) {
  console.warn('[Influx] Missing INFLUX_URL/ORG/TOKEN — time-series APIs disabled');
} else {
  const influx = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN });
  queryApi = influx.getQueryApi(INFLUX_ORG);
}

// ---------- Flux builders ----------
function buildFluxTagOnly({
  bucket,
  measurement = "env",
  device,
  fields = "temp_c,rh_pct",
  minutes = "60",
  every = "1m",
  start,
  stop,
  tagKey = "device",
  agg = "mean"
}) {
  const fieldArray = String(fields).split(",").map(s => s.trim()).filter(Boolean);
  const set = fieldArray.map(f => `"${f}"`).join(", ");
  const tagVal = (device || "").trim().replace(/"/g, '\\"');
  const key = String(tagKey || 'device').replace(/[^A-Za-z0-9_]/g, '');

  const rangeLine = (start && stop)
    ? `|> range(start: time(v: "${start}"), stop: time(v: "${stop}"))`
    : `|> range(start: -${String(minutes)}m)`;

  const ev = (every ?? "").toString().trim().toLowerCase();
  const skipAgg = !ev || ev === "raw" || ev === "0s" || ev === "none";
  const aggLine = skipAgg ? "" : `|> aggregateWindow(every: ${every}, fn: ${agg}, createEmpty: false)`;

  const tagClause = tagVal ? `|> filter(fn: (r) => r.${key} == "${tagVal}")` : "";

  return `
from(bucket: "${bucket}")
  ${rangeLine}
  |> filter(fn: (r) => r._measurement == "${measurement}")
  ${tagClause}
  |> filter(fn: (r) => contains(value: r._field, set: [${set}]))
  ${aggLine}
  |> keep(columns: ["_time","_field","_value"])
  |> yield(name: "series")
`;
}

function buildFluxUnion({
  bucket,
  measurement = 'env',
  device = '',
  fields = [],
  minutes = null,
  startISO = null,
  stopISO  = null,
  every = '1m',
}) {
  const esc = (s) => String(s).replace(/"/g, '\\"');
  const timeClause =
    (startISO && stopISO)
      ? `|> range(start: time(v: "${esc(startISO)}"), stop: time(v: "${esc(stopISO)}"))`
      : `|> range(start: -${minutes ? Number(minutes) : 60}m)`;

  const deviceClause = device ? `|> filter(fn: (r) => r.device == "${esc(device)}")` : '';

  const aggFor = (f) => (/^(relay_num|energy_wh|energy_kwh)$/i.test(f) ? 'last' : 'mean');

  const pipes = fields.map((f, i) => {
    const name = `t${i}`;
    const fn = aggFor(f);
    return `
${name} =
  from(bucket: "${esc(bucket)}")
    ${timeClause}
    |> filter(fn: (r) => r._measurement == "${esc(measurement)}")
    ${deviceClause}
    |> filter(fn: (r) => r._field == "${esc(f)}")
    |> aggregateWindow(every: ${every}, fn: ${fn}, createEmpty: false)
    |> keep(columns: ["_time","_field","_value"])
`.trim();
  });

  const unionNames = fields.map((_, i) => `t${i}`).join(', ');
  const union =
    fields.length > 1
      ? `union(tables: [${unionNames}])`
      : (fields.length === 1 ? `t0` : `from(bucket:"${esc(bucket)}") |> range(start:-1m) |> limit(n:0)`);

  return `${pipes.join('\n\n')}\n\n${union}`;
}

// ---------- Routes ----------

// MQTT config to browser (same-origin)
app.get('/api/mqtt/config', (req, res) => {
  if (!MQTT_URL || !MQTT_USERNAME || !MQTT_PASSWORD) {
    return res.status(500).json({ ok:false, error: 'MQTT env not set' });
  }
  res.json({ ok: true, url: MQTT_URL, username: MQTT_USERNAME, password: MQTT_PASSWORD, topics: MQTT_TOPICS });
});

// APS viewer token
app.get('/api/token', async (req, res) => {
  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'viewables:read'
    });
    const { data } = await axios.post(
      'https://developer.api.autodesk.com/authentication/v2/token',
      body.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    res.json(data);
  } catch (e) {
    console.error(e?.response?.data || e.message);
    res.status(500).json({ error: 'Token request failed' });
  }
});

// APS upload + translate
async function getToken(scopes) {
  const { data } = await axios.post(
    'https://developer.api.autodesk.com/authentication/v2/token',
    new URLSearchParams({
      client_id: process.env.APS_CLIENT_ID,
      client_secret: process.env.APS_CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: scopes.join(' ')
    }).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return data.access_token;
}

async function ensureBucket(bucketKey) {
  const token = await getToken(['bucket:create', 'bucket:read']);
  try {
    await axios.post(
      'https://developer.api.autodesk.com/oss/v2/buckets',
      { bucketKey, policyKey: 'persistent' },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (e) {
    if (e?.response?.status !== 409) throw e;
  }
}

function uniquifyName(name) {
  const i = name.lastIndexOf('.');
  const base = i > 0 ? name.slice(0, i) : name;
  const ext  = i > 0 ? name.slice(i) : '';
  return `${base}-${Date.now()}${ext}`;
}

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const cid  = process.env.APS_CLIENT_ID || '';
    const bkey = (process.env.APS_BUCKET || `${cid.toLowerCase()}-samples`).replace(/[^a-z0-9-]/g,'');
    const makeUnique = (req.query.unique === '1');

    await ensureBucket(bkey);

    const token = await getToken(['data:read','data:write','bucket:read','bucket:create']);

    const originalName = req.file.originalname;
    const objectName   = makeUnique ? uniquifyName(originalName) : originalName;

    const sign = await axios.get(
      `https://developer.api.autodesk.com/oss/v2/buckets/${bkey}/objects/${encodeURIComponent(objectName)}/signeds3upload`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const uploadKey = sign.data.uploadKey || sign.data.upload_key;
    const url = (sign.data.urls?.[0]) || sign.data.url;
    if (!uploadKey || !url) throw new Error('Signed S3 upload: missing uploadKey or url');

    const put = await axios.put(url, req.file.buffer, {
      headers: { 'Content-Type': 'application/octet-stream' },
      maxContentLength: Infinity, maxBodyLength: Infinity,
      validateStatus: s => (s >= 200 && s < 300) || s === 204
    });
    const etag = put.headers.etag || put.headers.ETag || '';

    await axios.post(
      `https://developer.api.autodesk.com/oss/v2/buckets/${bkey}/objects/${encodeURIComponent(objectName)}/signeds3upload`,
      { uploadKey, parts: [{ partNumber: 1, etag }] },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    const urnRaw = `urn:adsk.objects:os.object:${bkey}/${objectName}`;
    const urnB64 = Buffer.from(urnRaw).toString('base64');
    await axios.post(
      'https://developer.api.autodesk.com/modelderivative/v2/designdata/job',
      { input: { urn: urnB64 }, output: { formats: [{ type: 'svf2', views: ['2d','3d'] }] } },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    res.json({ urn: `urn:${urnB64}`, objectName });
  } catch (e) {
    console.error('UPLOAD ERROR:', e?.response?.data || e.message || e);
    res.status(500).json({ error: 'Upload/translate failed', detail: e?.response?.data || e.message });
  }
});

// Simple auth verify
app.post('/api/auth/verify', (req, res) => {
  const PASS = process.env.CONTROL_PASSWORD || process.env.APP_PASSWORD || '';
  const { password } = req.body || {};
  if (!PASS) return res.status(500).json({ ok:false, error:'Password not configured' });
  if (typeof password !== 'string') return res.status(400).json({ ok:false, error:'Bad request' });
  if (password === PASS) return res.json({ ok:true });
  return res.status(401).json({ ok:false });
});

// --- Time-series API ---
app.get("/api/series", async (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
  if (!queryApi) return res.status(503).json({ error: 'Influx not configured' });

  const bucket      = INFLUX_BUCKET;
  const measurement = String(req.query.measurement || "env");
  const minutes     = req.query.minutes != null ? String(req.query.minutes) : "60";
  const every       = req.query.every != null   ? String(req.query.every)   : "1m";
  const start       = req.query.start ? String(req.query.start) : undefined;
  const stop        = req.query.stop  ? String(req.query.stop)  : undefined;
  const device      = (req.query.device || "").trim();
  const fields      = String(req.query.fields || "temp_c,rh_pct");
  const tagKey      = req.query.tagKey ? String(req.query.tagKey) : 'device';
  const aggRaw      = (req.query.agg || '').toString().toLowerCase();
  const allowedAggs = new Set(['mean','median','max','min','last']);
  const agg         = allowedAggs.has(aggRaw) ? aggRaw : 'mean';

  const flux = buildFluxTagOnly({ bucket, measurement, device, fields, minutes, every, start, stop, tagKey, agg });

  try {
    const rows = await queryApi.collectRows(flux);
    const series = {};
    const latest = {};
    for (const r of rows) {
      const f = r._field;
      (series[f] ||= []).push({ t: r._time, v: r._value });
      if (!latest[f] || new Date(r._time) > new Date(latest[f].t)) {
        latest[f] = { t: r._time, v: r._value };
      }
    }
    if (req.query.debug === "1") return res.json({ flux, series, latest });
    return res.json({ series, latest });
  } catch (err) {
    console.error("Flux error:", err);
    return res.status(500).json({ error: "Query failed", details: String(err), flux });
  }
});


// ================================================================
// NEW: /api/heatmap_slice — return ONE-DAY slice for stitching
// Body: {
//   metric, agg:'auto'|'mean'|'median'|'p95'|'max'|'presence_pct'|'sum'|'seat_hours'|'seat_minutes',
//   start, stop,               // ISO strings; MUST be ≤ 24h span (exclusive of stop)
//   bin:'60m'|'30m', rooms:[], // optional filters
//   tagKey, tz:'America/New_York'
// }
// Returns:
//   {
//     grid: [24][1],                       // one column for the day
//     meta: { unit,min,max,metricLabel,aggLabel,legendMeta },
//     days: ["Wed"]                        // weekday label for header rail
//   }
// Notes:
//  - Aligns units/aggregation with your existing metric definitions
//  - Energy handled as Wh deltas → kWh after binning
//  - Occupancy supports seat_minutes/seat_hours and mean/max/p95
// ================================================================
app.post('/api/heatmap_slice', async (req, res) => {
  try {
    if (!queryApi) return res.status(503).json({ error: 'Influx not configured' });

    const {
      metric = 'co2',
      agg = 'auto',
      start,
      stop,
      bin = '60m',
      tagKey,
      devices = [],
      rooms = [],
      tz = 'America/New_York'
    } = req.body || {};

    if (!start || !stop) return res.status(400).json({ error: 'start/stop required' });
    const s = new Date(start), e = new Date(stop);
    if (!(s instanceof Date) || !(e instanceof Date) || isNaN(s) || isNaN(e)) {
      return res.status(400).json({ error: 'Invalid start/stop' });
    }
    if (e - s > (24*3600*1000 + 1000)) {
      return res.status(400).json({ error: 'Slice must be ≤ 24h' });
    }

    // Metric map — consistent with your existing /api/heatmap
    const METRIC_DEF = {
      temp:      { m: 'env',        f: ['temp_f'],                           unit: '°F',     defAgg: 'median', label:'Temperature' },
      rh:        { m: 'env',        f: ['rh_pct'],                           unit: '%',      defAgg: 'median', label:'Rel Humidity' },
      tvoc:      { m: 'env',        f: ['tvoc_ppb'],                         unit: 'ppb',    defAgg: 'median', label:'TVOC' },
      co2:       { m: 'env',        f: ['eco2_ppm'],                         unit: 'ppm',    defAgg: 'mean',   label:'CO₂' },
      lights:    { m: 'env',        f: ['light_on_num'],                     unit: '%',      defAgg: 'presence_pct', label:'Lights' },
      occupancy: { m: 'room_count', f: ['room_count','count'],               unit: 'seat·h', defAgg: 'seat_hours', label:'Occupancy' },
      power:     { m: 'plugData',   f: ['watts','power_w','power_W'],        unit: 'W',      defAgg: 'mean',   label:'Power' },
      energy:    { m: 'plugData',   f: ['energy_wh','energy_kwh'],           unit: 'kWh',    defAgg: 'sum',    label:'Energy' }
    };
    const M = METRIC_DEF[metric];
    if (!M) return res.status(400).json({ error: 'Unknown metric' });
    const AGG = (agg && agg !== 'auto') ? String(agg).toLowerCase() : M.defAgg;

    // Filter strategy
    const tagStrategy = rooms?.length ? 'room' : (tagKey || 'device');
    const tagValues = rooms?.length ? rooms : devices;
    const allowTagFilter = ['device','room','dbId','site'].includes(tagStrategy);

const fieldSet = (Array.isArray(M.f) ? M.f : [M.f]).map(s => `"${s}"`).join(', ');
    const tagClause = (tagValues?.length && allowTagFilter)
      ? `|> filter(fn: (r) => contains(value: r.${tagStrategy}, set: [${tagValues.map(v => `"${String(v).replace(/"/g,'\\"')}"`).join(', ')}]))`
      : '';

    const needFill = (metric === 'occupancy'); // per-minute forward fill for seat-minutes
    const rangeLine = `|> range(start: time(v: "${start}"), stop: time(v: "${stop}"))`;

    const flux = `
from(bucket: "${INFLUX_BUCKET}")
  ${rangeLine}
  |> filter(fn: (r) => r._measurement == "${M.m}")
  ${tagClause}
  |> filter(fn: (r) => contains(value: r._field, set: [${fieldSet}]))
  ${needFill ? '|> aggregateWindow(every: 1m, fn: last, createEmpty: true)\n  |> fill(usePrevious: true)' : ''}
  |> keep(columns: ["_time","_field","_value","${allowTagFilter ? tagStrategy : 'device'}"])
  |> yield(name: "series")
`.trim();

    const rowsRaw = await queryApi.collectRows(flux);
    const rows = rowsRaw.map(o => ({
      _time: o._time,
      _value: Number(o._value),
      _field: o._field,
      tag: o[allowTagFilter ? tagStrategy : 'device'] ?? null
    }));

    // Energy: cumulative → deltas (Wh) then bin; convert to kWh after binning
    const isEnergy = (metric === 'energy');
    if (isEnergy) {
      const byDev = new Map();
      for (const r of rows) {
        const dev = r.tag || 'unknown';
        const vWh = (r._field === 'energy_wh') ? r._value
                 : (r._field === 'energy_kwh') ? (r._value * 1000)
                 : NaN;
        if (!Number.isFinite(vWh)) continue;
        (byDev.get(dev) || byDev.set(dev, []).get(dev)).push({ t: r._time, v: vWh });
      }
      const deltas = [];
      for (const [dev, arr] of byDev) {
        arr.sort((a,b) => new Date(a.t) - new Date(b.t));
        for (let i=1;i<arr.length;i++){
          const d = arr[i].v - arr[i-1].v;
          if (d > 0 && Number.isFinite(d)) deltas.push({ _time: arr[i].t, _value: d, tag: dev });
        }
      }
      rows.length = 0; rows.push(...deltas);
    }

    // Bin to Hour × single Day column
    const fmtHour = new Intl.DateTimeFormat('en-US',{ timeZone: tz, hour:'2-digit', hour12:false });
    const fmtDOW  = new Intl.DateTimeFormat('en-US',{ timeZone: tz, weekday:'short' });
    const grid = Array.from({length:24}, () => [ { n:0, sum:0, max:-Infinity, vals:[] } ]);

    const presenceThreshold = (metric === 'occupancy') ? 1 : 0.5;
    for (const r of rows) {
      const d = new Date(r._time);
      const hh = Number(fmtHour.format(d));
      if (Number.isNaN(hh)) continue;
      const cell = grid[hh][0];
      const v = r._value;
      if (v == null || Number.isNaN(v)) continue;
      cell.n   += 1;
      cell.sum += v;
      if (v > cell.max) cell.max = v;
      cell.vals.push(v);
    }

    function pctile(arr, p){
      if (!arr.length) return null;
      const a = arr.slice().sort((x,y)=>x-y);
      const idx = (p/100)*(a.length-1);
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      if (lo === hi) return a[lo];
      const t = idx - lo;
      return a[lo]*(1-t) + a[hi]*t;
    }

    // Reduce cells per aggregation
    const values = grid.map(([cell]) => {
      if (cell.n === 0) return null;
      if (metric === 'occupancy') {
        if (AGG === 'seat_minutes') return cell.sum;
        if (AGG === 'seat_hours')   return cell.sum / 60;
        if (AGG === 'max')          return cell.max;
        if (AGG === 'p95')          return pctile(cell.vals,95);
        return cell.sum / cell.n; // mean people
      }
      if (AGG === 'presence_pct') {
        const hits = cell.vals.filter(v => v >= presenceThreshold).length;
        return (hits / cell.vals.length) * 100;
      }
      if (AGG === 'sum')    return cell.sum;
      if (AGG === 'median') return pctile(cell.vals,50);
      if (AGG === 'p95')    return pctile(cell.vals,95);
      if (AGG === 'max')    return cell.max;
      return cell.sum / cell.n; // mean
    }).map(v => [v]); // turn into 24 x 1 grid

    // Stats + unit post-processing
    let outUnit = M.unit;
    if (isEnergy) {
      for (let r=0;r<values.length;r++){
        if (values[r][0] != null) values[r][0] = values[r][0] / 1000; // Wh→kWh
      }
      outUnit = 'kWh';
    }
    if (metric === 'occupancy') {
      if (AGG === 'seat_minutes') outUnit = 'person·min';
      if (AGG === 'seat_hours')   outUnit = 'seat·h';
      if (AGG === 'mean' || AGG === 'max' || AGG === 'p95') outUnit = 'people';
    }

    const flat = values.flat().filter(v=>v!=null && !Number.isNaN(v));
    const min = flat.length ? Math.min(...flat) : 0;
    const max = flat.length ? Math.max(...flat) : 1;
    const dayLabel = new Date(start).toLocaleDateString('en-US',{ timeZone: tz, weekday:'short' });

    return res.json({
      grid: values, // [24][1]
      meta: {
        unit: outUnit,
        min, max,
        metricLabel: (METRIC_DEF[metric]?.label || metric),
        aggLabel: String(AGG).toUpperCase(),
        legendMeta: `${METRIC_DEF[metric]?.label || metric} aggregated by ${AGG}`
      },
      days: [dayLabel]
    });
  } catch (e) {
    console.error('heatmap_slice error:', e);
    return res.status(500).json({ error: 'heatmap_slice failed', details: String(e) });
  }
});

// ==== HEATMAP API (contiguous window, ≤ 8 labels, budget-aware) ====
app.post('/api/heatmap', async (req, res) => {
  try {
    if (!queryApi) {
      // Safe empty response so UI doesn't crash if Influx not configured
      return res.json({
        meta: {
          tz: 'America/New_York',
          metric: (req.body?.metric || 'co2'),
          agg: (req.body?.agg || 'auto'),
          bin: (req.body?.bin || '60m'),
          unit: '',
          date_range: [null, null],
          filters: { tagKey: 'device', values: [] },
          min: 0, max: 1
        },
        matrix: {
          rows: 24, cols: 0,
          hours: Array.from({length:24}, (_,i)=>i),
          days: [],
          values: Array.from({length:24}, ()=>[])
        },
        truncated: false,
        loadedDays: 0
      });
    }

    // -------- Inputs
    const {
      metric = 'co2',
      agg = 'auto',
      start,
      stop,
      bin = '60m',            // not used in this stitcher but preserved
      tagKey,
      devices = [],
      rooms = [],
      tz = 'America/New_York',
      pointBudget = 100_000
    } = req.body || {};

    // -------- Metric map (same alignment used in /api/heatmap_slice)
    const METRIC_DEF = {
      temp:      { m: 'env',        f: ['temp_f'],                           unit: '°F',     defAgg: 'median',       label:'Temperature' },
      rh:        { m: 'env',        f: ['rh_pct'],                           unit: '%',      defAgg: 'median',       label:'Rel Humidity' },
      tvoc:      { m: 'env',        f: ['tvoc_ppb'],                         unit: 'ppb',    defAgg: 'median',       label:'TVOC' },
      co2:       { m: 'env',        f: ['eco2_ppm'],                         unit: 'ppm',    defAgg: 'mean',         label:'CO₂' },
      lights:    { m: 'env',        f: ['light_on_num'],                     unit: '%',      defAgg: 'presence_pct', label:'Lights' },
      occupancy: { m: 'room_count', f: ['room_count','count'],               unit: 'seat·h', defAgg: 'seat_hours',   label:'Occupancy' },
      power:     { m: 'plugData',   f: ['watts','power_w','power_W'],        unit: 'W',      defAgg: 'mean',         label:'Power' },
      energy:    { m: 'plugData',   f: ['energy_wh','energy_kwh'],           unit: 'kWh',    defAgg: 'sum',          label:'Energy' }
    };
    const M = METRIC_DEF[metric];
    if (!M) return res.status(400).json({ error: 'Unknown metric' });
    const AGG = (agg && agg !== 'auto') ? String(agg).toLowerCase() : M.defAgg;

    // -------- Clamp range to ≤ 7 days span (→ ≤ 8 calendar labels)
    const DAY = 24 * 3600 * 1000;
    const E = stop ? new Date(stop) : new Date();
    let S = start ? new Date(start) : new Date(E.getTime() - 7 * DAY);
    if (E - S > 7 * DAY) S = new Date(E.getTime() - 7 * DAY);

    // -------- Filters
    const tagStrategy = rooms?.length ? 'room' : (tagKey || 'device');
    const tagValues   = rooms?.length ? rooms : devices;
    const allowTagFilter = ['device','room','dbId','site'].includes(tagStrategy);
    const fieldSet = (Array.isArray(M.f) ? M.f : [M.f]).map(s => `"${s}"`).join(', ');
    const tagClause = (tagValues?.length && allowTagFilter)
      ? `|> filter(fn: (r) => contains(value: r.${tagStrategy}, set: [${tagValues.map(v => `"${String(v).replace(/"/g,'\\"')}"`).join(', ')}]))`
      : '';

    // -------- Helpers
    const fmtHour = new Intl.DateTimeFormat('en-US',{ timeZone: tz, hour:'2-digit', hour12:false });
    const fmtDOW  = new Intl.DateTimeFormat('en-US',{ timeZone: tz, weekday:'short' });
    const weekdayLabel = (d) => fmtDOW.format(d);
    const percentile = (arr, p) => {
      if (!arr.length) return null;
      const a = arr.slice().sort((x,y)=>x-y);
      const idx = (p/100)*(a.length-1);
      const lo = Math.floor(idx), hi = Math.ceil(idx);
      if (lo === hi) return a[lo];
      const t = idx - lo;
      return a[lo]*(1-t) + a[hi]*t;
    };

    // -------- Stitch newest day first, walk backward
    const MAX_LABELS = 8;
    let cursorEnd = new Date(E);
    let cursorStart = new Date(cursorEnd.getTime() - DAY);
    let loaded = 0, totalPoints = 0, truncated = false;

    let grid = null;       // [24][N]
    let days = [];
    let unitOut = M.unit;
    let vmin = Infinity, vmax = -Infinity;

    while (cursorEnd > S && loaded < MAX_LABELS) {
      const needFill = (metric === 'occupancy'); // per-minute FF for seat-minutes
      const flux = `
from(bucket: "${INFLUX_BUCKET}")
  |> range(start: time(v: "${cursorStart.toISOString()}"), stop: time(v: "${cursorEnd.toISOString()}"))
  |> filter(fn: (r) => r._measurement == "${M.m}")
  ${tagClause}
  |> filter(fn: (r) => contains(value: r._field, set: [${fieldSet}]))
  ${needFill ? '|> aggregateWindow(every: 1m, fn: last, createEmpty: true)\n  |> fill(usePrevious: true)' : ''}
  |> keep(columns: ["_time","_field","_value","${allowTagFilter ? tagStrategy : 'device'}"])
  |> yield(name: "series")
`.trim();

      const rowsRaw = await queryApi.collectRows(flux);
      let rows = rowsRaw.map(o => ({
        _time: o._time,
        _value: Number(o._value),
        _field: o._field,
        tag: o[allowTagFilter ? tagStrategy : 'device'] ?? null
      }));

      // Energy: cumulative -> deltas (Wh)
      if (metric === 'energy') {
        const byDev = new Map();
        for (const r of rows) {
          const dev = r.tag || 'unknown';
          const vWh = (r._field === 'energy_wh') ? r._value
                   : (r._field === 'energy_kwh') ? (r._value * 1000)
                   : NaN;
          if (!Number.isFinite(vWh)) continue;
          if (!byDev.has(dev)) byDev.set(dev, []);
          byDev.get(dev).push({ t: r._time, v: vWh });
        }
        const deltas = [];
        for (const [dev, arr] of byDev) {
          arr.sort((a,b) => new Date(a.t) - new Date(b.t));
          for (let i=1;i<arr.length;i++){
            const d = arr[i].v - arr[i-1].v;
            if (d > 0 && Number.isFinite(d)) deltas.push({ _time: arr[i].t, _value: d, tag: dev });
          }
        }
        rows = deltas;
      }

      // Bin to 24x1 column
      const cells = Array.from({length:24}, () => ({ n:0, sum:0, max:-Infinity, vals:[] }));
      const presenceThreshold = (metric === 'lights') ? 0.5 : 1;

      for (const r of rows) {
        const d = new Date(r._time);
        const hh = Number(fmtHour.format(d));
        if (Number.isNaN(hh)) continue;
        const v = r._value;
        if (v == null || Number.isNaN(v)) continue;
        const c = cells[hh];
        c.n += 1;
        c.sum += v;
        if (v > c.max) c.max = v;
        c.vals.push(v);
      }

      let col = cells.map(c => {
        if (c.n === 0) return null;

        if (metric === 'occupancy') {
          if (AGG === 'seat_minutes') return c.sum;
          if (AGG === 'seat_hours')   return c.sum / 60;
          if (AGG === 'max')          return c.max;
          if (AGG === 'p95')          return percentile(c.vals,95);
          return c.sum / c.n; // mean people
        }

        if (metric === 'lights' && AGG === 'presence_pct') {
          const hits = c.vals.filter(v => v >= presenceThreshold).length;
          return (hits / c.vals.length) * 100;
        }

        if (AGG === 'sum')    return c.sum;
        if (AGG === 'median') return percentile(c.vals,50);
        if (AGG === 'p95')    return percentile(c.vals,95);
        if (AGG === 'max')    return c.max;
        return c.sum / c.n; // mean
      });

      // Wh -> kWh post-conversion
      if (metric === 'energy') {
        col = col.map(v => (v == null ? v : v/1000));
        unitOut = 'kWh';
      } else if (metric === 'occupancy') {
        if (AGG === 'seat_minutes') unitOut = 'person·min';
        else if (AGG === 'seat_hours') unitOut = 'seat·h';
        else if (AGG === 'mean' || AGG === 'max' || AGG === 'p95') unitOut = 'people';
      }

      // Budget check
      const points = col.filter(v => v !== null).length;
      if ((totalPoints + points) > Number(pointBudget)) {
        truncated = true;
        break;
      }

      // Append column
      if (!grid) {
        grid = col.map(v => [v]); // [24][1]
      } else {
        for (let r = 0; r < grid.length; r++) grid[r].push(col[r]);
      }

      // Track min/max
      const flat = col.filter(v => v != null && !Number.isNaN(v));
      if (flat.length) {
        const localMin = Math.min(...flat);
        const localMax = Math.max(...flat);
        if (localMin < vmin) vmin = localMin;
        if (localMax > vmax) vmax = localMax;
      }

      days.push(weekdayLabel(cursorStart, tz));
      totalPoints += points;
      loaded += 1;

      cursorEnd = cursorStart;
      cursorStart = new Date(cursorEnd.getTime() - DAY);
    }

    // Empty shape if no data
    if (!grid) {
      return res.json({
        meta: {
          tz, metric, agg: AGG, bin, unit: M.unit,
          date_range: [S.toISOString(), E.toISOString()],
          filters: { tagKey: tagStrategy, values: tagValues },
          min: 0, max: 1
        },
        matrix: {
          rows: 24, cols: 0,
          hours: Array.from({length:24}, (_,i)=>i),
          days: [],
          values: Array.from({length:24}, ()=>[])
        },
        truncated: false,
        loadedDays: 0
      });
    }

    // Final response
    return res.json({
      meta: {
        tz, metric, agg: AGG, bin, unit: unitOut,
        date_range: [S.toISOString(), E.toISOString()],
        filters: { tagKey: tagStrategy, values: tagValues },
        min: (vmin === Infinity ? 0 : vmin),
        max: (vmax === -Infinity ? 1 : vmax)
      },
      matrix: {
        rows: 24,
        cols: grid[0].length,
        hours: Array.from({length:24}, (_,i)=>i),
        days,
        values: grid
      },
      truncated,
      loadedDays: grid[0].length
    });
  } catch (e) {
    console.error('Heatmap error:', e);
    return res.status(500).json({ error: 'Heatmap failed', details: String(e) });
  }
});

const admin = require('firebase-admin');

// Initialize Firebase only once
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FB_PROJECT_ID,
    clientEmail: process.env.FB_CLIENT_EMAIL,
    // Convert "\n" in .env to real line breaks
    privateKey:  process.env.FB_PRIVATE_KEY.replace(/\\n/g, '\n'),
  }),
  databaseURL: process.env.FB_DB_URL,
});

// Get a database reference AFTER initializeApp
const db = admin.database();

// Test route
// app.get('/api/test-firebase', async (req, res) => {
//   try {
//     const ref = db.ref('/test');
//     await ref.set({ time: Date.now(), msg: 'Hello from server!' });
//     const snapshot = await ref.once('value');
//     res.json({ ok: true, data: snapshot.val() });
//   } catch (err) {
//     console.error('Firebase test error:', err);
//     res.status(500).json({ ok: false, error: err.message });
//   }
// });

// Rules storage paths in Realtime Database
const SITE_ID = process.env.SITE_ID || 'dt-lab';
const rulesRef = db.ref(`/sites/${SITE_ID}/rules`);
const firesRef = db.ref(`/sites/${SITE_ID}/ruleFires`);

// Alerts: definitions + fired events
const alertsRef      = db.ref(`/sites/${SITE_ID}/alerts`);
const alertEventsRef = db.ref(`/sites/${SITE_ID}/alertEvents`);


// create a timestamp
function nowISO() { return new Date().toISOString(); }

// 1) List rules
app.get('/api/rules', async (req, res) => {
  try {
    const snap = await rulesRef.once('value');
    const obj = snap.val() || {};
    const items = Object.values(obj);
    return res.json({ items });
  } catch (e) {
    console.error('rules:list error', e);
    return res.status(500).json({ error: 'rules list failed' });
  }
});

// 2) Create rule
// 2) Create rule
app.post('/api/rules', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name) return res.status(400).json({ error: 'name required' });
    // if (!body.kind) return res.status(400).json({ error: 'kind required' }); // <-- remove this

    const id = 'rule_' + Math.random().toString(36).slice(2, 10);
    const rule = {
      id,
      name: String(body.name),
      enabled: body.enabled !== false,
      kind: (body.kind || 'generic'),          // default now
      conditions: body.conditions || {},
      actions: body.actions || [],
      priority: Number(body.priority ?? 100),
      cooldownSec: Number(body.cooldownSec ?? 30),
      visibility: body.visibility || 'site',
      ownerUserId: body.ownerUserId || null,
      createdAt: nowISO(),
      updatedAt: nowISO(),
      lastFiredAt: null,
      fireCount: 0
    };

    if (!rule.actions.length)
      return res.status(400).json({ error: 'actions required' });

    await rulesRef.child(id).set(rule);
    res.json({ ok: true, id, rule });
  } catch (e) {
    console.error('rules:create error', e);
    res.status(500).json({ error: 'rules create failed' });
  }
});


// 3) Update rule
app.put('/api/rules/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const patch = { ...req.body, updatedAt: nowISO() };
    await rulesRef.child(id).update(patch);
    const snap = await rulesRef.child(id).once('value');
    return res.json({ ok: true, rule: snap.val() });
  } catch (e) {
    console.error('rules:update error', e);
    return res.status(500).json({ error: 'rules update failed' });
  }
});

// 4) Delete rule
app.delete('/api/rules/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await rulesRef.child(id).remove();
    return res.json({ ok: true });
  } catch (e) {
    console.error('rules:delete error', e);
    return res.status(500).json({ error: 'rules delete failed' });
  }
});

// 5) Rule fire logs
// GET /api/rules/:id/logs?limit=50
app.get('/api/rules/:id/logs', async (req, res) => {
  try {
    const id = req.params.id;
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 50)));
    const snap = await firesRef.child(id).limitToLast(limit).once('value');
    const obj = snap.val() || {};
    const items = Object.values(obj).sort((a,b) => String(a.at || '').localeCompare(String(b.at || '')));
    return res.json({ items });
  } catch (e) {
    console.error('rules:logs list error', e);
    return res.status(500).json({ error: 'logs list failed' });
  }
});

// POST /api/rules/:id/logs
app.post('/api/rules/:id/logs', async (req, res) => {
  try {
    const id = req.params.id;
    const body = req.body || {};
    const row = {
      at: body.at || nowISO(),
      summary: body.summary || '',
      actions: body.actions || [],
      createdAt: nowISO()
    };
    await firesRef.child(id).push(row);
    return res.json({ ok: true });
  } catch (e) {
    console.error('rules:logs create error', e);
    return res.status(500).json({ error: 'logs create failed' });
  }
});

// ---------------------------------------------------------------------
// ALERT DEFINITIONS
// ---------------------------------------------------------------------

// List alerts
app.get('/api/alerts', async (req, res) => {
  try {
    const snap = await alertsRef.once('value');
    const obj  = snap.val() || {};
    const items = Object.values(obj);
    res.json({ items });
  } catch (err) {
    console.error('alerts:list error', err);
    res.status(500).json({ error: 'alerts list failed' });
  }
});

// Create alert
app.post('/api/alerts', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.name)      return res.status(400).json({ error: 'name required' });
    if (!body.severity)  return res.status(400).json({ error: 'severity required' });

    const id = 'alert_' + Math.random().toString(36).slice(2, 10);
    const alert = {
      id,
      name: String(body.name),
      enabled: body.enabled !== false,
      severity: body.severity || 'warn',           // 'info' | 'warn' | 'crit'
      scope: body.scope || { mode: 'any' },        // { mode:'any' } or { mode:'room', room:'WWH015' }
      conditions: Array.isArray(body.conditions) ? body.conditions : [],
      holdSec: Number(body.holdSec ?? 30),         // must stay breached for this long
      cooldownSec: Number(body.cooldownSec ?? 300),
      createdAt: nowISO(),
      updatedAt: nowISO(),
      lastFiredAt: null,
      fireCount: 0
    };

    await alertsRef.child(id).set(alert);
    res.json({ ok: true, id, alert });
  } catch (err) {
    console.error('alerts:create error', err);
    res.status(500).json({ error: 'alerts create failed' });
  }
});

// Update alert
app.put('/api/alerts/:id', async (req, res) => {
  try {
    const id    = req.params.id;
    const patch = { ...req.body, updatedAt: nowISO() };
    await alertsRef.child(id).update(patch);
    const snap = await alertsRef.child(id).once('value');
    res.json({ ok: true, alert: snap.val() });
  } catch (err) {
    console.error('alerts:update error', err);
    res.status(500).json({ error: 'alerts update failed' });
  }
});

// Delete alert
app.delete('/api/alerts/:id', async (req, res) => {
  try {
    const id = req.params.id;
    await alertsRef.child(id).remove();
    res.json({ ok: true });
  } catch (err) {
    console.error('alerts:delete error', err);
    res.status(500).json({ error: 'alerts delete failed' });
  }
});

// ---------------------------------------------------------------------
// ALERT EVENTS (individual alert firings)
// ---------------------------------------------------------------------

// List recent events (for Alerts tab & badge)
app.get('/api/alerts/events', async (req, res) => {
  try {
    const limit     = Number(req.query.limit || 200);
    const severity  = req.query.severity || null;
    const onlyOpen  = req.query.onlyOpen === '1';

    let query = alertEventsRef.orderByChild('ts').limitToLast(limit);
    const snap = await query.once('value');
    const obj  = snap.val() || {};
    let items  = Object.values(obj);

    if (severity) items = items.filter(e => e.severity === severity);
    if (onlyOpen) items = items.filter(e => !e.acked);

    // newest first
    items.sort((a, b) => (b.ts || 0) - (a.ts || 0));

    res.json({ items });
  } catch (err) {
    console.error('alerts:events list error', err);
    res.status(500).json({ error: 'alerts events list failed' });
  }
});

// Record a fired alert
app.post('/api/alerts/events', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.alertId) return res.status(400).json({ error: 'alertId required' });

    const id = 'ev_' + Math.random().toString(36).slice(2, 10);
    const now = Date.now();

    const ev = {
      id,
      alertId:  body.alertId,
      name:     body.name     || '',
      severity: body.severity || 'warn',
      room:     body.room     || null,
      message:  body.message  || '',
      values:   body.values   || {},   // { metric:value, ... }
      ts:       body.ts || now,
      tsISO:    new Date(body.ts || now).toISOString(),
      acked:    false,
      ackedAt:  null
    };

    await alertEventsRef.child(id).set(ev);

    // also bump alert's metadata if present
    await alertsRef.child(body.alertId).update({
      lastFiredAt: ev.tsISO,
      fireCount: admin.database.ServerValue.increment(1)
    });

    res.json({ ok: true, event: ev });
  } catch (err) {
    console.error('alerts:events create error', err);
    res.status(500).json({ error: 'alerts events create failed' });
  }
});

// Acknowledge / close an event
app.post('/api/alerts/events/:id/ack', async (req, res) => {
  try {
    const id = req.params.id;
    const patch = { acked: true, ackedAt: nowISO() };
    await alertEventsRef.child(id).update(patch);
    res.json({ ok: true });
  } catch (err) {
    console.error('alerts:ack error', err);
    res.status(500).json({ error: 'alerts ack failed' });
  }
});


// ---------- Start ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`APS server running at http://localhost:${PORT}`);
});
