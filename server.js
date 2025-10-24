const express = require('express');
const axios = require('axios');
const path = require('path');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

require('dotenv').config();

// === APS credentials pulled from .env ===
const CLIENT_ID = process.env.APS_CLIENT_ID;
const CLIENT_SECRET = process.env.APS_CLIENT_SECRET;
const BUCKET_KEY = (process.env.APS_BUCKET || `${CLIENT_ID.toLowerCase()}-samples`).replace(/[^a-z0-9-]/g, '');

// --- Add near top after dotenv/config:
const MQTT_URL = process.env.MQTT_URL;           // e.g., wss://<cluster>.s1.eu.hivemq.cloud:8884/mqtt
const MQTT_USERNAME = process.env.MQTT_USERNAME; // hive user
const MQTT_PASSWORD = process.env.MQTT_PASSWORD; // hive pass
const MQTT_TOPICS = (process.env.MQTT_TOPICS || 'dt/dt-lab/+/telemetry')
  .split(',').map(s => s.trim()).filter(Boolean);

  // --- Influx: config + client (reads from .env) ---
const { InfluxDB } = require('@influxdata/influxdb-client');

const INFLUX_URL    = process.env.INFLUX_URL;        // e.g. https://us-east-1-1.aws.cloud2.influxdata.com
const INFLUX_ORG    = process.env.INFLUX_ORG;        // org name or ID
const INFLUX_BUCKET = process.env.INFLUX_BUCKET;     // bucket (e.g. dt_lab_raw)
const INFLUX_TOKEN  = process.env.INFLUX_TOKEN;      // read token

let influxQueryApi = null;
if (!INFLUX_URL || !INFLUX_ORG || !INFLUX_TOKEN) {
  console.warn('[Influx] Missing INFLUX_URL/ORG/TOKEN in .env — /api/series will be disabled');
} else {
  const influx = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN });
  influxQueryApi = influx.getQueryApi(INFLUX_ORG);
}

const queryApi = influxQueryApi

// server.js
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
  agg = "mean"                    // NEW
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
  const aggLine = skipAgg ? "" : `|> aggregateWindow(every: ${every}, fn: ${agg}, createEmpty: false)`; // NEW

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


