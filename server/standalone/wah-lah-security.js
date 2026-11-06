import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const REGISTRY_PATH = process.env.WAH_LAH_CAMERA_REGISTRY || '/data/SECURITY_CAMERA_MASTER/CAMERA_REGISTRY.json';
const CREDENTIALS_PATH = process.env.WAH_LAH_CAMERA_CREDENTIALS || '/home/justin/.config/genie/wah-lah-camera-credentials.json';
const RECORDING_ROOT = process.env.WAH_LAH_RECORDING_ROOT || '/data/camera-clips';
const EVENT_DIR = path.join(RECORDING_ROOT, 'events');
const EVENT_LOG = path.join(EVENT_DIR, 'events.jsonl');
const CLIP_INDEX = path.join(RECORDING_ROOT, 'clip-index.jsonl');
const RECORDER_STATUS = path.join(RECORDING_ROOT, 'recorder-status.json');
const BUFFER_ROOT = process.env.WAH_LAH_BUFFER_ROOT || '/dev/shm/wah-lah-camera-buffer';
const MAX_BODY = 16 * 1024;

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(payload));
}
function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); }
  catch (error) { return { schema_version: 1, application: 'wah-lah-security', cameras: [], adt_targets: [], error: error.message }; }
}
function loadCredentials() {
  try { return JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8')); }
  catch { return {}; }
}
function loadRecorderStatus() {
  try { return JSON.parse(fs.readFileSync(RECORDER_STATUS, 'utf8')); }
  catch { return { state: 'starting', engine: 'wah-lah-multicamera-hls-ring', cameras: [], active_event_sessions: 0 }; }
}
function readClipIndex(limit = 100) {
  try {
    return fs.readFileSync(CLIP_INDEX, 'utf8').split('\n').filter(Boolean).slice(-limit).reverse()
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((row) => row && typeof row.clip_id === 'string');
  } catch { return []; }
}
function findClipFolder(clipId) {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(clipId)) return null;
  try {
    for (const day of fs.readdirSync(EVENT_DIR, { withFileTypes: true })) {
      if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) continue;
      const dayPath = path.join(EVENT_DIR, day.name);
      for (const camera of fs.readdirSync(dayPath, { withFileTypes: true })) {
        if (!camera.isDirectory() || !/^[A-Za-z0-9_-]{1,80}$/.test(camera.name)) continue;
        const cameraPath = path.join(dayPath, camera.name);
        for (const event of fs.readdirSync(cameraPath, { withFileTypes: true })) {
          if (!event.isDirectory() || !/^[A-Za-z0-9-]{16,64}$/.test(event.name)) continue;
          const folder = path.join(cameraPath, event.name);
          const manifestPath = path.join(folder, 'manifest.json');
          if (!fs.existsSync(manifestPath)) continue;
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (manifest.clip_id === clipId) return folder;
        }
      }
    }
  } catch {}
  return null;
}
function streamFile(res, filename, mime, cache = 'no-store') {
  let stat;
  try { stat = fs.statSync(filename); }
  catch { return sendJson(res, 404, { error: 'Media file not available' }); }
  if (!stat.isFile()) return sendJson(res, 404, { error: 'Media file not available' });
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Cache-Control': cache,
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes',
  });
  const stream = fs.createReadStream(filename);
  stream.on('error', () => { if (!res.headersSent) sendJson(res, 500, { error: 'Media read failed' }); else res.destroy(); });
  stream.pipe(res);
}
function tcpCheck(host, port, timeoutMs = 900) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const done = (open) => { if (settled) return; settled = true; socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
async function pingCheck(host) {
  try { await execFileAsync('ping', ['-c', '1', '-W', '1', host], { timeout: 1800, maxBuffer: 32768 }); return true; }
  catch { return false; }
}
function authHeader(req) {
  const remote = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  const loopback = remote === '127.0.0.1' || remote === '::1';
  return sameOrigin(req) || (loopback && !req.headers.origin);
}
function sameOrigin(req) {
  if (!req.headers.origin || !req.headers.host) return false;
  try {
    const url = new URL(req.headers.origin);
    const protocol = req.socket.encrypted ? 'https:' : 'http:';
    return url.origin === protocol + '//' + req.headers.host;
  } catch { return false; }
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function appendEvent(event) {
  fs.mkdirSync(EVENT_DIR, { recursive: true, mode: 0o750 });
  fs.appendFileSync(EVENT_LOG, JSON.stringify(event) + '\n', { mode: 0o640 });
}
function readEvents(limit = 100) {
  try {
    return fs.readFileSync(EVENT_LOG, 'utf8').split('\n').filter(Boolean).slice(-limit).reverse()
      .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function securityLink() {
  return '<a id="wah-lah-security-link" href="/security" title="Open the unified WAH-LAH security console"><span>●</span> WAH-LAH SECURITY</a>' +
    '<style>#wah-lah-security-link{position:fixed;z-index:100000;right:20px;top:18px;padding:10px 14px;border:1px solid rgba(58,220,195,.55);border-radius:8px;background:rgba(5,15,22,.92);color:#c9fff4;font:700 11px/1.1 ui-monospace,monospace;letter-spacing:.12em;text-decoration:none;box-shadow:0 8px 28px #0008;backdrop-filter:blur(12px)}#wah-lah-security-link span{color:#37e1b8;margin-right:6px}#wah-lah-security-link:hover{background:#12302d;border-color:#37e1b8}</style>';
}
function streamUrl(camera, credentials, streamPath) {
  const user = encodeURIComponent(credentials.username);
  const pass = encodeURIComponent(credentials.password);
  return 'rtsp://' + user + ':' + pass + '@' + camera.address + ':' + camera.port + streamPath;
}
async function probeStream(camera, credentials) {
  const paths = [camera.stream_path, ...(camera.alternate_stream_paths || [])]
    .filter((value) => typeof value === 'string' && value.startsWith('/'));
  let last = 'no_valid_stream_path';
  for (const streamPath of paths) {
    const url = streamUrl(camera, credentials, streamPath);
    try {
      const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error', '-rtsp_transport', 'tcp', '-rw_timeout', '5000000',
        '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', url
      ], { timeout: 8000, maxBuffer: 65536 });
      const data = JSON.parse(stdout || '{}');
      const video = (data.streams || []).find((stream) => stream.codec_type === 'video');
      if (video) return { ok: true, path: streamPath, video: { codec: video.codec_name || null, width: video.width || null, height: video.height || null } };
      last = 'no_video_stream';
    } catch (error) {
      const message = String(error.stderr || error.message || '').toLowerCase();
      last = /401|unauthorized|authentication/.test(message) ? 'authentication_failed' :
        /timed out|timeout/.test(message) ? 'stream_timeout' : 'stream_unavailable';
    }
  }
  return { ok: false, reason: last };
}
export function wahLahSecurityPlugin() {
  let cachedHealth = null;
  let checkedAt = 0;
  let checkFlight = null;

  async function health() {
    if (cachedHealth && Date.now() - checkedAt < 5000) return cachedHealth;
    if (checkFlight) return checkFlight;
    checkFlight = (async () => {
      const registry = loadRegistry();
      const credentials = loadCredentials();
      const cameraChecks = await Promise.all((registry.cameras || []).map(async (camera) => {
        if (camera.port) {
          const open = await tcpCheck(camera.address, camera.port);
          if (!open) {
            const online = await pingCheck(camera.address);
            return { id: camera.id, name: camera.name, address: camera.address, port: camera.port,
              status: online ? 'host_online_camera_server_not_started' : 'unreachable', video: 'not_configured' };
          }
          const secret = credentials[camera.id];
          if (!secret) return { id: camera.id, name: camera.name, address: camera.address, port: camera.port, status: 'rtsp_auth_required', video: 'awaiting_valid_credentials' };
          const probe = await probeStream(camera, secret);
          return { id: camera.id, name: camera.name, address: camera.address, port: camera.port,
            status: probe.ok ? 'video_stream_verified' : probe.reason,
            stream_path: probe.path || null, video: probe.video || null };
        }
        const online = await pingCheck(camera.address);
        return { id: camera.id, name: camera.name, address: camera.address,
          status: online ? 'host_online_stream_service_missing' : 'unreachable', video: 'not_configured' };
      }));
      const edge = registry.hosts && registry.hosts.edge;
      const edgeOnline = edge && edge.tailscale_address ? await pingCheck(edge.tailscale_address) : false;
      let storage = {};
      try {
        const root = registry.hosts && registry.hosts.primary && registry.hosts.primary.recording_root || RECORDING_ROOT;
        const stat = fs.statfsSync(root);
        const total = Number(stat.blocks) * Number(stat.bsize);
        const available = Number(stat.bavail) * Number(stat.bsize);
        storage = { path: root, total_bytes: total, available_bytes: available,
          used_percent: total ? Math.round((total - available) / total * 1000) / 10 : null };
      } catch (error) { storage = { error: error.message }; }
      const recorder = loadRecorderStatus();
      cachedHealth = {
        checked_at: new Date().toISOString(),
        cameras: cameraChecks,
        adt: await Promise.all((registry.adt_targets || []).map(async (item) => {
          const webPort = item.ports && item.ports["80"] === "open_http" ? 80 :
            item.address && item.transport === "local_http_https_digest_auth" ? 80 : null;
          const reachable = webPort ? await tcpCheck(item.address, webPort) : false;
          return {
            id: item.id,
            name: item.name,
            product: item.product || null,
            address: item.address || null,
            candidate_addresses: item.candidate_addresses || [],
            hostname: item.hostname || null,
            manufacturer: item.manufacturer || null,
            status: reachable && item.transport === "local_http_https_digest_auth"
              ? "local_panel_auth_required"
              : item.status || "integration_pending",
            validation: item.validation || {},
            capabilities: item.capabilities || {},
          };
        })),
        edge: { name: edge && edge.hostname || 'dhakidd-inspir04',
          address: edge && edge.tailscale_address || null,
          status: edgeOnline ? 'online' : 'unreachable',
          detector: 'MobileNet-SSD / OpenCV edge service; event transport status requires validation' },
        recording: {
          mode: registry.recording && registry.recording.mode || 'event_gated_with_bounded_rolling_buffer',
          engine: recorder.engine || 'wah-lah-multicamera-hls-ring',
          engine_state: recorder.state || 'starting',
          pre_event_buffer_seconds: recorder.pre_event_seconds || registry.recording?.pre_event_seconds || 30,
          post_event_seconds: recorder.post_event_seconds || registry.recording?.post_event_seconds || 30,
          segment_seconds: recorder.segment_seconds || registry.recording?.segment_seconds || 60,
          retention_hours: recorder.retention_hours || registry.recording?.retention_hours || 24,
          max_gb: registry.recording && registry.recording.max_gb || 120,
          active_event_sessions: recorder.active_event_sessions || 0,
          cameras: recorder.cameras || [],
        },
        storage, events_count: readEvents(1000).length,
      };
      checkedAt = Date.now();
      return cachedHealth;
    })().finally(() => { checkFlight = null; });
    return checkFlight;
  }

  return {
    name: 'wah-lah-security-console',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url || '/', 'http://localhost').pathname;
        if (pathname === '/security' || pathname === '/security/') {
          try {
            const html = fs.readFileSync(path.resolve(process.cwd(), 'public/wah-lah-security.html'));
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
            res.end(html);
          } catch (error) { sendJson(res, 500, { error: 'Security console could not be loaded', detail: error.message }); }
          return;
        }
        if (!pathname.startsWith('/api/wah-lah/security/')) return next();
        const endpoint = pathname.slice('/api/wah-lah/security'.length);
        try {
          if (req.method === 'GET' && endpoint === '/registry') { sendJson(res, 200, loadRegistry()); return; }
          if (req.method === 'GET' && endpoint === '/health') { sendJson(res, 200, await health()); return; }
          if (req.method === 'GET' && endpoint === '/events') { sendJson(res, 200, { events: readEvents(100) }); return; }
          if (req.method === 'GET' && endpoint === '/recording') { sendJson(res, 200, loadRecorderStatus()); return; }
          if (req.method === 'GET' && endpoint === '/clips') {
            const clips = readClipIndex(100).map((clip) => {
              const folder = findClipFolder(clip.clip_id);
              if (!folder) return null;
              const mp4 = path.join(folder, 'event.mp4');
              return {
                ...clip,
                playlist_url: '/api/wah-lah/security/clips/' + clip.clip_id + '/index.m3u8',
                mp4_url: fs.existsSync(mp4) ? '/api/wah-lah/security/clips/' + clip.clip_id + '/event.mp4' : null,
              };
            }).filter(Boolean);
            sendJson(res, 200, { clips });
            return;
          }
          const liveMatch = endpoint.match(/^\/live\/([A-Za-z0-9_-]{1,80})\/(index\.m3u8|seg_\d{8}_\d{6}\.ts)$/);
          if (req.method === 'GET' && liveMatch) {
            const [, cameraId, filename] = liveMatch;
            const cameraExists = (loadRegistry().cameras || []).some((camera) => camera.id === cameraId);
            if (!cameraExists) { sendJson(res, 404, { error: 'Unknown camera' }); return; }
            const file = path.join(BUFFER_ROOT, cameraId, filename);
            streamFile(res, file, filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
              filename.endsWith('.m3u8') ? 'no-store' : 'public, max-age=2');
            return;
          }
          const clipMatch = endpoint.match(/^\/clips\/([A-Za-z0-9_-]{1,120})\/(index\.m3u8|event\.mp4|seg_\d{8}_\d{6}\.ts)$/);
          if (req.method === 'GET' && clipMatch) {
            const [, clipId, filename] = clipMatch;
            const folder = findClipFolder(clipId);
            if (!folder) { sendJson(res, 404, { error: 'Clip not found' }); return; }
            const file = path.join(folder, filename);
            streamFile(res, file, filename.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' :
              filename.endsWith('.mp4') ? 'video/mp4' : 'video/mp2t');
            return;
          }
          if (req.method === 'POST' && (endpoint === '/credentials/test' || endpoint === '/credentials')) {
            if (!authHeader(req)) { sendJson(res, 403, { error: 'Same-origin request required' }); return; }
            const body = await readBody(req);
            const registry = loadRegistry();
            const camera = (registry.cameras || []).find((item) => item.id === String(body.camera_id || ''));
            if (!camera || camera.transport !== 'rtsp' || !camera.port) {
              sendJson(res, 400, { error: 'Credentials can only be set for registered RTSP cameras' }); return;
            }
            const username = String(body.username || '').trim();
            const password = String(body.password || '');
            if (!username || !password || username.length > 128 || password.length > 256 || /[\r\n]/.test(username + password)) {
              sendJson(res, 400, { error: 'Enter a valid camera username and password' }); return;
            }
            const probe = await probeStream(camera, { username, password });
            if (!probe.ok) {
              const message = probe.reason === 'authentication_failed' ? 'Camera rejected those credentials' :
                probe.reason === 'stream_timeout' ? 'Camera timed out while opening the video stream' :
                'No video was decoded; check the login and camera stream availability';
              sendJson(res, 401, { error: message, reason: probe.reason });
              return;
            }
            const credentials = loadCredentials();
            credentials[camera.id] = { username, password };
            const directory = path.dirname(CREDENTIALS_PATH);
            fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
            try { fs.chmodSync(directory, 0o700); } catch {}
            const temporary = CREDENTIALS_PATH + '.tmp';
            fs.writeFileSync(temporary, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600, flag: 'w' });
            fs.chmodSync(temporary, 0o600);
            fs.renameSync(temporary, CREDENTIALS_PATH);
            fs.chmodSync(CREDENTIALS_PATH, 0o600);
            cachedHealth = null;
            sendJson(res, 200, { camera_id: camera.id, status: 'video_stream_verified', stream_path: probe.path,
              video: probe.video, credentials_saved: true });
            return;
          }
          if (req.method === 'POST' && endpoint === '/events') {
            if (!authHeader(req)) {
              const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
              const eventToken = process.env.WAH_LAH_EVENT_TOKEN || '';
              if (!eventToken || !bearer || bearer !== eventToken) {
                sendJson(res, 403, { error: 'Same-origin request or authorized edge token required' }); return;
              }
            }
            const body = await readBody(req);
            const registry = loadRegistry();
            const ids = new Set([...(registry.cameras || []).map((camera) => camera.id), 'all']);
            const types = new Set(['manual_bookmark', 'motion', 'person', 'vehicle', 'object', 'offline']);
            const cameraId = String(body.camera_id || 'all');
            const eventType = String(body.type || '');
            if (!ids.has(cameraId) || !types.has(eventType)) {
              sendJson(res, 400, { error: 'Unknown camera_id or unsupported event type' }); return;
            }
            const event = {
              event_id: crypto.randomUUID(), timestamp: new Date().toISOString(), camera_id: cameraId,
              type: eventType,
              confidence: Number.isFinite(Number(body.confidence)) ? Math.max(0, Math.min(1, Number(body.confidence))) : null,
              source: String(body.source || (eventType === 'manual_bookmark' ? 'operator' : 'edge_node')).slice(0, 64),
              note: String(body.note || '').slice(0, 300),
              video_capture: eventType === 'offline' ? 'alert_only' : 'queued_for_recorder',
            };
            appendEvent(event);
            cachedHealth = null;
            sendJson(res, 201, { event, message: 'Event saved; recorder will commit available pre-event and post-event video when that camera buffer is active.' });
            return;
          }
          sendJson(res, 404, { error: 'Unknown WAH-LAH security endpoint' });
        } catch (error) { sendJson(res, 400, { error: error.message || 'Request failed' }); }
      });
    },
    transformIndexHtml(html) { return html.replace('</body>', securityLink() + '</body>'); },
  };
}
