'use strict';
// Shared helpers: paths, canonical JSON, file walking, terminal color, marker constants.

const fs = require('fs');
const path = require('path');

// The unique comment markers that delimit a YayLayer spec block.
// `YAY` = "this is YayLayer"; the id (e.g. C-040) names the Cell.
const MARK_BEGIN = /∷YAY⟨\s*([A-Za-z0-9._-]+)\s*⟩/;
const MARK_END = /∷YAY-END⟨\s*([A-Za-z0-9._-]+)\s*⟩/;

const YAY_DIR = '.yaylayer';
const CONFIG = 'config.json';
const LOCK = 'lock.json';
const KEYS = 'keys';

function repoRoot(start) {
  let dir = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(dir, YAY_DIR)) || fs.existsSync(path.join(dir, '.git'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start || process.cwd());
    dir = up;
  }
}

const paths = (root) => ({
  root,
  yay: path.join(root, YAY_DIR),
  config: path.join(root, YAY_DIR, CONFIG),
  lock: path.join(root, YAY_DIR, LOCK),
  keys: path.join(root, YAY_DIR, KEYS),
});

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}

function writeJSON(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

// Deterministic serialization so a hash/signature is stable regardless of key order.
function canonical(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(canonical).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.yaylayer', 'docs', 'dist', 'build', 'coverage']);
const CODE_EXT = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.html', '.py']);

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') && e.name !== '.') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, out);
    } else if (CODE_EXT.has(path.extname(e.name))) {
      out.push(full);
    }
  }
  return out;
}

// Minimal ANSI color (auto-disabled when not a TTY or NO_COLOR set).
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  green: paint('32'), yellow: paint('33'), red: paint('31'),
  gray: paint('90'), bold: paint('1'), accent: paint('35'), dim: paint('2'),
  pink: paint('95'),
};

// State → glyph + colorizer, used across verify/map output.
// PINK = code with NO formal specification at all — untracked, never described
// or signed. The most dangerous state: unknown territory where silent bugs hide.
const STATE = {
  GREEN: { glyph: '●', color: c.green, label: 'GREEN' },
  YELLOW: { glyph: '●', color: c.yellow, label: 'YELLOW' },
  RED: { glyph: '●', color: c.red, label: 'RED' },
  UNSIGNED: { glyph: '○', color: c.gray, label: 'UNSIGNED' },
  PINK: { glyph: '◆', color: c.pink, label: 'PINK' },
};

module.exports = {
  MARK_BEGIN, MARK_END, YAY_DIR,
  repoRoot, paths, readJSON, writeJSON, canonical, walk, c, STATE,
};