// Build a Flux query that unions pipelines per field so we can choose fn per field.
function buildFluxUnion({
  bucket,
  measurement = 'env',
  device = '',
  fields = [],
  // time
  minutes = null,    // e.g. '60'
  startISO = null,   // optional explicit start
  stopISO  = null,   // optional explicit stop
  every = '1m',      // aggregation window
}) {
  const esc = (s) => String(s).replace(/"/g, '\\"');
  const timeClause =
    (startISO && stopISO)
      ? `|> range(start: time(v: "${esc(startISO)}"), stop: time(v: "${esc(stopISO)}"))`
      : `|> range(start: -${minutes ? Number(minutes) : 60}m)`;

  const deviceClause = device
    ? `|> filter(fn: (r) => r.device == "${esc(device)}")`
    : '';

  // Per-field aggregation: relay_num + energy_* use last, others mean
  const aggFor = (f) => (/^(relay_num|energy_wh|energy_kwh)$/i.test(f) ? 'last' : 'mean');

  // Build one named pipeline per field
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



// --- Add this route:
app.get('/api/mqtt/config', (req, res) => {
  if (!MQTT_URL || !MQTT_USERNAME || !MQTT_PASSWORD) {
    return res.status(500).json({ ok:false, error: 'MQTT env not set' });
  }
  // NOTE: This returns creds to the browser (same-origin). If you need stricter security,
  // switch to a server-side proxy or ephemeral creds strategy.
  res.json({
    ok: true,
    url: MQTT_URL,
    username: MQTT_USERNAME,
    password: MQTT_PASSWORD,
    topics: MQTT_TOPICS
  });
});


// === Token route (short-lived viewer token) ===
app.get('/api/token', async (req, res) => {
  try {
    const body = new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
      scope: 'viewables:read'   // <-- use this for the Viewer
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

// === Upload + translate route ===
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
    if (e?.response?.status !== 409) throw e; // already exists => OK
  }
}

// NEW upload route: signed S3 upload + confirm
function uniquifyName(name) {
  const i = name.lastIndexOf('.');
  const base = i > 0 ? name.slice(0, i) : name;
  const ext  = i > 0 ? name.slice(i) : '';
  return `${base}-${Date.now()}${ext}`;
}

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const CLIENT_ID  = process.env.APS_CLIENT_ID || '';
    const BUCKET_KEY = (process.env.APS_BUCKET || `${CLIENT_ID.toLowerCase()}-samples`).replace(/[^a-z0-9-]/g,'');
    const makeUnique = (req.query.unique === '1');

    await ensureBucket(BUCKET_KEY);

    const token = await getToken(['data:read','data:write','bucket:read','bucket:create']);

    const originalName = req.file.originalname;
    const objectName   = makeUnique ? uniquifyName(originalName) : originalName;

    // 1) get signed S3 URL
    const sign = await axios.get(
      `https://developer.api.autodesk.com/oss/v2/buckets/${BUCKET_KEY}/objects/${encodeURIComponent(objectName)}/signeds3upload`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const uploadKey = sign.data.uploadKey || sign.data.upload_key;
    const url = (sign.data.urls?.[0]) || sign.data.url;
    if (!uploadKey || !url) throw new Error('Signed S3 upload: missing uploadKey or url');

    // 2) PUT file to S3
    const put = await axios.put(url, req.file.buffer, {
      headers: { 'Content-Type': 'application/octet-stream' },
      maxContentLength: Infinity, maxBodyLength: Infinity,
      validateStatus: s => (s >= 200 && s < 300) || s === 204
    });
    const etag = put.headers.etag || put.headers.ETag || '';

    // 3) confirm upload
    await axios.post(
      `https://developer.api.autodesk.com/oss/v2/buckets/${BUCKET_KEY}/objects/${encodeURIComponent(objectName)}/signeds3upload`,
      { uploadKey, parts: [{ partNumber: 1, etag }] },
      { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
    );

    // 4) translate and return brand-new URN
    const urnRaw = `urn:adsk.objects:os.object:${BUCKET_KEY}/${objectName}`;
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

app.use(express.json());

app.post('/api/auth/verify', (req, res) => {
  const PASS = process.env.CONTROL_PASSWORD || process.env.APP_PASSWORD || '';
  const { password } = req.body || {};
  if (!PASS) return res.status(500).json({ ok:false, error:'Password not configured' });
  if (typeof password !== 'string') return res.status(400).json({ ok:false, error:'Bad request' });
  if (password === PASS) return res.json({ ok:true });
  return res.status(401).json({ ok:false });
});

// --- Time-series API ---
// GET /api/series?measurement=env&device=dtn-...&fields=temp_f,rh_pct&minutes=60&every=1m
// Or with explicit range: &start=2025-10-07T00:00:00Z&stop=2025-10-07T06:00:00Z
app.get("/api/series", async (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0, must-revalidate");

  const bucket      = process.env.INFLUX_BUCKET;
  const measurement = String(req.query.measurement || "env");
  const minutes     = req.query.minutes != null ? String(req.query.minutes) : "60";
  const every       = req.query.every != null   ? String(req.query.every)   : "1m";
  const start       = req.query.start ? String(req.query.start) : undefined;
  const stop        = req.query.stop  ? String(req.query.stop)  : undefined;
  const device      = (req.query.device || "").trim();
  const fields      = String(req.query.fields || "temp_c,rh_pct");
  const tagKey      = req.query.tagKey ? String(req.query.tagKey) : 'device'; 
  const aggRaw      = (req.query.agg || '').toString().toLowerCase(); // NEW
  const allowedAggs = new Set(['mean','median','max','min','last']);  // NEW
  const agg         = allowedAggs.has(aggRaw) ? aggRaw : 'mean';      // default

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


// === Start server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`APS server running at http://localhost:${PORT}`);
});