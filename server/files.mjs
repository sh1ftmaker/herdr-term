// Read-only file browsing, rooted at a single directory.
//
// Everything the browser sends is a path *relative to ROOT*. It is resolved,
// then realpath'd, and the result must still sit inside ROOT — so neither
// "../.." nor a symlink pointing outside can escape.

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const ROOT = path.resolve(process.env.HERDR_TERM_FS_ROOT || os.homedir());

const MAX_ENTRIES = 5000;
export const MAX_TEXT_BYTES = 512 * 1024;

let rootReal;
const realRoot = async () => (rootReal ??= await fs.realpath(ROOT));

export class FsError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// Resolve to an absolute real path guaranteed to be inside ROOT.
export async function resolveInRoot(rel = '') {
  const base = await realRoot();
  const target = path.resolve(base, String(rel).replace(/^\/+/, ''));
  let real;
  try {
    real = await fs.realpath(target);
  } catch {
    throw new FsError('not found', 404);
  }
  if (real !== base && !real.startsWith(base + path.sep)) {
    throw new FsError('outside the served root', 403);
  }
  return real;
}

// Path as the browser should refer to it: relative to ROOT, '' for ROOT itself.
export const toRel = async abs => path.relative(await realRoot(), abs);

const IMAGE = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif',
  '.bmp': 'image/bmp', '.ico': 'image/x-icon',
};

// Extensions worth opening in the text viewer. Anything else is offered as a
// download rather than guessed at.
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.conf', '.cfg', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.css', '.scss', '.html', '.xml', '.svg',
  '.py', '.rb', '.go', '.rs', '.c', '.h', '.cpp', '.hpp', '.java', '.kt', '.swift',
  '.sh', '.bash', '.zsh', '.fish', '.lua', '.vim', '.sql', '.diff', '.patch',
  '.gitignore', '.service', '.desktop', '.nix', '.tf',
]);

const TEXT_NAMES = new Set([
  'README', 'LICENSE', 'Makefile', 'Dockerfile', 'PKGBUILD', '.bashrc', '.zshrc',
  '.gitconfig', '.env', '.gitignore',
]);

export function kindOf(name, isDir) {
  if (isDir) return 'dir';
  const ext = path.extname(name).toLowerCase();
  if (IMAGE[ext]) return 'image';
  if (TEXT_EXT.has(ext) || TEXT_NAMES.has(name) || ext === '') return 'text';
  return 'binary';
}

export const imageMime = name => IMAGE[path.extname(name).toLowerCase()] ?? null;

export async function list(rel = '') {
  const abs = await resolveInRoot(rel);
  const st = await fs.stat(abs);
  if (!st.isDirectory()) throw new FsError('not a directory', 400);

  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries = [];
  for (const d of dirents.slice(0, MAX_ENTRIES)) {
    let isDir = d.isDirectory();
    let size = 0, mtime = 0, broken = false;
    try {
      // stat() follows symlinks, so a link to a directory lists as one.
      const s = await fs.stat(path.join(abs, d.name));
      isDir = s.isDirectory();
      size = s.size;
      mtime = s.mtimeMs;
    } catch {
      broken = true;
    }
    entries.push({
      name: d.name,
      kind: broken ? 'binary' : kindOf(d.name, isDir),
      size, mtime,
      link: d.isSymbolicLink(),
      broken,
    });
  }
  entries.sort((a, b) =>
    (a.kind === 'dir') === (b.kind === 'dir')
      ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      : a.kind === 'dir' ? -1 : 1);

  const relPath = await toRel(abs);
  return {
    root: ROOT,
    path: relPath,
    parent: relPath ? path.dirname(relPath).replace(/^\.$/, '') : null,
    truncated: dirents.length > MAX_ENTRIES,
    entries,
  };
}

export async function readText(rel) {
  const abs = await resolveInRoot(rel);
  const st = await fs.stat(abs);
  if (st.isDirectory()) throw new FsError('is a directory', 400);

  const fh = await fs.open(abs, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_TEXT_BYTES));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const slice = buf.subarray(0, bytesRead);
    // A NUL in the first chunk means this isn't text, whatever the extension said.
    if (slice.includes(0)) throw new FsError('binary file — download it instead', 415);
    return {
      path: await toRel(abs),
      name: path.basename(abs),
      size: st.size,
      truncated: st.size > MAX_TEXT_BYTES,
      text: slice.toString('utf8'),
    };
  } finally {
    await fh.close();
  }
}

// Metadata for streaming a file back verbatim (image preview or download).
export async function rawTarget(rel) {
  const abs = await resolveInRoot(rel);
  const st = await fs.stat(abs);
  if (st.isDirectory()) throw new FsError('is a directory', 400);
  return { abs, size: st.size, name: path.basename(abs), mime: imageMime(path.basename(abs)) };
}
