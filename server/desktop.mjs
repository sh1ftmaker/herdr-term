// Desktop control: Hyprland shortcuts, keyboard injection, and a screen grab.
//
// Hyprland 0.56 evaluates `hyprctl dispatch <arg>` as Lua (`hl.dispatch(<arg>)`),
// so a shortcut is a snippet of Lua. Every snippet here is a server-side
// constant: the browser sends an id, never Lua, never a command.

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import net from 'node:net';

const run = promisify(execFile);

const BIN_PATH = '/usr/local/bin:/usr/bin:/bin';
const RUNTIME_DIR = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;

// The bridge may have started before anyone logged in (systemd lingering), so
// it can't rely on its own environment. Re-resolve the session every call:
// that also survives a Hyprland restart underneath us.
export async function sessionEnv() {
  const env = { PATH: BIN_PATH, XDG_RUNTIME_DIR: RUNTIME_DIR, HOME: process.env.HOME };

  const socks = await fs.readdir(RUNTIME_DIR).catch(() => []);
  const wayland = socks.filter(n => /^wayland-\d+$/.test(n)).sort();
  if (wayland.length) env.WAYLAND_DISPLAY = wayland[0];

  // hyprctl needs the instance signature; the directory name is the signature.
  const instances = await fs.readdir(`${RUNTIME_DIR}/hypr`).catch(() => []);
  if (instances.length) {
    const stats = await Promise.all(instances.map(async n => ({
      n, t: await fs.stat(`${RUNTIME_DIR}/hypr/${n}`).then(s => s.mtimeMs, () => 0),
    })));
    env.HYPRLAND_INSTANCE_SIGNATURE = stats.sort((a, b) => b.t - a.t)[0].n;
  }
  return env;
}

export async function sessionUp() {
  const env = await sessionEnv();
  return Boolean(env.WAYLAND_DISPLAY && env.HYPRLAND_INSTANCE_SIGNATURE);
}

const luaStr = s => `"${String(s).replace(/[\\"]/g, c => '\\' + c)}"`;
const exec_cmd = cmd => `hl.dsp.exec_cmd(${luaStr(cmd)})`;
const focusWorkspace = n => `hl.dsp.focus({ workspace = ${luaStr(n)} })`;

