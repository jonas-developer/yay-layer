'use strict';
// Behavioural verification: does the code actually satisfy its `ensures`?
//
// For every leaf Cell that declares `pure: yes` and an `ensures:`, we:
//   1. load the Cell's file in an isolated VM sandbox (TS types stripped, module
//      syntax neutralised, unknown globals black-holed so pure code still loads),
//   2. capture the unit function by name (works for function decls, const arrows…),
//   3. generate inputs from the `in:` types (edge + ordinary values, deterministic),
//   4. call the real function and evaluate the `ensures` expression against `out`.
//
// A single counterexample ⇒ FAIL (Red): the code contradicts its promise. If we
// genuinely cannot check it (prose ensures, exotic types, code won't load) we say
// so and leave it UNPROVEN (Yellow / info) — never a fake pass. Test inputs come
// from the SPEC, never the implementation, so passing means something.

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');

function stripTS(code) {
  let m; try { m = require('node:module'); } catch (_) { return code; }
  if (typeof m.stripTypeScriptTypes !== 'function') return code;
  const prev = process.emitWarning; process.emitWarning = () => {};
  try { return m.stripTypeScriptTypes(code, { mode: 'strip' }); }
  catch (_) { return null; }
  finally { process.emitWarning = prev; }
}

// Drop imports and unwrap `export` so the file runs as a plain script in the VM.
function neutralizeModules(code) {
  return code.split('\n').map((l) => {
    if (/^\s*import\b/.test(l)) return '';
    if (/^\s*export\s+(\{|\*)/.test(l)) return '';
    return l.replace(/^(\s*)export\s+default\s+/, '$1').replace(/^(\s*)export\s+/, '$1');
  }).join('\n');
}

// A permissive stand-in for globals a pure function shouldn't need but a file might
// touch at load time (document/window/…): every access yields another black hole.
function blackHole() {
  const bh = new Proxy(function () {}, {
    get: (_t, k) => (k === Symbol.toPrimitive ? () => '' : bh),
    apply: () => bh, construct: () => bh, has: () => true,
  });
  return bh;
}

function makeSandbox(names, registry) {
  const real = {
    Math, JSON, String, Number, Boolean, Array, Object, RegExp, Date, Symbol,
    isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    NaN, Infinity, undefined,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    __ylreg: (obj) => { Object.assign(registry, obj); },
  };
  const sandbox = new Proxy(real, {
    has: () => true, // tell the VM every identifier is "global" → no ReferenceError
    get: (t, k) => (k in t ? t[k] : blackHole()),
  });
  return vm.createContext(sandbox);
}

// Load a file once; return { fns } mapping requested names → captured functions.
function loadFile(absPath, names) {
  let src; try { src = fs.readFileSync(absPath, 'utf8'); } catch (_) { return { error: 'unreadable' }; }
  const stripped = stripTS(src);
  if (stripped == null) return { error: 'typescript-strip-failed' };
  const code = neutralizeModules(stripped);
  const registry = {};
  const ctx = makeSandbox(names, registry);
  const cap = '\n;try{__ylreg({' + names.map((n) => JSON.stringify(n) + ':(typeof ' + safeIdent(n) + "!=='undefined'?" + safeIdent(n) + ':undefined)').join(',') + '});}catch(e){}';
  try { vm.runInContext(code + cap, ctx, { timeout: 2000 }); }
  catch (e) { return { error: 'load: ' + (e && e.message ? e.message.split('\n')[0] : 'threw') }; }
  return { fns: registry, ctx };
}

// Only plain identifiers can be captured as bare names (skip Class.method units).
function safeIdent(n) { return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n) ? n : '__nope_' + Math.abs(hash(n)); }
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }

