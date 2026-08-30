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
const cp = require('child_process');
const { mutants, deletions, harvestLiterals } = require('./mutate');
const { makeRecorder } = require('./record');
const { instrument: instrumentBranches } = require('./coverage');
const { analyzePredicates } = require('./predicate');
const { isJsLang, looseTopLevelNonJs, normLangName } = require('./util');

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

// A recording "hyperscript": JSX compiles to __h(type, props, ...children) (pragma
// __h), and this builds a plain { type, props, children } vnode tree — no real React,
// no DOM — that a component Cell's `ensures` can be checked against. Child components
// appear as { type:'<Name>' } nodes (shallow render); primitives/strings are leaves.
function hyperscript(type, props) {
  const kids = [];
  for (let i = 2; i < arguments.length; i++) kids.push(arguments[i]);
  const flat = [];
  (function fl(a) { for (let i = 0; i < a.length; i++) { const c = a[i]; if (Array.isArray(c)) fl(c); else if (c != null && c !== false && c !== true) flat.push(c); } })(kids);
  const t = typeof type === 'function' ? (type.displayName || type.name || 'Component') : (type == null ? '#fragment' : type);
  return { type: t, props: props || {}, children: flat };
}
// Deterministic hook shims so a component renders ONCE for given props without a real
// React runtime. This exercises the initial render (what render-proving checks); it does
// not drive state transitions, effects, or events (an honest v1 boundary).
function reactShim() {
  const noop = () => {};
  const hooks = {
    useState: (i) => [typeof i === 'function' ? i() : i, noop],
    useReducer: (_r, i) => [i, noop],
    useRef: (i) => ({ current: i === undefined ? null : i }),
    useMemo: (f) => (typeof f === 'function' ? f() : undefined),
    useCallback: (f) => f,
    useEffect: noop, useLayoutEffect: noop, useContext: () => undefined,
  };
  return { hooks, React: Object.assign({ createElement: hyperscript, Fragment: '#fragment' }, hooks) };
}

function makeSandbox(names, registry, extras) {
  const rs = reactShim();
  const real = {
    Math, JSON, String, Number, Boolean, Array, Object, RegExp, Date, Symbol,
    Error, TypeError, RangeError, // so probes/units can throw with a readable message
    isNaN, isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    NaN, Infinity, undefined,
    console: { log() {}, warn() {}, error() {}, info() {}, debug() {} },
    __ylreg: (obj) => { Object.assign(registry, obj); },
    __mkrec: makeRecorder, // effect recorder factory (for `records:` Cells)
    __h: hyperscript, __Fragment: '#fragment', // JSX pragma targets (for `renders:` Cells)
    React: rs.React, ...rs.hooks, // React.createElement/hooks AND bare hooks (imports are stripped)
    ...(extras || {}), // e.g. __ylcov (a real branch-coverage array the instrumented probes increment)
  };
  const sandbox = new Proxy(real, {
    has: () => true, // tell the VM every identifier is "global" → no ReferenceError
    get: (t, k) => (k in t ? t[k] : blackHole()),
  });
  return vm.createContext(sandbox);
}

// Compile JSX (and, for .tsx, TS types) to plain JS via Babel, with the JSX pragma
// pointed at our __h/__Fragment. Babel is an OPTIONAL dependency, required lazily and
// only on the JSX path — if it's absent we return a distinct error so the Cell skips
// with an honest "install …" note rather than a fake pass. @babel/parser is already a
// dependency, so this stays in-family and battle-tested on JSX's edge cases.
function transformJSX(source, file) {
  // Require the plugins as MODULES (resolved relative to this file → yay-layer's own
  // node_modules), never as string names — Babel resolves plugin strings from the cwd,
  // which is the USER's project when `yay verify` runs, where these deps don't live.
  let babel, jsxPlugin, tsPlugin;
  try {
    babel = require('@babel/core');
    jsxPlugin = require('@babel/plugin-transform-react-jsx'); jsxPlugin = jsxPlugin.default || jsxPlugin;
  } catch (_) { return { error: 'jsx-needs-babel' }; }
  const isTS = /\.tsx?$/.test(file || '');
  const isTSX = /\.tsx$/.test(file || '');
  const plugins = [];
  if (isTS) {
    try { tsPlugin = require('@babel/plugin-transform-typescript'); tsPlugin = tsPlugin.default || tsPlugin; }
    catch (_) { return { error: 'jsx-needs-babel' }; }
    plugins.push([tsPlugin, { isTSX, allowDeclareFields: true }]);
  }
  plugins.push([jsxPlugin, { runtime: 'classic', pragma: '__h', pragmaFrag: '__Fragment' }]);
  try {
    const out = babel.transformSync(source, { filename: file || 'component.jsx', babelrc: false, configFile: false, compact: false, plugins });
    return { code: out && out.code != null ? out.code : source };
  } catch (e) {
    return { error: 'jsx-transform: ' + ((e && e.message) || 'failed').split('\n')[0] };
  }
}