// The allowlist. `cmd` is only used to hide entries whose binary isn't present.
const SHORTCUTS = [
  { id: 'menu',        group: 'Menus',  label: 'Omarchy menu', keys: 'SUPER SPACE',      cmd: 'omarchy-menu',            lua: exec_cmd('omarchy-menu toggle') },
  { id: 'menu-apps',   group: 'Menus',  label: 'Apps',         keys: 'SUPER ALT SPACE',  cmd: 'omarchy-menu',            lua: exec_cmd('omarchy-menu toggle apps') },
  { id: 'menu-system', group: 'Menus',  label: 'System',       keys: 'SUPER ESC',        cmd: 'omarchy-menu',            lua: exec_cmd('omarchy-menu toggle system') },
  { id: 'menu-capture',group: 'Menus',  label: 'Capture',      keys: 'SUPER CTRL C',     cmd: 'omarchy-menu',            lua: exec_cmd('omarchy-menu toggle capture') },
  { id: 'menu-theme',  group: 'Menus',  label: 'Theme',        keys: 'SUPER SHIFT CTRL SPACE', cmd: 'omarchy-menu',      lua: exec_cmd('omarchy-menu toggle theme') },
  { id: 'keybindings', group: 'Menus',  label: 'Keybindings',  keys: 'SUPER K',          cmd: 'omarchy-menu-keybindings',lua: exec_cmd('omarchy-menu-keybindings') },

  { id: 'terminal',    group: 'Apps',   label: 'Terminal',     keys: 'SUPER RETURN',     cmd: 'omarchy-launch-terminal', lua: exec_cmd('omarchy-launch-terminal') },
  { id: 'herdr',       group: 'Apps',   label: 'Herdr',        keys: 'SUPER CTRL RETURN',cmd: 'omarchy-launch-terminal-herdr', lua: exec_cmd('omarchy-launch-terminal-herdr') },
  { id: 'browser',     group: 'Apps',   label: 'Browser',      keys: 'SUPER SHIFT RETURN', cmd: 'omarchy-launch-browser',lua: exec_cmd('omarchy-launch-browser') },
  { id: 'files',       group: 'Apps',   label: 'File manager', keys: 'SUPER SHIFT F',    cmd: 'omarchy-launch-nautilus', lua: exec_cmd('omarchy-launch-nautilus') },
  { id: 'editor',      group: 'Apps',   label: 'Editor',       keys: 'SUPER SHIFT N',    cmd: 'omarchy-launch-editor',   lua: exec_cmd('omarchy-launch-editor') },

  { id: 'win-close',   group: 'Window', label: 'Close',        keys: 'SUPER W',          lua: 'hl.dsp.window.close()' },
  { id: 'win-full',    group: 'Window', label: 'Fullscreen',   keys: 'SUPER F',          lua: 'hl.dsp.window.fullscreen({ mode = "fullscreen" })' },
  { id: 'win-max',     group: 'Window', label: 'Full width',   keys: 'SUPER ALT F',      lua: 'hl.dsp.window.fullscreen({ mode = "maximized" })' },
  { id: 'win-float',   group: 'Window', label: 'Float',        keys: 'SUPER T',          lua: 'hl.dsp.window.float({ action = "toggle" })' },
  { id: 'win-split',   group: 'Window', label: 'Split',        keys: 'SUPER J',          lua: 'hl.dsp.layout("togglesplit")' },
  { id: 'win-next',    group: 'Window', label: 'Next window',  keys: 'ALT TAB',          lua: 'hl.dsp.window.cycle_next()' },
  { id: 'win-prev',    group: 'Window', label: 'Prev window',  keys: 'SHIFT ALT TAB',    lua: 'hl.dsp.window.cycle_next({ next = false })' },
  { id: 'focus-left',  group: 'Window', label: 'Focus ←',      keys: 'SUPER LEFT',       lua: 'hl.dsp.focus({ direction = "l" })' },
  { id: 'focus-right', group: 'Window', label: 'Focus →',      keys: 'SUPER RIGHT',      lua: 'hl.dsp.focus({ direction = "r" })' },
  { id: 'focus-up',    group: 'Window', label: 'Focus ↑',      keys: 'SUPER UP',         lua: 'hl.dsp.focus({ direction = "u" })' },
  { id: 'focus-down',  group: 'Window', label: 'Focus ↓',      keys: 'SUPER DOWN',       lua: 'hl.dsp.focus({ direction = "d" })' },

  { id: 'ws-next',     group: 'Workspace', label: 'Next',      keys: 'SUPER TAB',        lua: focusWorkspace('e+1') },
  { id: 'ws-prev',     group: 'Workspace', label: 'Previous',  keys: 'SUPER SHIFT TAB',  lua: focusWorkspace('e-1') },
  { id: 'ws-former',   group: 'Workspace', label: 'Former',    keys: 'SUPER CTRL TAB',   lua: focusWorkspace('previous') },
  { id: 'ws-scratch',  group: 'Workspace', label: 'Scratchpad',keys: 'SUPER S',          lua: 'hl.dsp.workspace.toggle_special("scratchpad")' },
  ...Array.from({ length: 10 }, (_, i) => i + 1).map(n => ({
    id: `ws-${n}`, group: 'Workspace', label: String(n), keys: `SUPER ${n % 10}`,
    lua: focusWorkspace(String(n)),
  })),

  { id: 'vol-up',      group: 'System', label: 'Vol +',        cmd: 'omarchy-audio-output-volume', lua: exec_cmd('omarchy-audio-output-volume raise') },
  { id: 'vol-down',    group: 'System', label: 'Vol −',        cmd: 'omarchy-audio-output-volume', lua: exec_cmd('omarchy-audio-output-volume lower') },
  { id: 'vol-mute',    group: 'System', label: 'Mute',         cmd: 'omarchy-audio-output-volume', lua: exec_cmd('omarchy-audio-output-volume mute-toggle') },
  { id: 'bright-up',   group: 'System', label: 'Bright +',     cmd: 'omarchy-brightness-display',  lua: exec_cmd('omarchy-brightness-display +5%') },
  { id: 'bright-down', group: 'System', label: 'Bright −',     cmd: 'omarchy-brightness-display',  lua: exec_cmd('omarchy-brightness-display 5%-') },
  { id: 'nightlight',  group: 'System', label: 'Nightlight',   cmd: 'omarchy-toggle-nightlight',   lua: exec_cmd('omarchy-toggle-nightlight') },
  { id: 'screenshot',  group: 'System', label: 'Screenshot',   cmd: 'omarchy-capture-region',      lua: exec_cmd('omarchy-capture-region --take-fullscreen') },
  { id: 'notif-dismiss', group: 'System', label: 'Dismiss notif', cmd: 'omarchy-shell',            lua: exec_cmd('omarchy-shell notifications dismissAll') },
  // Deliberately last, and deliberately the only irreversible-feeling one here:
  // no shutdown/reboot buttons are exposed.
  { id: 'lock',        group: 'System', label: 'Lock screen',  keys: 'SUPER CTRL L', cmd: 'omarchy-system-lock', lua: exec_cmd('omarchy-system-lock') },
];

