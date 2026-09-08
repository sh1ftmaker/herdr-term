// Reverse proxy for the moonlight-web stream server.
//
// moonlight-web runs on loopback under a url_path_prefix, and everything —
// page, API and the streaming WebSocket — is forwarded through this bridge.
// That keeps it on the same origin as the rest of herdr-term, so it inherits
// Cloudflare Access instead of needing a second hostname and policy.

import http from 'node:http';
import net from 'node:net';

export const PORT = Number(process.env.HERDR_TERM_MOONLIGHT_PORT || 8791);
export const PREFIX = process.env.HERDR_TERM_MOONLIGHT_PREFIX || '/moonlight';
const HOST = '127.0.0.1';

// Header moonlight-web is configured to trust for pre-authenticated users.
const FORWARD_USER = 'x-forwarded-user';
// Cloudflare Access stamps this on every request that passed its policy.
const ACCESS_EMAIL = 'cf-access-authenticated-user-email';

export const handles = pathname => pathname === PREFIX || pathname.startsWith(PREFIX + '/');

// Connection-level headers must not be forwarded verbatim.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

function forwardHeaders(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    // Drop any client-supplied identity header: only this proxy may set it,
    // otherwise anyone reaching the origin could name themselves.
    if (HOP_BY_HOP.has(k) || k === FORWARD_USER) continue;
    out[k] = v;
  }
  const email = req.headers[ACCESS_EMAIL];
  if (email) out[FORWARD_USER] = email;
  out.host = `${HOST}:${PORT}`;
  return out;
}

export function proxyHttp(req, res) {
  const upstream = http.request(
    { host: HOST, port: PORT, method: req.method, path: req.url, headers: forwardHeaders(req) },
    up => {
      res.writeHead(up.statusCode, up.headers);
      up.pipe(res);
    });
  upstream.on('error', err => {
    if (res.headersSent) return res.destroy();
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `moonlight-web is not reachable on ${HOST}:${PORT}`, detail: err.code }));
  });
  req.pipe(upstream);
}

// WebSocket upgrades are relayed as raw TCP: the stream itself rides one of
// these, so nothing may buffer or reframe it.
export function proxyUpgrade(req, socket, head) {
  const headers = forwardHeaders(req);
  const lines = [`${req.method} ${req.url} HTTP/1.1`];
  for (const [k, v] of Object.entries(headers)) {
    for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
  }
  // Re-add the upgrade headers dropped as hop-by-hop; they are the point here.
  lines.push(`connection: ${req.headers.connection ?? 'Upgrade'}`);
  lines.push(`upgrade: ${req.headers.upgrade}`);

  const upstream = net.connect(PORT, HOST, () => {
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const bail = () => { socket.destroy(); upstream.destroy(); };
  upstream.on('error', () => {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    bail();
  });
  socket.on('error', bail);
}