// Run a source string in a fresh sandbox; return { fns, ctx } capturing `names`.
// opts.jsx compiles JSX/TSX first (Babel); otherwise TS types are stripped as before.
function runSource(source, names, opts) {
  opts = opts || {};
  let stripped;
  if (opts.jsx) {
    const t = transformJSX(source, opts.file);
    if (t.error) return { error: t.error };
    stripped = t.code;
  } else {
    stripped = stripTS(source);
    if (stripped == null) return { error: 'typescript-strip-failed' };
  }
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
// Same as parseIn but PRESERVES case in the type — needed for component props, whose
// names are case-sensitive (onClick, className). valuesFor lowercases for primitive
// lookups internally, so keeping case here only affects object field names.
function parseInCased(spec) {
  let raw = (spec && spec.in ? String(spec.in) : '').trim();
  raw = raw.replace(/^\(([\s\S]*)\)$/, '$1').trim();
  if (!raw || /^todo$/i.test(raw)) return [];
  return splitTopLevel(raw).map((part) => {
    const i = part.indexOf(':');
    const name = (i < 0 ? part : part.slice(0, i)).trim();
    const type = (i < 0 ? 'any' : part.slice(i + 1)).trim().replace(/\s+/g, '');
    return { name, type };
  }).filter((p) => p.name);
}
const POOLS = {
  number: [0, 1, 2, -1, 3, 7, 10, -5, 0.5, 100],
  string: ['', 'a', 'ab', 'abc', 'Hello', '/x', '123', 'a b'],
  boolean: [true, false],
};
// Parse an object-shape type `{title:string, featured:boolean}` into fields, PRESERVING
// field-name case (prop names are case-sensitive). Returns null if it isn't a shape.
function objectShape(type) {
  const m = String(type).match(/^\{([\s\S]*)\}$/);
  if (!m) return null;
  const fields = splitTopLevel(m[1]).map((f) => { const i = f.indexOf(':'); if (i < 0) return null; return { name: f.slice(0, i).trim(), type: f.slice(i + 1).trim() }; }).filter(Boolean);
  return fields.length ? fields : null;
}
function valuesFor(type) {
  const lt = String(type).toLowerCase();
  if (POOLS[lt]) return POOLS[lt];
  const arr = lt.match(/^(number|string|boolean)\[\]$/);
  if (arr) { const b = POOLS[arr[1]]; return [[], [b[1]], [b[1], b[2]], b.slice(0, 3)]; }
  const shape = objectShape(type); // object props → generate objects (cased field names)
  if (shape) {
    const fv = shape.map((f) => valuesFor(f.type));
    if (fv.some((v) => !v)) return null;
    const combos = cartesian(fv, 12);
    return combos.map((tuple) => { const o = {}; shape.forEach((f, i) => { o[f.name] = tuple[i]; }); return o; });
  }
  if (/\[\]$/.test(String(type))) { // any-element array (e.g. object[]) → a few sample arrays
    const base = valuesFor(String(type).replace(/\[\]$/, ''));
    if (!base || !base.length) return null;
    return [[], [base[Math.min(1, base.length - 1)]], base.slice(0, 3)];
  }
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
// Render checker (for `renders:` Cells): run the component with generated props, take
// the returned vnode tree as `out`, and evaluate `ensures` with tree helpers in scope:
//   text(n) · find(n,type) · findAll(n,type) · has(n,type) · count(n,type)
//   attr(n,name) · hasClass(n,class) · kids(n)
// (Mirrors buildEffectChecker: a checkable surface + helpers instead of a bare return.)
function buildRenderChecker(ctx, params, ensuresExpr) {
  const expr = normalizeEnsures(ensuresExpr);
  const decl = params.map((p, i) => `var ${p}=A[${i}];`).join(' ');
  const call = `fn(${params.map((_, i) => `A[${i}]`).join(',')})`;
  const helpers = ''
    + 'function __nodes(n){var acc=[];(function w(x){if(x&&typeof x==="object"&&x.type!==undefined){acc.push(x);(x.children||[]).forEach(w);}})(n);return acc;}'
    + 'function find(n,t){var a=__nodes(n);for(var i=0;i<a.length;i++)if(a[i].type===t)return a[i];return null;}'
    + 'function findAll(n,t){return __nodes(n).filter(function(x){return x.type===t;});}'
    + 'function has(n,t){return findAll(n,t).length>0;}'
    + 'function count(n,t){return findAll(n,t).length;}'
    + 'function attr(n,name){return n&&n.props?n.props[name]:undefined;}'
    + 'function kids(n){return n&&n.children?n.children:[];}'
    + 'function hasClass(n,c){var cn=n&&n.props?String(n.props.className||""):"";return cn.split(/\\s+/).indexOf(c)>=0;}'
    + 'function text(n){var s="";(function w(x){if(x==null||x===false||x===true)return;if(typeof x==="object"&&x.type!==undefined){(x.children||[]).forEach(w);}else{s+=String(x);}})(n);return s;}';
  const src = `(function(fn,A){ ${decl} var out=${call}; ${helpers} return {out:out, ok:!!(${expr})}; })`;
  return vm.runInContext(src, ctx, { timeout: 2000 });
}
function show(v) { try { return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v); } catch (_) { return String(v); } }

// ── proving adapters ────────────────────────────────────────────────────────
// Each prover mode is an adapter: it says which Cells it handles (canHandle),
// how to parse the spec's `in:` (inputs), how to build a checker that exposes a
// checkable surface + evaluates `ensures` (checker), and how to phrase a
// counterexample (describe). The core driver owns dispatch, the case-loop, and
// mutation — so a new framework/language is a new adapter, not a core edit.
// (`load` is uniform here because all current adapters run in the same JS VM; an
// out-of-VM adapter, e.g. Python, will carry its own load — see docs/design.)
function jsLoad(source, names, opts) { return runSource(source, names, { jsx: !!(opts && opts.jsx), file: opts && opts.file }); }

const pureCallAdapter = {
  name: 'pure-call', inVM: true, wantsJSX: false,
  canHandle: (cell) => /^yes\b/i.test((cell.spec && cell.spec.pure) || ''),
  load: jsLoad,
  inputs: (cell) => parseIn(cell.spec),
  inputNoun: 'inputs',
  threwVerb: 'on generated inputs',
  checker: (ctx, params, ensures) => buildChecker(ctx, params, ensures),
  describe: (cell, argstr, r, ensures) => `${cell.unitName}(${argstr || ''}) → ${show(r.out)} — violates ensures: ${ensures}`,
};

const renderAdapter = {
  name: 'render', inVM: true, wantsJSX: true,
  canHandle: (cell) => /^yes\b/i.test((cell.spec && cell.spec.renders) || ''),
  load: jsLoad,
  inputs: (cell) => parseInCased(cell.spec), // case-preserved props (onClick/className)
  inputNoun: 'props',
  threwVerb: 'while rendering',
  checker: (ctx, params, ensures) => buildRenderChecker(ctx, params, ensures),
  describe: (cell, argstr, r, ensures) => {
    const rootT = r.out && r.out.type ? '<' + r.out.type + '>' : show(r.out);
    return `${cell.unitName}(${argstr || ''}) → renders ${rootT} — violates ensures: ${ensures}`;
  },
};

// ── Python adapter (out-of-VM) — the first non-JS prover, proving the interface
// generalises. It runs a Cell's Python function in a subprocess over spec-generated
// inputs and evaluates the (Python) `ensures` against each. Purely additive: it only
// claims `lang: python` Cells, which the JS-VM adapters already skip — so no JS/TS/JSX
// behaviour can change. Python is a lazy/optional runtime dep: absent → honest skip.
function isPythonLang(l) { return /^(py|python)$/i.test(String(l || '')); }
let PY_BIN;
function detectPython() {
  if (PY_BIN !== undefined) return PY_BIN;
  for (const bin of ['python3', 'python']) {
    try { cp.execFileSync(bin, ['-c', 'import sys,json'], { stdio: 'ignore', timeout: 4000 }); PY_BIN = bin; return bin; } catch (_) {}
  }
  PY_BIN = null; return PY_BIN;
}
// Harness: read {source, unit, params, inputs, ensures} as JSON on stdin; exec the
// file, call the unit for each input tuple, and eval the ensures with a SAFE builtin
// subset (never a fake pass — a raised exception skips that tuple; all-throw ⇒ skip).
const PY_HARNESS = [
  'import sys, json',
  'd = json.loads(sys.stdin.read())',
  'ns = {}',
  'try:',
  "    exec(d['source'], ns)",
  'except Exception as e:',
  "    print(json.dumps({'error': 'load: ' + str(e)})); sys.exit(0)",
  "fn = ns.get(d['unit'])",
  'if not callable(fn):',
  "    print(json.dumps({'error': 'unit not callable in isolation'})); sys.exit(0)",
  "SAFE = {'len':len,'abs':abs,'all':all,'any':any,'min':min,'max':max,'sum':sum,'sorted':sorted,'range':range,'str':str,'int':int,'float':float,'bool':bool,'round':round,'list':list,'dict':dict,'set':set,'tuple':tuple,'enumerate':enumerate,'zip':zip}",
  'def ser(v):',
  '    try:',
  '        json.dumps(v); return v',
  '    except Exception:',
  '        return str(v)',
  'threw = 0; total = 0',
  "for args in d['inputs']:",
  '    total += 1',
  '    try:',
  '        out = fn(*args)',
  "        scope = dict(zip(d['params'], args)); scope['out'] = out",
  "        ok = bool(eval(d['ensures'], {'__builtins__': {}}, dict(SAFE, **scope)))",
  '    except Exception as e:',
  '        threw += 1; continue',
  '    if not ok:',
  "        argstr = ', '.join('%s=%r' % (p, a) for p, a in zip(d['params'], args))",
  "        print(json.dumps({'fail': {'argstr': argstr, 'out': ser(out)}})); sys.exit(0)",
  'if total and threw >= total:',
  "    print(json.dumps({'error': 'threw on all generated inputs'})); sys.exit(0)",
  "print(json.dumps({'pass': True, 'cases': total - threw}))",
].join('\n');

function runPythonBatch(pyBin, source, unit, paramNames, inputs, ensures) {
  const payload = JSON.stringify({ source, unit, params: paramNames, inputs, ensures });
  let out;
  try { out = cp.execFileSync(pyBin, ['-c', PY_HARNESS], { input: payload, timeout: 8000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); }
  catch (e) { return { error: (e && e.message ? String(e.message).split('\n')[0] : 'python failed') }; }
  const line = String(out).trim().split('\n').filter(Boolean).pop() || '';
  try { return JSON.parse(line); } catch (_) { return { error: 'unreadable harness output' }; }
}

const pythonAdapter = {
  name: 'python', inVM: false, wantsJSX: false,
  canHandle: (cell) => isPythonLang(cell.lang || (cell.spec && cell.spec.lang)) && /^yes\b/i.test((cell.spec && cell.spec.pure) || ''),
  load: (source, names) => {
    const pyBin = detectPython();
    if (!pyBin) return { error: 'python-missing' };
    // The harness exec()s the whole module to reach the function — with REAL builtins,
    // no VM sandbox — so top-level imperative code (os.system(…), a bare call) would
    // actually RUN during verify. Refuse to prove such a file: it's flagged Pink by the
    // manifest and gate-blocked anyway; we must not execute it to get there.
    if (looseTopLevelNonJs(String(source).split(/\r?\n/), 'python').length) {
      return { error: 'python-toplevel' };
    }
    const fns = {}; for (const n of names) fns[n] = function () {}; // placeholder — real run is out-of-process in prove()
    return { fns, ctx: { pyBin, source } };
  },
  // Out-of-VM proving in ONE subprocess per Cell; same verdict shape as runCases.
  prove: (cell, base) => {
    const params = parseIn(cell.spec);
    if (params.some((p) => !valuesFor(p.type))) return { status: 'skip', level: 'yellow', reason: 'inputs include a type the prover can\'t generate (' + params.map((p) => p.type).join(', ') + ')' };
    const ensures = String(cell.spec.ensures || '').trim();
    const tuples = cartesian(params.map((p) => valuesFor(p.type)), 40);
    const inputs = tuples.length ? tuples : [[]];
    const r = runPythonBatch(base.ctx.pyBin, base.ctx.source, cell.unitName, params.map((p) => p.name), inputs, ensures);
    if (r.error) return { status: 'skip', level: 'yellow', reason: 'python: ' + r.error };
    if (r.fail) return { status: 'fail', level: 'red', cases: inputs.length, counterexample: `${cell.unitName}(${r.fail.argstr}) → ${show(r.fail.out)} — violates ensures: ${ensures}` };
    return { status: 'pass', level: 'info', cases: (typeof r.cases === 'number' ? r.cases : inputs.length) };
  },
};

// ── Ruby adapter (out-of-VM) — same shape as Python: proves a pure Ruby method against a Ruby
// `ensures` in a `ruby` subprocess over spec-generated inputs. Optional runtime: absent → skip.
function isRubyLang(l) { return normLangName(l) === 'ruby'; }
let RB_BIN;
function detectRuby() {
  if (RB_BIN !== undefined) return RB_BIN;
  try { cp.execFileSync('ruby', ['-e', 'require "json"'], { stdio: 'ignore', timeout: 4000 }); RB_BIN = 'ruby'; return RB_BIN; } catch (_) {}
  RB_BIN = null; return RB_BIN;
}
const RB_HARNESS = [
  'require "json"',
  'd = JSON.parse(STDIN.read)',
  'b = binding',
  'begin',
  '  eval(d["source"], b)',
  'rescue Exception => e',
  '  puts JSON.generate({"error" => "load: " + e.message}); exit 0',
  'end',
  'fn = (b.eval("method(:" + d["unit"] + ")") rescue nil)',
  'if fn.nil?',
  '  puts JSON.generate({"error" => "unit not callable in isolation"}); exit 0',
  'end',
  'threw = 0; total = 0',
  'd["inputs"].each do |args|',
  '  total += 1',
  '  begin',
  '    out = fn.call(*args)',
  '    eb = binding',
  '    d["params"].each_with_index { |p, i| eb.local_variable_set(p.to_sym, args[i]) }',
  '    eb.local_variable_set(:out, out)',
  '    ok = eb.eval(d["ensures"]) ? true : false',
  '  rescue Exception => e',
  '    threw += 1; next',
  '  end',
  '  unless ok',
  '    argstr = d["params"].each_with_index.map { |p, i| "#{p}=#{args[i].inspect}" }.join(", ")',
  '    o = ((JSON.generate(out) rescue nil) ? out : out.inspect)',
  '    puts JSON.generate({"fail" => {"argstr" => argstr, "out" => o}}); exit 0',
  '  end',
  'end',
  'if total > 0 && threw >= total',
  '  puts JSON.generate({"error" => "threw on all generated inputs"}); exit 0',
  'end',
  'puts JSON.generate({"pass" => true, "cases" => total - threw})',
].join('\n');
function runRubyBatch(bin, source, unit, paramNames, inputs, ensures) {
  const payload = JSON.stringify({ source, unit, params: paramNames, inputs, ensures });
  let out;
  try { out = cp.execFileSync(bin, ['-e', RB_HARNESS], { input: payload, timeout: 8000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); }
  catch (e) { return { error: (e && e.message ? String(e.message).split('\n')[0] : 'ruby failed') }; }
  const line = String(out).trim().split('\n').filter(Boolean).pop() || '';
  try { return JSON.parse(line); } catch (_) { return { error: 'unreadable harness output' }; }
}

// ── PHP adapter (out-of-VM) — same shape. Proves a pure PHP function against a PHP `ensures`.
function isPhpLang(l) { return normLangName(l) === 'php'; }
let PHP_BIN;
function detectPhp() {
  if (PHP_BIN !== undefined) return PHP_BIN;
  try { cp.execFileSync('php', ['-r', 'echo json_encode(1);'], { stdio: 'ignore', timeout: 4000 }); PHP_BIN = 'php'; return PHP_BIN; } catch (_) {}
  PHP_BIN = null; return PHP_BIN;
}
const PHP_HARNESS = [
  '$d = json_decode(stream_get_contents(STDIN), true);',
  '$unit = $d["unit"]; $params = $d["params"]; $ens = $d["ensures"];',
  'try { eval("?>" . $d["source"]); } catch (\\Throwable $e) { echo json_encode(["error" => "load: " . $e->getMessage()]); exit(0); }',
  'if (!function_exists($unit)) { echo json_encode(["error" => "unit not defined in isolation"]); exit(0); }',
  '$threw = 0; $total = 0;',
  'foreach ($d["inputs"] as $args) {',
  '  $total++;',
  '  try {',
  '    $out = call_user_func_array($unit, $args);',
  '    $scope = ["out" => $out]; foreach ($params as $i => $p) { $scope[$p] = $args[$i]; }',
  '    extract($scope);',
  '    $ok = (bool) eval("return (" . $ens . ");");',
  '  } catch (\\Throwable $e) { $threw++; continue; }',
  '  if (!$ok) {',
  '    $parts = []; foreach ($params as $i => $p) { $parts[] = "$p=" . var_export($args[$i], true); }',
  '    echo json_encode(["fail" => ["argstr" => implode(", ", $parts), "out" => $out]]); exit(0);',
  '  }',
  '}',
  'if ($total > 0 && $threw >= $total) { echo json_encode(["error" => "threw on all generated inputs"]); exit(0); }',
  'echo json_encode(["pass" => true, "cases" => $total - $threw]);',
].join('\n');
function runPhpBatch(bin, source, unit, paramNames, inputs, ensures) {
  const payload = JSON.stringify({ source, unit, params: paramNames, inputs, ensures });
  let out;
  try { out = cp.execFileSync(bin, ['-r', PHP_HARNESS], { input: payload, timeout: 8000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }); }
  catch (e) { return { error: (e && e.message ? String(e.message).split('\n')[0] : 'php failed') }; }
  const line = String(out).trim().split('\n').filter(Boolean).pop() || '';
  try { return JSON.parse(line); } catch (_) { return { error: 'unreadable harness output' }; }
}

// Shared prove() body for the subprocess (Ruby/PHP) adapters — mirrors the Python one.
function proveSubprocess(runBatch, langLabel, cell, base) {
  const params = parseIn(cell.spec);
  if (params.some((p) => !valuesFor(p.type))) return { status: 'skip', level: 'yellow', reason: 'inputs include a type the prover can\'t generate (' + params.map((p) => p.type).join(', ') + ')' };
  const ensures = String(cell.spec.ensures || '').trim();
  if (!ensures) return { status: 'skip', level: 'yellow', reason: 'no `ensures:` to machine-check' };
  const tuples = cartesian(params.map((p) => valuesFor(p.type)), 40);
  const inputs = tuples.length ? tuples : [[]];
  const r = runBatch(base.ctx.bin, base.ctx.source, cell.unitName, params.map((p) => p.name), inputs, ensures);
  if (r.error) return { status: 'skip', level: 'yellow', reason: langLabel + ': ' + r.error };
  if (r.fail) return { status: 'fail', level: 'red', cases: inputs.length, counterexample: `${cell.unitName}(${r.fail.argstr}) → ${show(r.fail.out)} — violates ensures: ${ensures}` };
  return { status: 'pass', level: 'info', cases: (typeof r.cases === 'number' ? r.cases : inputs.length) };
}

const rubyAdapter = {
  name: 'ruby', inVM: false, wantsJSX: false,
  canHandle: (cell) => isRubyLang(cell.langName || cell.lang || (cell.spec && cell.spec.lang)) && /^yes\b/i.test((cell.spec && cell.spec.pure) || ''),
  load: (source, names) => {
    const bin = detectRuby();
    if (!bin) return { error: 'ruby-missing' };
    if (looseTopLevelNonJs(String(source).split(/\r?\n/), 'ruby').length) return { error: 'ruby-toplevel' };
    const fns = {}; for (const n of names) fns[n] = function () {};
    return { fns, ctx: { bin, source } };
  },
  prove: (cell, base) => proveSubprocess(runRubyBatch, 'ruby', cell, base),
};

const phpAdapter = {
  name: 'php', inVM: false, wantsJSX: false,
  canHandle: (cell) => isPhpLang(cell.langName || cell.lang || (cell.spec && cell.spec.lang)) && /^yes\b/i.test((cell.spec && cell.spec.pure) || ''),
  load: (source, names) => {
    const bin = detectPhp();
    if (!bin) return { error: 'php-missing' };
    if (looseTopLevelNonJs(String(source).split(/\r?\n/), 'php').length) return { error: 'php-toplevel' };
    const fns = {}; for (const n of names) fns[n] = function () {};
    return { fns, ctx: { bin, source } };
  },
  prove: (cell, base) => proveSubprocess(runPhpBatch, 'php', cell, base),
};

// Registry (order = precedence). The out-of-VM language provers (Python/Ruby/PHP) are claimed
// before pure-call so a `pure: yes` Cell in those languages routes to its subprocess adapter,
// not the JS-VM one. The effect/`records:` surface stays an ADVERSARY concern, not a prover mode.
const ADAPTERS = [renderAdapter, pythonAdapter, rubyAdapter, phpAdapter, pureCallAdapter];

// Stage 5 — run one Cell's generated inputs through the adapter's checker. A single
// counterexample ⇒ Red; can't-check ⇒ honest skip; all cases hold ⇒ proven. Shared
// across adapters (this is the loop the old proveCell/proveRenderCell each duplicated).
function runCases(adapter, ctx, cell, fn) {
  const params = adapter.inputs(cell);
  if (params.some((p) => !valuesFor(p.type))) return { status: 'skip', level: 'yellow', reason: adapter.inputNoun + ' include a type the prover can\'t generate (' + params.map((p) => p.type).join(', ') + ')' };
  const ensures = String(cell.spec.ensures || '').trim();
  let checker;
  try { checker = adapter.checker(ctx, params.map((p) => p.name), ensures); }
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
      return { status: 'fail', level: 'red', cases, counterexample: adapter.describe(cell, argstr, r, ensures) };
    }
  }
  if (threw >= cases) return { status: 'skip', level: 'yellow', reason: `threw ${adapter.threwVerb} (${lastErr}) — can't prove` };
  return { status: 'pass', level: 'info', cases: cases - threw };
}

// Mutation testing: corrupt the code one edit at a time, re-run the SAME ensures
// tests (via the Cell's own adapter), and see how many mutants the ensures kills. A
// low score means the ensures is too weak to be trusted — it passes even when broken.
function runMutation(adapter, source, cell, opts) {
  opts = opts || {};
  const params = adapter.inputs(cell);
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
    const r = adapter.load(lines.join('\n'), [cell.unitName], { jsx: opts.jsx, file: opts.file });
    if (r.error || typeof r.fns[cell.unitName] !== 'function') { killed++; continue; } // mutant broke → detected
    let checker;
    try { checker = adapter.checker(r.ctx, params.map((p) => p.name), ensures); }
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

// INERTNESS check — the dual of mutation testing. Mutation corrupts code and asks
// "does the ensures notice?"; inertness DELETES a branch and asks "does anything
// notice?". A branch removable with every spec-derived test still passing is
// semantically inert under the promise: dead weight, ahead-of-spec scaffolding, or a
// dormant payload riding under the signature. Route: prune it, spec it, or declare it.
// Exemptions (both SIGNED — they live inside the spec, so using one to hide a payload
// means getting a human to sign the declaration):
//   throws: — a deleted guard containing `throw` is exempt when the spec declares throws
//   perf:   — declares intentional semantically-invisible code (cache, early-exit);
//             exempts the Cell, with the reason shown.
function runInertness(adapter, source, cell, opts) {
  opts = opts || {};
  const declaredThrows = String((cell.spec && cell.spec.throws) || '').trim();
  const perf = String((cell.spec && cell.spec.perf) || '').trim();
  if (perf && !/^todo$/i.test(perf)) return { checked: 0, flagged: [], exempt: 'perf: ' + perf };
  const params = adapter.inputs(cell);
  const ensures = String((cell.spec && cell.spec.ensures) || '');
  const dels = deletions(cell.unitBody || '', 20);
  if (!dels.length) return { checked: 0, flagged: [] };
  const tuples = cartesian(params.map((p) => valuesFor(p.type)), 40);
  const inputs = tuples.length ? tuples : [[]];
  const srcLines = source.split(/\r?\n/);
  const start = cell.unitBodyStart || 0;
  const len = (cell.unitBody || '').split('\n').length;
  const flagged = [];
  let checked = 0;
  for (const d of dels) {
    if (/\bthrow\b/.test(d.removed) && declaredThrows && !/^todo$/i.test(declaredThrows)) continue; // declared guard
    checked++;
    const lines = srcLines.slice();
    lines.splice(start, len, ...d.code.split('\n'));
    const r = adapter.load(lines.join('\n'), [cell.unitName], { jsx: opts.jsx, file: opts.file });
    if (r.error || typeof r.fns[cell.unitName] !== 'function') continue; // deletion broke the load → not inert
    let checker;
    try { checker = adapter.checker(r.ctx, params.map((p) => p.name), ensures); }
    catch (_) { continue; }
    let noticed = false;
    for (const A of inputs) {
      let rr; try { rr = checker(r.fns[cell.unitName], A); } catch (_) { noticed = true; break; }
      if (!rr.ok) { noticed = true; break; }
    }
    if (!noticed) {
      const snippet = d.removed.trim().split('\n')[0].slice(0, 80);
      flagged.push({ desc: d.desc, line: (cell.unitBodyStart || 0) + d.line, snippet });
      if (flagged.length >= 5) break; // enough to act on; don't drown the report
    }
  }
  return { checked, flagged };
}

// LITERAL-SEEDED TRIGGER HUNTING — the complement to inertness. Harvest the magic
// constants a dormant gate compares inputs against, synthesise IN-DOMAIN inputs that
// fire the gate, and check `ensures`. A hit is a PROVEN spec↔code contradiction → RED
// (same as any counterexample). Honesty: code-derived inputs live in a RED-ONLY lane —
// they can convict but never acquit, and never touch the proven-case count. Only builds
// inputs valid per `in:` (a string literal vs a `number` param is out-of-domain → skip),
// so every Red it produces is real.
function cloneVal(v) { try { return v == null ? v : JSON.parse(JSON.stringify(v)); } catch (_) { return v; } }
// Candidate IN-DOMAIN inputs for a param that satisfy the harvested trigger constraints.
// Returns a FEW variants (varying the free fields) so a triggered payload whose fake
// output coincidentally matches one fill is still caught by another — like a fuzzer
// varying the non-dictionary bytes after hitting a comparison. [] ⇒ can't build (skip).
function synthSeeds(type, cons) {
  const lt = String(type).toLowerCase();
  const eq = cons.find((c) => c.kind === 'eq');
  if (eq) {
    if (lt === 'string' && typeof eq.value === 'string') return [eq.value];
    if (lt === 'number' && typeof eq.value === 'number') return [eq.value];
    if (lt === 'boolean' && typeof eq.value === 'boolean') return [eq.value];
    return []; // out-of-domain scalar
  }
  const lenC = cons.find((c) => c.kind === 'length');
  const idxC = cons.filter((c) => c.kind === 'index-prop');
  const props = cons.filter((c) => c.kind === 'prop');
  if (lt === 'string' && lenC && typeof lenC.value === 'number' && !idxC.length && !props.length) {
    return (lenC.value >= 0 && lenC.value <= 256) ? ['x'.repeat(lenC.value)] : [];
  }
  if (/\[\]$/.test(String(type)) && (lenC || idxC.length)) {
    const elemType = String(type).replace(/\[\]$/, '');
    let len = lenC ? lenC.value : 1;
    for (const c of idxC) len = Math.max(len, (c.key.index || 0) + 1);
    if (!(len >= 0 && len <= 64)) return [];
    const ev = valuesFor(elemType) || [];
    const fills = (ev.length ? ev.slice(-3) : [null]); // a few distinct element fills (non-degenerate)
    const out = [];
    for (const e of fills) {
      const arr = []; for (let i = 0; i < len; i++) arr.push(cloneVal(e));
      let ok = true;
      for (const c of idxC) { const el = arr[c.key.index]; if (el && typeof el === 'object') el[c.key.prop] = c.value; else { ok = false; break; } }
      if (ok) out.push(arr);
    }
    return out;
  }
  const shape = objectShape(type);
  if (shape && props.length) {
    const sv = valuesFor(type) || [];
    const bases = sv.length ? sv.slice(0, 3) : [{}];
    const out = [];
    for (const b of bases) {
      const o = (b && typeof b === 'object') ? cloneVal(b) : {};
      let ok = true;
      for (const c of props) { if (!shape.some((f) => f.name === c.key)) { ok = false; break; } o[c.key] = c.value; }
      if (ok) out.push(o);
    }
    return out;
  }
  return [];
}
function runSeeded(adapter, ctx, cell, fn) {
  const params = adapter.inputs(cell);
  if (!params.length) return null;
  const lits = harvestLiterals(cell.unitBody || '', 30);
  if (!lits.length) return null;
  const byRoot = {};
  for (const c of lits) { if (params.some((p) => p.name === c.root)) (byRoot[c.root] = byRoot[c.root] || []).push(c); }
  const roots = Object.keys(byRoot);
  if (!roots.length) return null;
  const ensures = String(cell.spec.ensures || '').trim();
  let checker;
  try { checker = adapter.checker(ctx, params.map((p) => p.name), ensures); } catch (_) { return null; }
  const baseTuple = (cartesian(params.map((p) => valuesFor(p.type) || [undefined]), 1)[0] || params.map(() => undefined));
  let budget = 24; // cap total seeded runs per Cell (cost)
  for (const root of roots) {
    const pi = params.findIndex((p) => p.name === root);
    for (const seed of synthSeeds(params[pi].type, byRoot[root])) {
      if (budget-- <= 0) return null;
      const A = baseTuple.slice(); A[pi] = seed;
      let r; try { r = checker(fn, A); } catch (_) { continue; } // threw on this input → not a promise violation
      if (r && r.ok === false) {
        const argstr = params.map((p, i) => `${p.name}=${show(A[i])}`).join(', ');
        return { status: 'fail', level: 'red', viaSeed: true, cases: 0, counterexample: `${cell.unitName}(${argstr}) → ${show(r.out)} — violates ensures: ${ensures} (triggered by a constant found in the code)` };
      }
    }
  }
  return null;
}

// BRANCH-EXERCISE HONESTY (in-VM JS only). Instrument the unit's branches, run the SAME
// spec-derived inputs, and report which branches were exercised. Returns { total, exercised,
// missed:[{line,kind}] } or null (no branches, or Babel absent → no badge, never an error).
// Coverage is a HONESTY BADGE, not a verdict: it never turns a pass into a fail here — policy
// decides whether unexercised branches block the gate (see verify.js `coverage: full`).
function runCoverageForCell(cell, source, inputs, opts) {
  opts = opts || {};
  const file = opts.file || '';
  const startLine = (cell.unitBodyStart || 0) + 1;                       // 1-based
  const endLine = startLine + (cell.unitBody || '').split('\n').length;  // inclusive-ish
  const inst = instrumentBranches(source, startLine, endLine, {
    ts: /\.tsx?$/.test(file), tsx: /\.tsx$/.test(file), jsx: !!opts.jsx, file,
  });
  if (!inst || !inst.probes.length) return null; // straight-line code or Babel missing → no badge
  const cov = new Array(inst.probes.length).fill(0);
  const registry = {};
  const ctx = makeSandbox([cell.unitName], registry, { __ylcov: cov });
  const code = neutralizeModules(inst.code); // inst.code is already TS/JSX-lowered by the coverage pass
  const cap = '\n;try{__ylreg({' + JSON.stringify(cell.unitName) + ':(typeof ' + safeIdent(cell.unitName) + "!=='undefined'?" + safeIdent(cell.unitName) + ":undefined)});}catch(e){}";
  try { vm.runInContext(code + cap, ctx, { timeout: 2000 }); } catch (_) { return null; }
  const fn = registry[cell.unitName];
  if (typeof fn !== 'function') return null;
  for (const A of inputs) { try { fn.apply(null, A); } catch (_) { /* branch may throw; the hit still counted */ } }
  const exercised = cov.reduce((a, c) => a + (c > 0 ? 1 : 0), 0);
  const missed = inst.probes.map((p, i) => ({ line: p.line, kind: p.kind, hit: cov[i] > 0 })).filter((x) => !x.hit).map((x) => ({ line: x.line, kind: x.kind }));
  return { total: inst.probes.length, exercised, missed };
}

// The driver — dispatch each Cell to an adapter, load once per file, run cases, grade.
// opts.mutate (default true) also grades each passing Cell's ensures by mutation.
// opts.adapters overrides the registry (used by tests). Returns { [cellId]: result }.
function proveManifest(manifest, opts) {
  const mutate = !opts || opts.mutate !== false;
  const adapters = (opts && opts.adapters) || ADAPTERS;
  const out = {};
  const byFile = {};
  for (const id of Object.keys(manifest.cells)) {
    const c = manifest.cells[id];
    const isLeaf = !(c.contains && c.contains.length);
    if (!isLeaf || !c.unitFound || !(c.spec && c.spec.ensures)) continue;
    const adapter = adapters.find((a) => a.canHandle(c));
    if (!adapter) continue; // no adapter handles it → stays Yellow (signed, unproven)
    if (adapter.inVM && c.lang && !isJsLang(c.lang)) continue; // JS-VM adapters skip explicit non-JS langs (missing lang ⇒ JS default)
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(c.unitName || '')) { out[id] = { status: 'skip', level: 'info', reason: 'method/qualified units not yet supported' }; continue; }
    (byFile[c.file] = byFile[c.file] || []).push({ cell: c, adapter });
  }
  for (const file of Object.keys(byFile)) {
    const items = byFile[file];
    // Transform JSX when the file is .jsx/.tsx or any of its adapters wants it.
    const wantsJSX = /\.(jsx|tsx)$/i.test(file) || items.some((it) => it.adapter.wantsJSX);
    let source; try { source = fs.readFileSync(path.join(manifest.root, file), 'utf8'); }
    catch (_) { for (const it of items) out[it.cell.id] = { status: 'skip', level: 'info', reason: 'file unreadable' }; continue; }
    const base = items[0].adapter.load(source, items.map((it) => it.cell.unitName), { jsx: wantsJSX, file });
    if (base.error) {
      const reason = base.error === 'jsx-needs-babel'
        ? 'add the optional deps @babel/core + @babel/plugin-transform-react-jsx to machine-prove JSX Cells'
        : base.error === 'python-missing'
          ? 'install Python 3 (python3/python on PATH) to machine-prove Python Cells'
          : base.error === 'python-toplevel'
            ? 'not run: this file has top-level code that would execute on import — wrap it in a Cell (it is also flagged Pink)'
            : 'could not run file (' + base.error + ')';
      for (const it of items) out[it.cell.id] = { status: 'skip', level: 'info', reason }; continue;
    }
    for (const it of items) {
      const fn = base.fns[it.cell.unitName];
      if (typeof fn !== 'function') { out[it.cell.id] = { status: 'skip', level: 'info', reason: 'unit not callable in isolation' }; continue; }
      try {
        let res;
        if (it.adapter.prove) {
          res = it.adapter.prove(it.cell, base, fn); // adapter owns its execution (e.g. out-of-VM) + verdict
        } else {
          res = runCases(it.adapter, base.ctx, it.cell, fn);
          if (res.status === 'pass') {
            // Code-derived trigger hunt: a hit is a proven contradiction → Red (downgrades
            // the pass). Runs even without mutate — it's a security check, not a grade.
            const seeded = runSeeded(it.adapter, base.ctx, it.cell, fn);
            if (seeded) res = seeded;
            else {
              // Undeclared-input predicate provenance — static, cheap, and a security/honesty check,
              // so it runs regardless of `mutate` (like the seeded trigger hunt). JS/TS units only.
              try {
                const declared = parseIn(it.cell.spec).map((p) => p.name);
                const pred = analyzePredicates(source, it.cell, declared, { jsx: wantsJSX, file });
                if (pred) res.predicate = pred;
              } catch (_) { /* under-flag: never fail a proof over the static pass */ }
              if (mutate) {
                res.mutation = runMutation(it.adapter, source, it.cell, { jsx: wantsJSX, file });
                res.inertness = runInertness(it.adapter, source, it.cell, { jsx: wantsJSX, file });
                // Branch-exercise honesty (pure-call/JS): does the green cover every branch, or only some?
                if (it.adapter.name === 'pure-call') {
                  const params = it.adapter.inputs(it.cell);
                  const tuples = cartesian(params.map((p) => valuesFor(p.type)), 40);
                  res.coverage = runCoverageForCell(it.cell, source, tuples.length ? tuples : [[]], { jsx: wantsJSX, file });
                }
              }
            }
          }
        }
        out[it.cell.id] = res;
      } catch (e) { out[it.cell.id] = { status: 'skip', level: 'info', reason: 'prover error: ' + (e && e.message) }; }
    }
  }
  return out;
}

module.exports = { proveManifest, runSource, parseIn, parseInCased, valuesFor, buildChecker, buildEffectChecker, buildRenderChecker, transformJSX, show, ensuresHint, normalizeEnsures, ADAPTERS, pureCallAdapter, renderAdapter, pythonAdapter };
