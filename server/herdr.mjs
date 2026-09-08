// Minimal client for Herdr's newline-delimited JSON API over a unix socket.
// Verified against Herdr 0.8.2 (terminal protocol 20).

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const DEFAULT_SOCKET =
  process.env.HERDR_SOCKET_PATH ||
  path.join(os.homedir(), '.config', 'herdr', 'herdr.sock');

const CALL_TIMEOUT_MS = 8000;

// Herdr answers one request per connection, so each call gets its own socket.
export function call(method, params = {}, socketPath = DEFAULT_SOCKET) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(socketPath);
    let buf = '';
    const done = (fn, arg) => {
      clearTimeout(timer);
      sock.removeAllListeners();
      sock.destroy();
      fn(arg);
    };
    const timer = setTimeout(
      () => done(reject, new Error(`herdr call timed out: ${method}`)),
      CALL_TIMEOUT_MS,
    );

    sock.on('connect', () =>
      sock.write(JSON.stringify({ id: 'c', method, params }) + '\n'));
    sock.on('data', chunk => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      let msg;
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch (err) {
        return done(reject, err);
      }
      if (msg.error) {
        return done(reject, new Error(`${msg.error.code}: ${msg.error.message}`));
      }
      done(resolve, msg.result);
    });
    sock.on('error', err => done(reject, err));
    sock.on('close', () =>
      done(reject, new Error(`herdr closed connection during ${method}`)));
  });
}

// A long-lived subscription connection. Emits 'event' per pushed event and
// reconnects on drop so a daemon restart does not kill the bridge.
export class HerdrEvents extends EventEmitter {
  constructor(types, socketPath = DEFAULT_SOCKET) {
    super();
    this.types = types;
    this.socketPath = socketPath;
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.sock?.destroy();
  }

  #connect() {
    if (this.stopped) return;
    const sock = net.connect(this.socketPath);
    this.sock = sock;
    let buf = '';

    sock.on('connect', () => {
      this.emit('open');
      sock.write(JSON.stringify({
        id: 'sub',
        method: 'events.subscribe',
        params: { subscriptions: this.types.map(type => ({ type })) },
      }) + '\n');
    });

    sock.on('data', chunk => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          this.emit('event', JSON.parse(line));
        } catch { /* ignore malformed frame */ }
      }
    });

    const again = () => {
      if (this.stopped) return;
      sock.removeAllListeners();
      sock.destroy();
      this.emit('closed');
      this.retry = setTimeout(() => this.#connect(), 1000);
    };
    sock.on('error', again);
    sock.on('close', again);
  }
}

export const listPanes = () => call('pane.list').then(r => r.panes ?? []);
export const readPane = (paneId, { source = 'visible', format = 'ansi', lines } = {}) =>
  call('pane.read', {
    pane_id: paneId,
    source,
    format,
    strip_ansi: format === 'text',
    ...(lines ? { lines } : {}),
  }).then(r => r.read ?? {});
export const sendText = (paneId, text) => call('pane.send_text', { pane_id: paneId, text });
export const sendKeys = (paneId, keys) => call('pane.send_keys', { pane_id: paneId, keys });
export const snapshot = () => call('session.snapshot');
export const ping = () => call('ping');

// Exact pane geometry. Herdr omits columns from pane.list, but the session
// snapshot carries each pane's layout rect, which is the real character grid.
export async function paneGeometry() {
  const snap = await snapshot();
  const geom = new Map();
  for (const layout of snap.snapshot?.layouts ?? []) {
    for (const pane of layout.panes ?? []) {
      if (pane.rect) geom.set(pane.pane_id, { cols: pane.rect.width, rows: pane.rect.height });
    }
  }
  return geom;
}