const BY_ID = new Map(SHORTCUTS.map(s => [s.id, s]));

let presentCache;
async function present(cmd) {
  presentCache ??= new Map();
  if (!presentCache.has(cmd)) {
    presentCache.set(cmd, Promise.all(BIN_PATH.split(':').map(d =>
      fs.access(`${d}/${cmd}`).then(() => true, () => false))).then(r => r.includes(true)));
  }
  return presentCache.get(cmd);
}

// Hide shortcuts whose helper isn't installed rather than offering a dead button.
export async function shortcuts() {
  const out = [];
  for (const s of SHORTCUTS) {
    if (s.cmd && !(await present(s.cmd))) continue;
    out.push({ id: s.id, group: s.group, label: s.label, keys: s.keys ?? null });
  }
  return out;
}

export async function dispatch(id) {
  const s = BY_ID.get(id);
  if (!s) throw new Error(`unknown shortcut: ${id}`);
  const env = await sessionEnv();
  if (!env.HYPRLAND_INSTANCE_SIGNATURE) throw new Error('Hyprland is not running');
  const { stdout } = await run('hyprctl', ['dispatch', s.lua], { env, timeout: 5000 });
  const reply = stdout.trim();
  // hyprctl answers "ok" on success and prints the Lua error otherwise, but
  // always exits 0 — so the reply is the only signal that it worked.
  if (reply && reply !== 'ok') throw new Error(reply.split('\n')[0]);
  return { id, label: s.label };
}

const KEYSYMS = new Set([
  'Return', 'Escape', 'Tab', 'BackSpace', 'Delete', 'space',
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'Prior', 'Next',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  // Letters and digits, so combinations like Ctrl-C and Super-1 can be sent.
  // Bare ones are reachable through /api/desktop/type as well; the point of
  // having them here is that only this path can carry a modifier.
  ...'abcdefghijklmnopqrstuvwxyz0123456789',
]);
const MODS = new Set(['ctrl', 'alt', 'shift', 'logo']);

// wtype types into whatever has keyboard focus, so this drives the real desktop.
export async function sendKey(key, mods = []) {
  if (!KEYSYMS.has(key)) throw new Error(`unsupported key: ${key}`);
  const use = mods.filter(m => MODS.has(m));
  if (use.length !== mods.length) throw new Error('unsupported modifier');
  const args = [...use.flatMap(m => ['-M', m]), '-k', key, ...use.flatMap(m => ['-m', m])];
  await run('wtype', args, { env: await sessionEnv(), timeout: 5000 });
  return { key, mods: use };
}

export async function typeText(text) {
  if (typeof text !== 'string' || !text.length) throw new Error('text required');
  if (text.length > 4096) throw new Error('text too long');
  await run('wtype', ['--', text], { env: await sessionEnv(), timeout: 10000 });
  return { typed: text.length };
}

export async function monitors() {
  const { stdout } = await run('hyprctl', ['monitors', '-j'], { env: await sessionEnv(), timeout: 5000 });
  return JSON.parse(stdout).map(m => ({
    name: m.name, width: m.width, height: m.height, scale: m.scale,
    // Hyprland positions monitors in logical pixels, so a physical mode has to
    // be divided by the scale to say how much layout space it covers.
    x: m.x, y: m.y,
    logicalWidth: Math.round(m.width / (m.scale || 1)),
    logicalHeight: Math.round(m.height / (m.scale || 1)),
    focused: m.focused, activeWorkspace: m.activeWorkspace?.id ?? null,
  }));
}

// The bounding box grim captures when no -o is given: the union of every
// monitor, in the same logical coordinates the cursor is warped with.
export async function layoutBounds() {
  const mons = await monitors();
  if (!mons.length) throw new Error('no monitors');
  const x = Math.min(...mons.map(m => m.x));
  const y = Math.min(...mons.map(m => m.y));
  const right = Math.max(...mons.map(m => m.x + m.logicalWidth));
  const bottom = Math.max(...mons.map(m => m.y + m.logicalHeight));
  return { x, y, width: right - x, height: bottom - y };
}