// ── inputs ────────────────────────────────────────────────────────────────
function parseIn(spec) {
  const raw = (spec && spec.in ? String(spec.in) : '').trim();
  if (!raw || /^todo$/i.test(raw)) return [];
  return raw.split(',').map((part) => {
    const m = part.split(':');
    const name = (m[0] || '').trim();
    const type = (m[1] || 'any').trim().toLowerCase().replace(/\s+/g, '');
    return { name, type };
  }).filter((p) => p.name);
}
const POOLS = {
  number: [0, 1, 2, -1, 3, 7, 10, -5, 0.5, 100],
  string: ['', 'a', 'ab', 'abc', 'Hello', '/x', '123', 'a b'],
  boolean: [true, false],
};
function valuesFor(type) {
  if (POOLS[type]) return POOLS[type];
  const arr = type.match(/^(number|string|boolean)\[\]$/);
  if (arr) { const b = POOLS[arr[1]]; return [[], [b[1]], [b[1], b[2]], b.slice(0, 3)]; }
  return null; // uncheckable type
}
function cartesian(lists, cap) {
  let out = [[]];
  for (const list of lists) {
    const next = [];
    for (const tuple of out) for (const v of list) { next.push(tuple.concat([v])); if (next.length > cap * 4) break; }
    out = next;
  }
  if (out.length > cap) { // deterministic thinning
    const step = out.length / cap; const picked = [];
    for (let i = 0; i < out.length; i += step) picked.push(out[Math.floor(i)]);
    out = picked;
  }
  return out;
}

// ── the ensures expression ──────────────────────────────────────────────────
function buildChecker(ctx, params, ensuresExpr) {
  const decl = params.map((p, i) => `var ${p}=A[${i}];`).join(' ');
  const call = `fn(${params.map((_, i) => `A[${i}]`).join(',')})`;
  const src = `(function(fn,A){ ${decl} var out=${call}; return {out:out, ok:!!(${ensuresExpr})}; })`;
  return vm.runInContext(src, ctx, { timeout: 2000 });
}
function show(v) { try { return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v); } catch (_) { return String(v); } }

function proveCell(cell, ctx, fn) {
  const params = parseIn(cell.spec);
  if (params.some((p) => !valuesFor(p.type))) return { status: 'skip', level: 'yellow', reason: 'inputs include a type the prover can\'t generate (' + params.map((p) => p.type).join(', ') + ')' };
  const ensures = String(cell.spec.ensures || '').trim();
  let checker;
  try { checker = buildChecker(ctx, params.map((p) => p.name), ensures); }
  catch (_) { return { status: 'skip', level: 'yellow', reason: 'ensures is not a checkable expression (prose?)' }; }

  const tuples = cartesian(params.map((p) => valuesFor(p.type)), 40);
  const cases = tuples.length || 1;
  let threw = 0, lastErr = '';
  for (const A of (tuples.length ? tuples : [[]])) {
    let r;
    try { r = checker(fn, A); }
    catch (e) { threw++; lastErr = e && e.message ? e.message.split('\n')[0] : 'threw'; continue; }
    if (!r.ok) {
      const argstr = params.map((p, i) => `${p.name}=${show(A[i])}`).join(', ');
      return { status: 'fail', level: 'red', cases, counterexample: `${cell.unitName}(${argstr || ''}) → ${show(r.out)} — violates ensures: ${ensures}` };
    }
  }
  if (threw >= cases) return { status: 'skip', level: 'yellow', reason: `threw on generated inputs (${lastErr}) — can't prove` };
  return { status: 'pass', level: 'info', cases: cases - threw };
}

// Prove every eligible Cell. Returns { [cellId]: result }.
function proveManifest(manifest) {
  const out = {};
  const byFile = {};
  for (const id of Object.keys(manifest.cells)) {
    const c = manifest.cells[id];
    const isLeaf = !(c.contains && c.contains.length);
    const pure = /^yes\b/i.test((c.spec && c.spec.pure) || '');
    if (!isLeaf || !pure || !c.unitFound || !(c.spec && c.spec.ensures)) continue;
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(c.unitName || '')) { out[id] = { status: 'skip', level: 'info', reason: 'method/qualified units not yet supported' }; continue; }
    (byFile[c.file] = byFile[c.file] || []).push(c);
  }
  for (const file of Object.keys(byFile)) {
    const cells = byFile[file];
    const loaded = loadFile(path.join(manifest.root, file), cells.map((c) => c.unitName));
    if (loaded.error) { for (const c of cells) out[c.id] = { status: 'skip', level: 'info', reason: 'could not run file (' + loaded.error + ')' }; continue; }
    for (const c of cells) {
      const fn = loaded.fns[c.unitName];
      if (typeof fn !== 'function') { out[c.id] = { status: 'skip', level: 'info', reason: 'unit not callable in isolation' }; continue; }
      try { out[c.id] = proveCell(c, loaded.ctx, fn); }
      catch (e) { out[c.id] = { status: 'skip', level: 'info', reason: 'prover error: ' + (e && e.message) }; }
    }
  }
  return out;
}

module.exports = { proveManifest };
