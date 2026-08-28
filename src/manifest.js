'use strict';
// Build the manifest: scan a tree, extract every Cell (marker blocks), and use
// the AST analyzer to (a) attach the exact unit a Cell governs and (b) find
// UNTRACKED units — named code with no spec block → PINK. Falls back to a shallow
// regex for files the parser can't handle (e.g. TypeScript) so nothing is silently
// dropped.

const fs = require('fs');
const path = require('path');
const { walk, repoRoot, langOf, isJsLang } = require('./util');
const { sha256 } = require('./crypto');
const { extractFile } = require('./extract');
const { analyze, nearestUnitAfter } = require('./analyze');

// Names a bare `foo()` call can resolve to without a project definition — JS/DOM/
// Node builtins + common globals. Anything called but neither defined nor here is a
// dangling reference. (Kept generous to avoid false positives; extend as needed.)
const GLOBALS = new Set([
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Function', 'Math', 'JSON', 'Date', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'structuredClone', 'queueMicrotask', 'eval',
  'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate', 'requestAnimationFrame', 'cancelAnimationFrame', 'fetch',
  'window', 'document', 'console', 'alert', 'confirm', 'prompt', 'localStorage', 'sessionStorage', 'navigator', 'location', 'history',
  'atob', 'btoa', 'getComputedStyle', 'matchMedia', 'FormData', 'Headers', 'Request', 'Response', 'URL', 'URLSearchParams',
  'Blob', 'File', 'FileReader', 'Image', 'Audio', 'Worker', 'WebSocket', 'EventSource',
  'IntersectionObserver', 'MutationObserver', 'ResizeObserver', 'crypto', 'CustomEvent', 'Event',
  'require', 'process', 'Buffer', '__dirname', '__filename', 'module', 'exports', 'global', 'globalThis',
  '$', '_',
]);

const JS_LIKE = /\.(js|jsx|mjs|cjs|ts|tsx)$/;

// Fallback (parse failed): top-level `function name(` / `const name = (` only.
const COVER_FN = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/;

function untrackedRegex(file, rel, coveredNames, out) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch (_) { return; }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(COVER_FN);
    if (!m) continue;
    const name = m[1] || m[2];
    if (!name || coveredNames.has(name)) continue;
    if (/∷YAY-END|∷YAY⟨/.test(lines[i - 1] || '')) continue;
    out.push({ name, file: rel, line: i + 1, kind: 'function', lang: path.extname(file).slice(1) });
  }
}

// Conservative, keyword-led unit detection for non-JS languages, used only to find
// UNTRACKED (un-specced) units → PINK. Deliberately under-detects rather than risk a
// FALSE Pink (which would wrongly block the gate): KW_FN is anchored on an unambiguous
// declaration keyword (fn/def/func/fun/function/sub), and MOD_METHOD requires an access
// modifier — neither matches control-flow (if/for/while/…). Languages with no safe
// pattern (plain C, Dart, bare shell fns) are simply not scanned here (safe under-detect).
// Comment lines are skipped so commented-out code and spec fields never register.
const KW_FN = /^\s*(?:pub\s+|export\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|open\s+|override\s+|async\s+)*(?:fn|def|defp|func|fun|function|sub)\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_]*)/;
const MOD_METHOD = /(?:^|\s)(?:public|private|protected|internal)(?:\s+(?:static|virtual|override|sealed|abstract|async|partial|new|readonly|unsafe|extern|final))*\s+[A-Za-z_][A-Za-z0-9_<>[\],.?]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/;
const LANG_UNTRACKED = {
  python: [KW_FN],
  ruby: [KW_FN],
  brace: [KW_FN, MOD_METHOD],
};
function untrackedLangRegex(file, rel, family, coveredNames, out) {
  const pats = LANG_UNTRACKED[family];
  if (!pats) return;
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch (_) { return; }
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    // skip blanks, comments (all four use // or #), block-comment lines, and spec fields
    if (!t || t.startsWith('//') || t.startsWith('#') || t.startsWith('/*') || t.startsWith('*')) continue;
    for (const re of pats) {
      const m = lines[i].match(re);
      if (!m) continue;
      const name = m[1];
      if (!name || coveredNames.has(name)) break;
      if (/∷YAY-END|∷YAY⟨/.test(lines[i - 1] || '')) break;
      out.push({ name, file: rel, line: i + 1, kind: 'function', lang: path.extname(file).slice(1) });
      break;
    }
  }
}

const baseName = (f) => String(f).split('/').pop();
// A module is named by its exposed namespace (global.X / export / module.exports),
// else by its filename. Works for ES modules, CommonJS, UMD/IIFE, and plain scripts.
function moduleNameOf(ana, rel) { return (ana && ana.namespace && ana.namespace.name) || baseName(rel); }
// A unit's sub-group: its class/object container, else Public API vs Internal.
function groupOf(unit, ana) {
  if (unit.container) return unit.container;
  const short = String(unit.name).split('.').pop();
  return (ana && ana.namespace && ana.namespace.publicNames && ana.namespace.publicNames.has(short)) ? 'Public API' : 'Internal';
}

