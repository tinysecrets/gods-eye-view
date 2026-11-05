#!/usr/bin/env node
/**
 * Local-only synthetic feed server for God's Eye View.
 * Every record is invented demo data. No upstream provider is contacted.
 */
import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = Number(process.env.GEV_MOCK_PORT || 4174);
const now = () => new Date().toISOString();
const wrap = (kind, records) => ({
  mode: 'SIMULATED_DEMO_DATA',
  simulated: true,
  source: 'Gods Eye View local demo server',
  kind,
  generatedAt: now(),
  count: records.length,
  records,
});

const feeds = {
  aircraft: () => wrap('aircraft', [
    { id: 'DEMO-AAL204', callsign: 'DEMO204', type: 'B738', lat: 32.3792, lon: -86.3077, altitudeFt: 18200, speedKt: 284, heading: 91, status: 'SIMULATED' },
    { id: 'DEMO-SWA771', callsign: 'DEMO771', type: 'B737', lat: 33.5207, lon: -86.8025, altitudeFt: 24100, speedKt: 312, heading: 18, status: 'SIMULATED' },
    { id: 'DEMO-JET052', callsign: 'DEMO052', type: 'C172', lat: 30.6954, lon: -88.0399, altitudeFt: 4500, speedKt: 102, heading: 270, status: 'SIMULATED' },
    { id: 'DEMO-INTL9', callsign: 'DEMO9', type: 'A320', lat: 34.7304, lon: -86.5861, altitudeFt: 32000, speedKt: 438, heading: 355, status: 'SIMULATED' },
  ]),
  ships: () => wrap('ships', [
    { id: 'DEMO-MV01', name: 'DEMO CARGO ONE', mmsi: '000000001', lat: 30.6954, lon: -88.0399, speedKt: 12.4, heading: 42, vesselType: 'Cargo', status: 'SIMULATED' },
    { id: 'DEMO-MV02', name: 'DEMO TANKER TWO', mmsi: '000000002', lat: 29.9511, lon: -90.0715, speedKt: 8.1, heading: 185, vesselType: 'Tanker', status: 'SIMULATED' },
    { id: 'DEMO-MV03', name: 'DEMO FERRY THREE', mmsi: '000000003', lat: 27.9506, lon: -82.4572, speedKt: 15.2, heading: 90, vesselType: 'Passenger', status: 'SIMULATED' },
  ]),
  fires: () => wrap('fires', [
    { id: 'DEMO-FIRE-01', lat: 32.42, lon: -86.25, confidence: 0.91, brightnessK: 318, label: 'SYNTHETIC FIRE MARKER', status: 'SIMULATED_NOT_A_REAL_FIRE' },
    { id: 'DEMO-FIRE-02', lat: 33.04, lon: -87.56, confidence: 0.78, brightnessK: 302, label: 'SYNTHETIC FIRE MARKER', status: 'SIMULATED_NOT_A_REAL_FIRE' },
  ]),
  traffic: () => wrap('traffic', [
    { id: 'DEMO-ROAD-01', name: 'DEMO I-65 segment', lat: 32.3792, lon: -86.3077, speedKph: 38, freeFlowKph: 95, congestion: 'HEAVY_SIMULATED' },
    { id: 'DEMO-ROAD-02', name: 'DEMO US-80 segment', lat: 32.3668, lon: -86.2999, speedKph: 62, freeFlowKph: 70, congestion: 'MODERATE_SIMULATED' },
    { id: 'DEMO-ROAD-03', name: 'DEMO I-85 segment', lat: 32.4074, lon: -86.2352, speedKph: 88, freeFlowKph: 90, congestion: 'CLEAR_SIMULATED' },
  ]),
  earthquakes: () => wrap('earthquakes', [
    { id: 'DEMO-QUAKE-01', lat: 34.0522, lon: -118.2437, magnitude: 3.8, depthKm: 8, label: 'SYNTHETIC EVENT — NOT A REAL EARTHQUAKE' },
    { id: 'DEMO-QUAKE-02', lat: 37.7749, lon: -122.4194, magnitude: 2.6, depthKm: 12, label: 'SYNTHETIC EVENT — NOT A REAL EARTHQUAKE' },
  ]),
};

const page = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>God's Eye View · Local Demo Feeds</title><style>
:root{color-scheme:dark;font:15px system-ui;background:#080d12;color:#e8f3f4}body{max-width:980px;margin:40px auto;padding:0 22px}h1{letter-spacing:.02em}p{color:#a8bdc1}.tag{color:#65e6c2;font-weight:700}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px}.card{background:#111c23;border:1px solid #27404a;border-radius:12px;padding:16px}.card a{color:#80d8ff;text-decoration:none}.card a:hover{text-decoration:underline}code{color:#9fe8d1}.warn{border-left:3px solid #e5b75c;padding:10px 14px;background:#241f14;color:#f2d99d}button{background:#123c3c;border:1px solid #347c76;color:#e8ffff;padding:10px 14px;border-radius:8px;cursor:pointer}
</style><body><div class="tag">LOCAL ONLY · SYNTHETIC DATA</div><h1>God's Eye View — Demo Feed Lab</h1><p>These endpoints return invented records for interface testing. They do not contact AIS, NASA, OpenSky, TomTom, Google, or any real-world data provider.</p><div class="warn"><b>Important:</b> Aircraft, ships, traffic, fire markers and earthquake markers below are fictional. They are not observations, alerts, or emergency information.</div><p><a href="http://127.0.0.1:4173/?setup=1">← Open God's Eye View</a></p><div class="grid">
${Object.keys(feeds).map(k=>`<section class="card"><h3>${k[0].toUpperCase()+k.slice(1)}</h3><p>Simulated JSON feed</p><a href="/api/${k}">Open /api/${k}</a></section>`).join('')}
<section class="card"><h3>Combined feed</h3><p>All simulated categories</p><a href="/api/all">Open /api/all</a></section><section class="card"><h3>Health</h3><p>Server status and safety flags</p><a href="/health">Open /health</a></section></div><p>Base URL: <code>http://127.0.0.1:${PORT}</code></p><p><button onclick="location.reload()">Refresh demo timestamps</button></p></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-GEV-Data-Mode', 'SIMULATED');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); return res.end('GET only'); }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(page);
  }
  if (url.pathname === '/health' || url.pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'gev-local-mock', host: HOST, port: PORT, simulated: true, upstreamConnections: false, timestamp: now() }, null, 2));
  }
  if (url.pathname === '/api/all') {
    const result = Object.fromEntries(Object.entries(feeds).map(([k, fn]) => [k, fn()]));
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(result, null, 2));
  }
  const key = url.pathname.match(/^\/api\/(aircraft|ships|fires|traffic|earthquakes)$/)?.[1];
  if (key) {
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(feeds[key](), null, 2));
  }
  res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'not_found', available: ['/health','/api/status','/api/all', ...Object.keys(feeds).map(k=>'/api/'+k)] }));
});
server.listen(PORT, HOST, () => console.log(`[GEV MOCK] listening at http://${HOST}:${PORT} — synthetic data only; no upstream calls`));
server.on('error', e => { console.error('[GEV MOCK] startup failed:', e.message); process.exitCode = 1; });
