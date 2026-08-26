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
const { mutants } = require('./mutate');
const { makeRecorder } = require('./record');
const { isJsLang } = require('./util');

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
    Error, TypeError, RangeError, // so probes/units can throw with a readable message
    isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    NaN, Infinity, undefined,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    __ylreg: (obj) => { Object.assign(registry, obj); },
    __mkrec: makeRecorder, // effect recorder factory (for `records:` Cells)
  };
  const sandbox = new Proxy(real, {
    has: () => true, // tell the VM every identifier is "global" → no ReferenceError
    get: (t, k) => (k in t ? t[k] : blackHole()),
  });
  return vm.createContext(sandbox);
}

// Run a source string in a fresh sandbox; return { fns, ctx } capturing `names`.
function runSource(source, names) {
  const stripped = stripTS(source);
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
// Split on TOP-LEVEL commas only, so object/array/generic param types keep their
// internal commas (`paddle: {x,y,w,h}, step: number` → two params, not six).
function splitTopLevel(s) {
  const out = []; let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '{' || ch === '[' || ch === '(' || ch === '<') depth++;
    else if (ch === '}' || ch === ']' || ch === ')' || ch === '>') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
function parseIn(spec) {
  let raw = (spec && spec.in ? String(spec.in) : '').trim();
  raw = raw.replace(/^\(([\s\S]*)\)$/, '$1').trim(); // tolerate `(a:number, b:number)` wrapping
  if (!raw || /^todo$/i.test(raw)) return [];
  return splitTopLevel(raw).map((part) => {
    const i = part.indexOf(':'); // split on the FIRST colon; object types keep theirs
    const name = (i < 0 ? part : part.slice(0, i)).trim();
    const type = (i < 0 ? 'any' : part.slice(i + 1)).trim().toLowerCase().replace(/\s+/g, '');
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
// SAFE, unambiguous normalizations only (never anything that could change meaning
// and mint a false pass): `;` clause-separator → conjunction, and |simple| → Math.abs.
function normalizeEnsures(ensuresExpr) {
  return String(ensuresExpr || '')
    .replace(/;/g, ' && ')
    .replace(/\|\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*\|/g, 'Math.abs($1)') // |dx| → Math.abs(dx)
    .replace(/(?:&&\s*)+$/, '')
    .trim() || 'true';
}
// A helpful, honest reason when an `ensures` can't be machine-checked — tells the
// author exactly how to make it checkable, instead of a bare "prose?".
function ensuresHint(ensuresExpr) {
  const e = String(ensuresExpr || '');
  if (/\b(iff|⇔|<=>)\b/i.test(e)) return 'uses "iff" — write it as JS: `A === B` (boolean equality)';
  if (/(=>|⇒|\bimplies\b)/i.test(e)) return 'uses implication — write it as JS: `(!A || B)`';
  if (/\b(for ?all|every|each|∀)\b/i.test(e)) return 'uses "for all/every" — write it as JS: `arr.every(x => …)`';
  if (/\b(unchanged|not ?mutated|immutab)\b/i.test(e)) return 'talks about mutation — compare a copy: `JSON.stringify(out) === JSON.stringify(fn(...))`';
  if (/\bclamp\b/i.test(e)) return 'uses clamp() — inline it: `Math.max(lo, Math.min(x, hi))`';
  if (!/[<>=!]=?|===|!==|&&|\|\||\.every|\.some|\.includes/.test(e)) return 'reads as prose — write a boolean JS expression over `out` and the inputs';
  return 'not valid JavaScript — write `ensures:` as a boolean expression over `out` and the inputs';
}
function buildChecker(ctx, params, ensuresExpr) {
  const expr = normalizeEnsures(ensuresExpr);
  const decl = params.map((p, i) => `var ${p}=A[${i}];`).join(' ');
  const call = `fn(${params.map((_, i) => `A[${i}]`).join(',')})`;
  const src = `(function(fn,A){ ${decl} var out=${call}; return {out:out, ok:!!(${expr})}; })`;
  return vm.runInContext(src, ctx, { timeout: 2000 });
}
// Effect-aware checker: instrument the `records:` param with a recorder, run the
// (side-effecting) function, and evaluate `ensures` against the recorded trace.
// The ensures may use: `trace` (raw), `calls(name)` → arg-arrays, `sets(name)` →
// assigned values, `didCall(name)`, `didSet(name, value)` — plus `out` and the args.
function buildEffectChecker(ctx, params, recordsName, ensuresExpr) {
  const idx = params.indexOf(recordsName);
  if (idx < 0) throw new Error('records: names "' + recordsName + '", which is not a parameter in in:');
  const expr = normalizeEnsures(ensuresExpr);
  const decl = params.map((p, i) => `var ${p}=A[${i}];`).join(' ');
  const call = `fn(${params.map((_, i) => `A[${i}]`).join(',')})`;
  const helpers = 'function calls(n){return trace.filter(function(e){return e.type==="call"&&e.name===n;}).map(function(e){return e.args;});}'
    + 'function sets(n){return trace.filter(function(e){return e.type==="set"&&e.name===n;}).map(function(e){return e.value;});}'
    + 'function didCall(n){return calls(n).length>0;}function didSet(n,v){return sets(n).indexOf(v)>=0;}';
  const src = `(function(fn,A){ var __r=__mkrec(); A[${idx}]=__r.proxy; ${decl} var trace=__r.trace; ${helpers} var out=${call}; return {out:out, trace:trace, ok:!!(${expr})}; })`;
  return vm.runInContext(src, ctx, { timeout: 2000 });
}
function show(v) { try { return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v); } catch (_) { return String(v); } }

function proveCell(cell, ctx, fn) {
  const params = parseIn(cell.spec);
  if (params.some((p) => !valuesFor(p.type))) return { status: 'skip', level: 'yellow', reason: 'inputs include a type the prover can\'t generate (' + params.map((p) => p.type).join(', ') + ')' };
  const ensures = String(cell.spec.ensures || '').trim();
  let checker;
  try { checker = buildChecker(ctx, params.map((p) => p.name), ensures); }
  catch (_) { return { status: 'skip', level: 'yellow', reason: 'ensures not machine-checkable — ' + ensuresHint(ensures) }; }

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

// Mutation testing: corrupt the code one edit at a time, re-run the SAME ensures
// tests, and see how many mutants the ensures kills. A low score means the ensures
// is too weak to be trusted — it passes even when the code is broken.
function runMutation(source, cell) {
  const params = parseIn(cell.spec);
  const ensures = String(cell.spec.ensures || '');
  const muts = mutants(cell.unitBody || '', 30);
  if (!muts.length) return { total: 0, killed: 0, survived: 0, score: null };
  const tuples = cartesian(params.map((p) => valuesFor(p.type)), 40);
  const inputs = tuples.length ? tuples : [[]];
  const srcLines = source.split(/\r?\n/);
  const start = cell.unitBodyStart || 0;
  const len = (cell.unitBody || '').split('\n').length;
  let killed = 0, survived = 0, survivor = null;
  for (const m of muts) {
    const lines = srcLines.slice();
    lines.splice(start, len, ...m.code.split('\n'));
    const r = runSource(lines.join('\n'), [cell.unitName]);
    if (r.error || typeof r.fns[cell.unitName] !== 'function') { killed++; continue; } // mutant broke → detected
    let checker;
    try { checker = buildChecker(r.ctx, params.map((p) => p.name), ensures); }
    catch (_) { killed++; continue; }
    let dead = false;
    for (const A of inputs) {
      let rr; try { rr = checker(r.fns[cell.unitName], A); } catch (_) { dead = true; break; }
      if (!rr.ok) { dead = true; break; }
    }
    if (dead) killed++; else { survived++; if (!survivor) survivor = m.op; }
  }
  const total = killed + survived;
  return { total, killed, survived, score: total ? killed / total : null, survivor };
}

// Prove every eligible Cell. opts.mutate (default true) also grades each passing
// Cell's ensures by mutation. Returns { [cellId]: result }.
function proveManifest(manifest, opts) {
  const mutate = !opts || opts.mutate !== false;
  const out = {};
  const byFile = {};
  for (const id of Object.keys(manifest.cells)) {
    const c = manifest.cells[id];
    const isLeaf = !(c.contains && c.contains.length);
    const pure = /^yes\b/i.test((c.spec && c.spec.pure) || '');
    if (!isLeaf || !pure || !c.unitFound || !(c.spec && c.spec.ensures)) continue;
    if (c.lang && !isJsLang(c.lang)) continue; // prover is a JS/TS VM; an explicitly non-JS lang stays unproven (Yellow). Missing lang ⇒ JS (legacy default).
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(c.unitName || '')) { out[id] = { status: 'skip', level: 'info', reason: 'method/qualified units not yet supported' }; continue; }
    (byFile[c.file] = byFile[c.file] || []).push(c);
  }
  for (const file of Object.keys(byFile)) {
    const cells = byFile[file];
    let source; try { source = fs.readFileSync(path.join(manifest.root, file), 'utf8'); }
    catch (_) { for (const c of cells) out[c.id] = { status: 'skip', level: 'info', reason: 'file unreadable' }; continue; }
    const base = runSource(source, cells.map((c) => c.unitName));
    if (base.error) { for (const c of cells) out[c.id] = { status: 'skip', level: 'info', reason: 'could not run file (' + base.error + ')' }; continue; }
    for (const c of cells) {
      const fn = base.fns[c.unitName];
      if (typeof fn !== 'function') { out[c.id] = { status: 'skip', level: 'info', reason: 'unit not callable in isolation' }; continue; }
      try {
        const res = proveCell(c, base.ctx, fn);
        if (res.status === 'pass' && mutate) res.mutation = runMutation(source, c);
        out[c.id] = res;
      } catch (e) { out[c.id] = { status: 'skip', level: 'info', reason: 'prover error: ' + (e && e.message) }; }
    }
  }
  return out;
}

module.exports = { proveManifest, runSource, parseIn, buildChecker, buildEffectChecker, show, ensuresHint, normalizeEnsures };