// Files the scanner must NOT treat as source: the generated map output (it embeds
// spec text → would self-report a missing marker), plus anything in .yaylayerignore
// (gitignore-ish: basenames, path tails, `*` globs, `dir/` prefixes).
function makeIgnore(root) {
  const patterns = ['yay-layer-map.html', 'yay-layer-map.*.html'];
  try {
    for (const line of fs.readFileSync(path.join(root, '.yaylayerignore'), 'utf8').split(/\r?\n/)) {
      const p = line.trim(); if (p && !p.startsWith('#')) patterns.push(p);
    }
  } catch (_) {}
  const res = patterns.map((p) => {
    const g = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return new RegExp(p.endsWith('/') ? '(^|/)' + g : '(^|/)' + g + '$');
  });
  return (rel) => res.some((re) => re.test(rel));
}

function buildManifest(targetDir) {
  const root = repoRoot(targetDir);
  const ignore = makeIgnore(root);
  const files = walk(path.resolve(targetDir || root)).filter((f) => !ignore(path.relative(root, f)));
  const cells = {};
  const problems = [];
  const perFile = {};

  for (const file of files) {
    const rel = path.relative(root, file);
    let code = '';
    try { code = fs.readFileSync(file, 'utf8'); } catch (_) {}
    const codeLines = code.split(/\r?\n/);
    const ana = JS_LIKE.test(file) ? analyze(code) : { ok: false, units: [], loose: [] };
    const covered = new Set();

    let found;
    try { found = extractFile(file); } catch (e) { problems.push({ file: rel, error: e.message }); found = []; }
    for (const cell of found) {
      if (cell.malformed) { problems.push({ id: cell.id, file: rel, error: cell.malformed }); continue; }
      if (cells[cell.id]) { problems.push({ id: cell.id, file: rel, error: `duplicate Cell id (also in ${cells[cell.id].file})` }); continue; }
      let { unitName, unitBody, unitBodyStart, unitFound } = cell;
      let cellModule = moduleNameOf(ana, rel);
      let cellGroup = cell.spec.contains ? 'Modules' : 'Internal';
      let callsOut = [], callsDirect = [], detectedUnit = cell.detectedUnit || null; // extract's regex-detected name (non-JS langs); the JS AST refines it below
      if (ana.ok && !cell.spec.contains) {
        const u = nearestUnitAfter(ana.units, cell.endLine);
        if (u) {
          detectedUnit = u.name;                 // the ACTUAL function name found in the code
          unitName = cell.spec.unit || u.name;
          unitBody = codeLines.slice(u.startLine - 1, u.endLine).join('\n');
          unitBodyStart = u.startLine - 1;
          unitFound = true;
          covered.add(u.startLine);
          cellGroup = groupOf(u, ana);
          callsOut = u.callsOut || [];
          callsDirect = u.callsDirect || [];
        }
      }
      cells[cell.id] = {
        id: cell.id, file: rel, line: cell.startLine,
        lang: (cell.spec.lang || path.extname(file).slice(1) || 'unknown').split(/[ ·]/)[0],
        spec: cell.spec, specBlock: cell.normalized, specHash: sha256(cell.normalized),
        unitName, detectedUnit, unitBody, unitBodyStart, unitFound, module: cellModule, group: cellGroup,
        contains: parseList(cell.spec.contains), feeds: parseList(cell.spec.feeds), callsOut, callsDirect,
      };
    }
    perFile[rel] = { file, ana, covered };
  }

  // UNTRACKED: AST units with no covering Cell + top-level imperative ("loose") code.
  const coveredNames = new Set(Object.values(cells).map((c) => c.unitName).filter(Boolean));
  const untracked = [];
  for (const rel of Object.keys(perFile)) {
    const { file, ana, covered } = perFile[rel];
    if (ana.ok) {
      for (const u of ana.units) {
        if (covered.has(u.startLine)) continue;
        untracked.push({ name: u.name, file: rel, line: u.startLine, kind: u.kind, lang: path.extname(file).slice(1), module: moduleNameOf(ana, rel), group: groupOf(u, ana) });
      }
      if (ana.loose.length) {
        untracked.push({ name: 'module-level code', file: rel, line: ana.loose[0], kind: 'loose', count: ana.loose.length, lang: path.extname(file).slice(1), module: moduleNameOf(ana, rel), group: 'module-level' });
      }
    } else if (JS_LIKE.test(file)) {
      untrackedRegex(file, rel, coveredNames, untracked);
    } else {
      untrackedLangRegex(file, rel, langOf(file), coveredNames, untracked);
    }
  }

  // Module-level flow (file → file), derived from the call graph: file A feeds
  // into file B if A calls a unit that B defines. Auto-structure, no annotations.
  const defs = {}, callsOf = {};
  for (const rel of Object.keys(perFile)) {
    const { ana } = perFile[rel];
    defs[rel] = new Set(ana.ok ? ana.units.map((u) => String(u.name).split('.').pop()) : []);
    callsOf[rel] = new Set(ana.ok ? ana.calls : []);
  }
  const edgeSet = new Set();
  for (const a of Object.keys(callsOf)) {
    for (const name of callsOf[a]) {
      for (const b of Object.keys(defs)) {
        if (b === a || !defs[b].has(name)) continue;
        if (defs[a].has(name)) continue; // A defines this name itself → not a cross-module call
        const ma = moduleNameOf(perFile[a].ana, a), mb = moduleNameOf(perFile[b].ana, b);
        if (ma !== mb) edgeSet.add(ma + ' >> ' + mb);
      }
    }
  }
  const moduleEdges = [...edgeSet].map((s) => s.split(' >> '));

  // Reference resolution: a DIRECT call `foo()` should resolve to something defined
  // in the project (any file's bindings/units), an import, or a known global. What's
  // left is a dangling reference — a rename that broke a caller, a typo, a removed fn.
  const declared = new Set(GLOBALS);
  for (const rel of Object.keys(perFile)) {
    const { ana } = perFile[rel];
    if (!ana.ok) continue;
    (ana.bindings || []).forEach((n) => declared.add(n));
    (ana.units || []).forEach((u) => declared.add(shortName(u.name)));
  }
  // NB: resolve against ACTUAL code definitions (bindings/units) only — NOT the spec's
  // claimed `unit:` names, nor claimed exports (publicNames), or a stale/broken
  // `{ createState }` export would mask a caller that references a now-missing function.
  for (const c of Object.values(cells)) {
    c.unresolved = (c.callsDirect || []).filter((n) => !declared.has(n));
  }

  computeInfluence(cells);
  return { root, cells, problems, untracked, moduleEdges };
}