// A JPEG of the current screen. Cheap enough to poll at a few frames a second,
// and it needs nothing installed beyond grim.
export async function screenshot({ output, quality = 55, scale = 0.5 } = {}) {
  const q = Math.min(95, Math.max(10, Number(quality) || 55));
  const s = Math.min(1, Math.max(0.1, Number(scale) || 0.5));
  const args = ['-t', 'jpeg', '-q', String(q), '-s', String(s)];
  if (output) {
    if (!/^[A-Za-z0-9._-]{1,32}$/.test(output)) throw new Error('bad output name');
    args.push('-o', output);
  }
  args.push('-');
  const { stdout } = await run('grim', args, {
    env: await sessionEnv(), timeout: 8000, encoding: 'buffer', maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

// --- pointer ---------------------------------------------------------------
// Hyprland warps the cursor itself, but has no dispatcher that presses a mouse
// button, so clicks come from a virtual uinput device (see
// scripts/uinput-pointer.py). The helper is spawned once and kept: a new input
// device takes a moment for udev and libinput to adopt, so a per-click process
// would lose its own first event.

const POINTER_HELPER = new URL('../scripts/uinput-pointer.py', import.meta.url).pathname;
const BUTTONS = new Set(['left', 'right', 'middle']);

let helper = null;

function spawnHelper() {
  const proc = spawn('python3', [POINTER_HELPER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const state = { proc, queue: [], buf: '', ready: null, stderr: '' };

  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => {
    state.buf += chunk;
    let nl;
    while ((nl = state.buf.indexOf('\n')) !== -1) {
      const line = state.buf.slice(0, nl);
      state.buf = state.buf.slice(nl + 1);
      const waiter = state.queue.shift();
      if (!waiter) continue;
      let reply;
      try { reply = JSON.parse(line); } catch { reply = { ok: false, error: line }; }
      reply.ok ? waiter.resolve(reply) : waiter.reject(new Error(reply.error || 'pointer failed'));
    }
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', d => { state.stderr = (state.stderr + d).slice(-2000); });

  const fail = err => {
    if (helper === state) helper = null;
    for (const w of state.queue.splice(0)) w.reject(err);
  };
  proc.on('error', err => fail(err));
  proc.on('exit', () => fail(new Error(
    `pointer helper exited${state.stderr ? `: ${state.stderr.trim().split('\n').pop()}` : ''}`)));

  // The first line the helper prints is its readiness handshake.
  state.ready = new Promise((resolve, reject) => state.queue.push({ resolve, reject }));
  return state;
}

function send(state, cmd) {
  return new Promise((resolve, reject) => {
    state.queue.push({ resolve, reject });
    state.proc.stdin.write(JSON.stringify(cmd) + '\n', err => err && reject(err));
  });
}

async function pointerHelper() {
  if (!helper || helper.proc.exitCode !== null || helper.proc.killed) helper = spawnHelper();
  const state = helper;
  await state.ready;
  return state;
}

// Move to a point given as a fraction of the captured screen, click, or both.
// Fractions rather than pixels because the browser is looking at a scaled JPEG
// and shouldn't have to know the real geometry.
export async function pointer({ nx, ny, click, button = 'left', count = 1, scroll } = {}) {
  const env = await sessionEnv();
  if (!env.HYPRLAND_INSTANCE_SIGNATURE) throw new Error('Hyprland is not running');
  const out = {};

  if (nx != null && ny != null) {
    const fx = Number(nx), fy = Number(ny);
    if (!Number.isFinite(fx) || !Number.isFinite(fy) || fx < 0 || fx > 1 || fy < 0 || fy > 1) {
      throw new Error('nx and ny must be fractions between 0 and 1');
    }
    const box = await layoutBounds();
    const x = Math.round(box.x + fx * box.width);
    const y = Math.round(box.y + fy * box.height);
    const { stdout } = await run(
      'hyprctl', ['dispatch', `hl.dsp.cursor.move({ x = ${x}, y = ${y} })`],
      { env, timeout: 5000 });
    const reply = stdout.trim();
    if (reply && reply !== 'ok') throw new Error(reply.split('\n')[0]);
    out.moved = { x, y };
  }

  if (scroll != null) {
    const dy = Math.max(-10, Math.min(10, Math.round(Number(scroll) || 0)));
    if (dy) await send(await pointerHelper(), { op: 'scroll', dy });
    out.scrolled = dy;
  }

  if (click) {
    if (!BUTTONS.has(button)) throw new Error(`unknown button: ${button}`);
    const n = Math.max(1, Math.min(3, Number(count) || 1));
    // Let the compositor settle on the warped position before the press, or a
    // fast tap can click where the cursor used to be.
    if (out.moved) await new Promise(r => setTimeout(r, 40));
    await send(await pointerHelper(), { op: 'click', button, count: n });
    out.clicked = { button, count: n };
  }

  return out;
}

export function stopPointer() {
  helper?.proc.kill();
  helper = null;
}

export const tcpOpen = (port, host = '127.0.0.1', timeout = 400) =>
  new Promise(resolve => {
    const sock = net.connect({ port, host });
    const done = ok => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeout);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
