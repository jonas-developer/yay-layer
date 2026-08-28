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

// A roster entry is one identity that may hold several keys (local + phone …).
// Normalize any stored shape to a flat list of base64 public keys.
//   legacy string  → ["pub"]
//   ["pub", …]     → as-is
//   [{pub,kind,…}] → [pub, …]
function pubKeysOf(entry) {
  if (!entry) return [];
  if (typeof entry === 'string') return [entry];
  if (Array.isArray(entry)) return entry.map((k) => (typeof k === 'string' ? k : k && k.pub)).filter(Boolean);
  if (entry.pub) return [entry.pub];
  return [];
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.yaylayer', 'docs', 'dist', 'build', 'coverage']);
// Every extension we scan for spec blocks. Spec fields are comment-agnostic (see
// extract.parseSpec), so any of these can carry a spec block. Verification depth
// then depends on the language's tier (see below).
const CODE_EXT = new Set([
  // JS/TS — fully analyzed + behaviourally proven
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx',
  // brace-family (C-style) — spec-mirror + sign + gate + map, capped at Yellow
  '.cs', '.sol', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh',
  '.kt', '.kts', '.swift', '.php', '.scala', '.dart', '.pl', '.pm', '.sh', '.bash',
  // indentation-scoped
  '.py', '.pyw',
  // def…end-scoped
  '.rb', '.ex', '.exs',
  // shallow (marker blocks only, no unit analysis)
  '.css', '.html',
]);

// Body-delimiting FAMILY for a file — selects how the unit body is grabbed:
//   js    → JS/TS declaration + brace matcher (full analysis + proof)
//   brace → generic C-family brace matcher (Go, Java, C/C++, Kotlin, Swift, …)
//   python→ indentation
//   ruby  → def…end (Ruby, Elixir)
//   css/html/other → shallow (no unit body)
const BRACE_EXT = new Set(['.cs', '.sol', '.rs', '.go', '.java', '.c', '.h', '.cpp', '.cc', '.cxx', '.hpp', '.hh', '.kt', '.kts', '.swift', '.php', '.scala', '.dart', '.pl', '.pm', '.sh', '.bash']);
function langOf(file) {
  const e = path.extname(String(file)).toLowerCase();
  if (['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'].includes(e)) return 'js';
  if (e === '.py' || e === '.pyw') return 'python';
  if (e === '.rb' || e === '.ex' || e === '.exs') return 'ruby';
  if (BRACE_EXT.has(e)) return 'brace';
  if (e === '.css') return 'css';
  if (e === '.html') return 'html';
  return 'other';
}
// The comment lead used when `yay adopt` scaffolds a block: '#' for hash-comment
// languages, '//' otherwise. (Reading is comment-agnostic; only writing needs this.)
const HASH_EXT = new Set(['.py', '.pyw', '.rb', '.ex', '.exs', '.pl', '.pm', '.sh', '.bash']);
function commentLeadOf(file) { return HASH_EXT.has(path.extname(String(file)).toLowerCase()) ? '#' : '//'; }

// The only languages YayLayer currently analyzes (AST) and can behaviourally
// prove. Everything else is signed-but-unverified. `lang` here is the manifest's
// per-Cell value (a file extension slice like 'ts', or a spec `lang:` override).
const JS_LANGS = new Set(['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'javascript', 'typescript']);
function isJsLang(l) { return JS_LANGS.has(String(l || '').toLowerCase()); }

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

// Top-level IMPERATIVE code in a non-JS file (Python/Ruby) — the "sneak a DO-THIS line
// at module scope" shape that runs at import time. JS gets this from the AST; non-JS
// langs had no equivalent, so a bare `os.system(...)` at column 0 slipped past the Pink
// net entirely. Conservative on purpose (mirrors JS looseTopLevel): flag indent-0 bare
// CALLS (`foo(` / `foo.bar(`) and control-flow starters, but skip declarations, imports,
// comments, spec markers, the `if __name__` main-guard, and assignments (module
// constants/wiring — same carve-out JS makes). Returns 1-based line numbers.
function looseTopLevelNonJs(lines, family) {
  if (family !== 'python' && family !== 'ruby') return [];
  const out = [];
  const CALL = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/;
  const CTRL = /^(?:if|for|while|with|try|unless|begin|case|loop)\b/;
  const DECL = /^(?:def|class|async|module|import|from|require|require_relative|include|extend|attr_[a-z]+|@|#|"""|''')/;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (/^\s/.test(raw)) continue;            // indented → inside some block
    const t = raw.trim();
    if (!t) continue;
    if (/∷YAY/.test(t) || DECL.test(t)) continue;
    if (/^if\s+__name__/.test(t)) continue;   // standard Python entry guard (dead on import)
    const eq = t.search(/[^=!<>]=[^=]/);       // a real single '=' (assignment), not ==/!=/<=/>=
    const par = t.indexOf('(');
    if (eq >= 0 && (par < 0 || eq < par)) continue; // assignment before any call → module constant/wiring
    if (CALL.test(t) || CTRL.test(t)) out.push(i + 1);
  }
  return out;
}

module.exports = {
  MARK_BEGIN, MARK_END, YAY_DIR,
  repoRoot, paths, readJSON, writeJSON, canonical, pubKeysOf, walk, c, STATE,
  langOf, isJsLang, commentLeadOf, looseTopLevelNonJs,
};
