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

// === Start server ===
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`APS server running at http://localhost:${PORT}`);
});
