// herdr-term bridge: serves the web client and relays between the browser and
// Herdr's JSON API. Pane content is pushed as full ANSI frames; input goes back
// as pane.send_text / pane.send_keys.
//
// It also fronts two things that aren't Herdr at all — a read-only file browser
// and desktop control — so that everything sits on the single origin Cloudflare
// Access protects.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import * as herdr from './herdr.mjs';
import * as auth from './auth.mjs';
import * as sessions from './sessions.mjs';
import * as files from './files.mjs';
import * as desktop from './desktop.mjs';
import * as moonlight from './proxy.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, '..', 'public');

const HOST = process.env.HERDR_TERM_HOST || '127.0.0.1';
const PORT = Number(process.env.HERDR_TERM_PORT || 8790);
// Full repaint cadence; event pushes handle the responsive path.
const POLL_MS = Number(process.env.HERDR_TERM_POLL_MS || 1000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

// A cross-site page can POST a form as text/plain with a JSON body and no
// preflight, so a browsing session on this origin would otherwise be enough to
// drive the desktop. Require a JSON content type, and reject a cross-origin
// Origin outright.
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl, and same-origin GETs
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function requireJsonPost(req) {
  if (!sameOrigin(req)) {
    const err = new Error("cross-origin request refused");
    err.status = 403;
    throw err;
  }
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
    const err = new Error("content-type must be application/json");
    err.status = 415;
    throw err;
  }
}

// Small bodies only — every POST here is a handful of fields.
function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;

  // --- files: read-only, confined to files.ROOT ---------------------------
  if (p === '/api/fs/list') return json(res, 200, await files.list(q.get('path') ?? ''));
  if (p === '/api/fs/text') return json(res, 200, await files.readText(q.get('path') ?? ''));
  if (p === '/api/fs/raw') {
    const t = await files.rawTarget(q.get('path') ?? '');
    const download = q.get('download') === '1';
    // Only known raster types are served inline. Anything else — SVG included,
    // since it can carry script — is sent as an attachment on this origin.
    const inline = !download && t.mime;
    res.writeHead(200, {
      'content-type': inline ? t.mime : 'application/octet-stream',
      'content-length': t.size,
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'cache-control': 'no-store',
      'content-disposition':
        `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(t.name)}`,
    });
    return fs.createReadStream(t.abs).pipe(res);
  }

  // --- desktop -----------------------------------------------------------
  if (p === '/api/desktop/status') {
    const [up, streamUp] = await Promise.all([desktop.sessionUp(), desktop.tcpOpen(moonlight.PORT)]);
    return json(res, 200, {
      session: up,
      monitors: up ? await desktop.monitors().catch(() => []) : [],
      moonlight: { up: streamUp, prefix: moonlight.PREFIX, port: moonlight.PORT },
      sunshine: await desktop.tcpOpen(47989),
    });
  }
  if (p === '/api/desktop/shortcuts') return json(res, 200, { shortcuts: await desktop.shortcuts() });
  if (p === '/api/desktop/screen.jpg') {
    const img = await desktop.screenshot({
      output: q.get('output') || undefined,
      quality: q.get('quality'),
      scale: q.get('scale'),
    });
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': img.length, 'cache-control': 'no-store' });
    return res.end(img);
  }
  if (req.method === 'POST' && p === '/api/desktop/dispatch') {
    requireJsonPost(req);
    const body = await readJson(req);
    return json(res, 200, await desktop.dispatch(body.id));
  }
  if (req.method === 'POST' && p === '/api/desktop/key') {
    requireJsonPost(req);
    const body = await readJson(req);
    return json(res, 200, await desktop.sendKey(body.key, body.mods ?? []));
  }
  if (req.method === 'POST' && p === '/api/desktop/type') {
    requireJsonPost(req);
    const body = await readJson(req);
    return json(res, 200, await desktop.typeText(body.text));
  }

  if (req.method === 'POST' && p === '/api/desktop/pointer') {
    requireJsonPost(req);
    const body = await readJson(req);
    return json(res, 200, await desktop.pointer(body));
  }

  return json(res, 404, { error: 'no such endpoint' });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  if (rel === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  const gate = auth.checkRequest(req, url);
  if (!gate.ok) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('unauthorized: append ?t=<token> once to set the session cookie');
  }
  // Move the token out of the URL so it stops leaking via history and referrers.
  if (gate.viaQuery) {
    res.writeHead(302, { location: rel, 'set-cookie': auth.setCookieHeader() });
    return res.end();
  }

  if (moonlight.handles(url.pathname)) return moonlight.proxyHttp(req, res);

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url).catch(err =>
      json(res, err.status ?? 500, { error: err.message }));
  }

  // Contain path traversal: resolve, then require the result stay in PUBLIC_DIR.
  const filePath = path.join(PUBLIC_DIR, rel);
  if (path.relative(PUBLIC_DIR, filePath).startsWith('..')) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(filePath, (err, body) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(body);
  });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, sock, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (!auth.checkRequest(req, url).ok) {
    sock.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return sock.destroy();
  }
  // WebSocket upgrades bypass CORS entirely, so a cross-site page could open
  // one and drive the terminal with the visitor's Access session.
  if (!sameOrigin(req)) {
    sock.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return sock.destroy();
  }
  // The stream's own socket goes straight through to moonlight-web.
  if (moonlight.handles(url.pathname)) return moonlight.proxyUpgrade(req, sock, head);
  if (url.pathname !== '/ws') {
    sock.write('HTTP/1.1 404 Not Found\r\n\r\n');
    return sock.destroy();
  }
  wss.handleUpgrade(req, sock, head, ws => wss.emit('connection', ws, req));
});
const hash = s => crypto.createHash('sha1').update(s).digest('hex');