const shortName = (n) => String(n || '').split('.').pop();

// Cell-level influence, from the unit call graph — no annotations required:
//   directCallers — Cells that call this Cell's unit
//   blast         — Cells that TRANSITIVELY depend on it (break if it's wrong)
//   isEntry       — part of its module's Public API (external callers expected)
//   bloat         — no callers found and not public → possible dead code
// Name resolution prefers a definer in the caller's own module (most calls are
// intra-module), falling back to definers elsewhere. Same-short-name collisions
// across modules are inherently ambiguous — treated as a link, so blast may
// slightly over-count; it's a signal, not a proof.
function computeInfluence(cells) {
  const ids = Object.keys(cells);
  const isLeaf = (c) => !(c.contains && c.contains.length);
  const leaves = ids.filter((id) => isLeaf(cells[id]));
  // Null-prototype maps: unit names like "constructor"/"toString" must not collide
  // with inherited Object.prototype members.
  const byName = Object.create(null);
  for (const id of leaves) {
    const n = shortName(cells[id].unitName);
    if (n) (byName[n] = byName[n] || []).push(id);
  }
  const callers = Object.create(null);
  for (const id of ids) callers[id] = new Set();
  for (const id of leaves) {
    const c = cells[id];
    for (const name of c.callsOut || []) {
      const cands = byName[name];
      if (!cands) continue;
      let targets = cands.filter((t) => t !== id && cells[t].module === c.module);
      if (!targets.length) targets = cands.filter((t) => t !== id);
      for (const t of targets) callers[t].add(id);
    }
  }
  for (const id of leaves) {
    const c = cells[id];
    const seen = new Set();
    const stack = [...callers[id]];
    while (stack.length) {
      const x = stack.pop();
      if (seen.has(x)) continue;
      seen.add(x);
      for (const y of callers[x] || []) if (!seen.has(y)) stack.push(y);
    }
    c.directCallers = callers[id].size;
    c.blast = seen.size;
    // Entry points get external callers the static graph can't see: a module's
    // Public API, and DOM event handlers (onclick/onchange/…) invoked by the browser.
    c.isEntry = c.group === 'Public API' || /^on[a-z]+$/.test(shortName(c.unitName));
    // The call graph is built from the JS AST only — for a non-JS Cell "no callers" is
    // blindness, not evidence, so never call it bloat (a misleading dead-code verdict).
    c.bloat = callers[id].size === 0 && !c.isEntry && (!c.lang || isJsLang(c.lang));
    c.callerIds = [...callers[id]];
  }
}

function parseList(v) {
  if (!v) return [];
  return v.replace(/[[\]]/g, '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).filter((s) => s !== '—' && s !== '-');
}

module.exports = { buildManifest, parseList, computeInfluence };