wss.on('connection', socket => {
  let paneId = null;
  let lastFrame = null;
  let inFlight = false;

  const send = msg => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  };

  async function pushPanes() {
    try {
      send({ type: 'panes', panes: await herdr.listPanes() });
    } catch (err) {
      send({ type: 'error', message: `pane.list failed: ${err.message}` });
    }
  }

  // Session list, pushed on agent/pane events. Coalesced because a single
  // status change can fan out into several events at once.
  let watchingSessions = false;
  let sessionsTimer = null;

  async function pushSessions() {
    if (!watchingSessions) return;
    try {
      send({ type: 'sessions', sessions: await sessions.listSessions() });
    } catch (err) {
      send({ type: 'error', message: `session list failed: ${err.message}` });
    }
  }

  function scheduleSessions() {
    if (!watchingSessions || sessionsTimer) return;
    sessionsTimer = setTimeout(() => {
      sessionsTimer = null;
      pushSessions();
    }, 250);
  }

  // Herdr has no content diffing over the JSON API, so we pull the visible
  // frame and only forward it when it actually changed.
  async function pushFrame(force = false) {
    if (!paneId || inFlight) return;
    inFlight = true;
    try {
      const read = await herdr.readPane(paneId, { source: 'visible', format: 'ansi' });
      const text = read.text ?? '';
      const sig = hash(text);
      if (!force && sig === lastFrame) return;
      lastFrame = sig;

      const geom = (await herdr.paneGeometry()).get(paneId) ?? { cols: 80, rows: 24 };
      send({ type: 'frame', paneId, text, cols: geom.cols, rows: geom.rows });
    } catch (err) {
      send({ type: 'error', message: `pane.read failed: ${err.message}` });
    } finally {
      inFlight = false;
    }
  }

  socket.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      switch (msg.type) {
        case 'attach':
          paneId = msg.paneId;
          lastFrame = null;
          await pushFrame(true);
          break;
        case 'input':
          if (paneId) await herdr.sendText(paneId, msg.text);
          break;
        case 'keys':
          if (paneId) await herdr.sendKeys(paneId, msg.keys);
          break;
        case 'panes':
          await pushPanes();
          break;
        case 'sessions:watch':
          watchingSessions = true;
          send({ type: 'kinds', kinds: await sessions.agentKinds() });
          await pushSessions();
          break;
        case 'sessions:start': {
          const created = await sessions.createSession({
            kind: msg.kind,
            cwd: msg.cwd,
            name: msg.name,
            label: msg.label,
          });
          send({ type: 'session:started', session: created });
          await pushSessions();
          break;
        }
        case 'sessions:close':
          await sessions.closeSession(msg.workspaceId);
          if (paneId && paneId.startsWith(`${msg.workspaceId}:`)) paneId = null;
          await pushSessions();
          break;
        case 'sessions:prompt':
          await sessions.promptAgent(msg.target, msg.text);
          break;
      }
    } catch (err) {
      send({ type: 'error', message: err.message });
    }
  });

  const onEvent = () => { pushFrame(); scheduleSessions(); };
  events.on('event', onEvent);
  const poll = setInterval(() => { pushFrame(); scheduleSessions(); }, POLL_MS);

  socket.on('close', () => {
    clearInterval(poll);
    clearTimeout(sessionsTimer);
    events.off('event', onEvent);
  });

  pushPanes();
});

const events = new herdr.HerdrEvents([
  'pane.updated', 'pane.focused', 'pane.created',
  'pane.closed', 'pane.exited', 'tab.focused',
  // Agent lifecycle, so the session list reflects status without polling.
  // Not pane.agent_status_changed: that subscription is per-pane and requires a
  // pane_id, and subscribing without one makes Herdr drop the connection.
  // pane.updated already carries agent_status for every pane.
  'pane.agent_detected', 'workspace.created', 'workspace.closed',
]);
events.setMaxListeners(0);
events.on('open', () => console.log('[herdr] event subscription live'));
events.on('closed', () => console.warn('[herdr] event stream dropped; retrying'));

server.listen(PORT, HOST, async () => {
  try {
    const pong = await herdr.ping();
    console.log(`[herdr] connected: v${pong.version} protocol ${pong.protocol}`);
  } catch (err) {
    console.warn(`[herdr] not reachable at ${herdr.DEFAULT_SOCKET}: ${err.message}`);
  }
  console.log(`[files] serving ${files.ROOT} read-only`);
  console.log(`[desktop] hyprland session ${(await desktop.sessionUp()) ? 'found' : 'not found'}`);
  console.log(`herdr-term listening on http://${HOST}:${PORT}`);
  if (auth.AUTH_DISABLED) console.warn('[auth] bridge gate disabled — access control is upstream (Cloudflare Access)');
  else console.log(`[auth] open: http://${HOST}:${PORT}/?t=${auth.TOKEN}`);
});
