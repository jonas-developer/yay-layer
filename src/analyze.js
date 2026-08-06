'use strict';
// AST-based analyzer for JS / TypeScript / JSX / TSX (@babel/parser with the
// `estree` plugin). Enumerates every NAMED executable unit —
// function declaration, function expression assigned to a name, arrow-prop,
// object method, class method/getter/setter — at ANY nesting depth. This is
// what lets YayLayer see units inside IIFEs, objects and classes (the old regex
// only saw top-level `function name(`).
//
// A "unit" is a named block that does a job. Anonymous inline callbacks
// (arr.map(x => …), event handlers) are considered part of their enclosing unit,
// not separate units. Also flags top-level imperative code that runs at load.

const babel = require('@babel/parser');

// One parser for JS, TypeScript, JSX and TSX. The `estree` plugin makes the AST
// ESTree-shaped (Literal / Property / MethodDefinition) so the walker below is
// standard. errorRecovery keeps a partial tree on odd syntax instead of failing.
const PLUGINS = ['estree', 'typescript', 'jsx', 'decorators-legacy'];
function parse(code) {
  try {
    return babel.parse(code, {
      sourceType: 'unambiguous', errorRecovery: true,
      allowReturnOutsideFunction: true, allowImportExportEverywhere: true,
      plugins: PLUGINS,
    }).program;
  } catch (_) { return null; }
}

function keyName(key) {
  if (!key) return null;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal') return String(key.value);
  if (key.type === 'PrivateIdentifier') return '#' + key.name;
  return null;
}
function memberName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression') {
    const obj = memberName(node.object);
    const prop = node.computed ? null : keyName(node.property);
    return prop ? (obj ? obj + '.' + prop : prop) : obj;
  }
  return null;
}
function className(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type === 'ClassDeclaration' || a.type === 'ClassExpression') return a.id ? a.id.name : 'class';
  }
  return null;
}

// Derive a name + kind for a function node from its surrounding context.
function nameFn(node, ancestors) {
  const parent = ancestors[ancestors.length - 1];
  if (node.type === 'FunctionDeclaration' && node.id) return { name: node.id.name, kind: 'function' };
  if (!parent) return null;
  const arrowKind = node.type === 'ArrowFunctionExpression' ? 'arrow' : 'function';
  switch (parent.type) {
    case 'VariableDeclarator':
      return parent.id && parent.id.name ? { name: parent.id.name, kind: arrowKind } : null;
    case 'AssignmentExpression': {
      const n = memberName(parent.left);
      return n ? { name: n, kind: arrowKind } : null;
    }
    case 'Property': {
      const n = keyName(parent.key);
      return n ? { name: n, kind: node.type === 'ArrowFunctionExpression' ? 'arrow' : 'method' } : null;
    }
    case 'MethodDefinition': {
      const n = keyName(parent.key);
      if (!n) return null;
      const cls = className(ancestors);
      const k = parent.kind && parent.kind !== 'method' ? parent.kind : 'method';
      return { name: (cls ? cls + '.' : '') + n, kind: k };
    }
    case 'PropertyDefinition': { // class field: foo = () => {}
      const n = keyName(parent.key);
      if (!n) return null;
      const cls = className(ancestors);
      return { name: (cls ? cls + '.' : '') + n, kind: 'arrow' };
    }
    default:
      return null; // anonymous — belongs to the enclosing unit
  }
}

function walk(node, ancestors, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ancestors);
  const next = ancestors.concat(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'range') continue;
    const child = node[key];
    if (Array.isArray(child)) { for (const c of child) walk(c, next, visit); }
    else walk(child, next, visit);
  }
}

// The nearest lexical class / object-literal a unit lives in (for real nesting).
function containerOf(ancestors) {
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const a = ancestors[i];
    if (a.type === 'ClassDeclaration' || a.type === 'ClassExpression') return a.id ? a.id.name : 'class';
    if (a.type === 'VariableDeclarator' && a.id && a.id.type === 'Identifier' && a.init && a.init.type === 'ObjectExpression') return a.id.name;
  }
  return null;
}

function objectPublicNames(objExpr, out) {
  if (!objExpr || objExpr.type !== 'ObjectExpression') return;
  for (const p of objExpr.properties || []) {
    if (p.type !== 'Property') continue;
    if (p.value && p.value.type === 'Identifier') out.add(p.value.name); // { getDB: getDB }
    const k = keyName(p.key); if (k) out.add(k);                          // { getDB() {} } / { getDB }
  }
}

// The namespace this module exposes (global.X / window.X / module.exports / return)
// and the set of unit names that are part of its PUBLIC api.
function namespaceOf(ast) {
  const objByVar = {};
  walk(ast, [], (node) => {
    if (node.type === 'VariableDeclarator' && node.id && node.id.type === 'Identifier' && node.init && node.init.type === 'ObjectExpression') objByVar[node.id.name] = node.init;
  });
  let name = null; const publicNames = new Set();
  const consider = (exposeName, val) => {
    let obj = null;
    if (val && val.type === 'ObjectExpression') obj = val;
    else if (val && val.type === 'Identifier' && objByVar[val.name]) obj = objByVar[val.name];
    if (!obj) return;
    if (exposeName && !name) name = exposeName;
    objectPublicNames(obj, publicNames);
  };
  walk(ast, [], (node) => {
    if (node.type === 'AssignmentExpression' && node.left && node.left.type === 'MemberExpression' && !node.left.computed) {
      const o = node.left.object; const prop = keyName(node.left.property);
      if (o.type === 'Identifier' && (o.name === 'global' || o.name === 'window' || o.name === 'globalThis') && prop) consider(prop, node.right);
      else if (o.type === 'Identifier' && o.name === 'module' && prop === 'exports') consider(null, node.right);
    } else if (node.type === 'ReturnStatement' && node.argument) {
      consider(null, node.argument);
    } else if (node.type === 'ExportNamedDeclaration') { // ES modules
      const d = node.declaration;
      if (d && d.id && d.id.name) publicNames.add(d.id.name);
      if (d && d.declarations) for (const v of d.declarations) if (v.id && v.id.name) publicNames.add(v.id.name);
      for (const s of node.specifiers || []) if (s.local && s.local.name) publicNames.add(s.local.name);
    } else if (node.type === 'ExportDefaultDeclaration') {
      if (node.declaration && node.declaration.id && node.declaration.id.name) publicNames.add(node.declaration.id.name);
    }
  });
  return { name, publicNames };
}

const FN_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

function isIIFE(node) {
  if (node.type !== 'ExpressionStatement') return false;
  let e = node.expression;
  while (e && (e.type === 'UnaryExpression' || e.type === 'AwaitExpression')) e = e.argument;
  return !!(e && e.type === 'CallExpression' && e.callee && FN_TYPES.has(e.callee.type));
}
function isDirective(node) {
  return node.type === 'ExpressionStatement' && node.expression &&
    node.expression.type === 'Literal' && typeof node.expression.value === 'string';
}
function looseTopLevel(ast) {
  const SKIP = new Set(['FunctionDeclaration', 'ClassDeclaration', 'VariableDeclaration',
    'ImportDeclaration', 'ExportNamedDeclaration', 'ExportDefaultDeclaration', 'ExportAllDeclaration', 'EmptyStatement']);
  const out = [];
  for (const node of ast.body) {
    if (SKIP.has(node.type) || isDirective(node) || isIIFE(node)) continue;
    // Top-level assignments (module.exports = …, X = Y) are wiring, not an action.
    if (node.type === 'ExpressionStatement' && node.expression && node.expression.type === 'AssignmentExpression') continue;
    out.push(node.loc.start.line);
  }
  return out;
}

// Returns { ok, units:[{name,kind,startLine,endLine}], loose:[line,…] }.
// ok:false means the file could not be parsed (e.g. TypeScript) — caller degrades.
function calleeName(callee) {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed) return keyName(callee.property);
  return null;
}

function analyze(code) {
  const ast = parse(code);
  if (!ast) return { ok: false, units: [], loose: [], calls: [], namespace: { name: null, publicNames: new Set() } };
  const units = [];
  const seen = new Set();
  const calls = new Set(); // short callee names used anywhere in the file → for the call graph
  walk(ast, [], (node, ancestors) => {
    if (node.type === 'CallExpression') {
      const cn = calleeName(node.callee);
      if (cn) calls.add(cn);
      return;
    }
    if (!FN_TYPES.has(node.type)) return;
    const named = nameFn(node, ancestors);
    if (!named) return;
    const key = named.name + '@' + node.loc.start.line;
    if (seen.has(key)) return;
    seen.add(key);
    units.push({ name: named.name, kind: named.kind, startLine: node.loc.start.line, endLine: node.loc.end.line, container: containerOf(ancestors) });
  });
  units.sort((a, b) => a.startLine - b.startLine);
  return { ok: true, units, loose: looseTopLevel(ast), calls: [...calls], namespace: namespaceOf(ast) };
}

// The unit a Cell governs = the nearest unit starting just after the marker.
function nearestUnitAfter(units, afterLine, gap = 6) {
  for (const u of units) { // units are sorted ascending by startLine
    if (u.startLine > afterLine && u.startLine - afterLine <= gap) return u;
    if (u.startLine > afterLine + gap) break;
  }
  return null;
}

module.exports = { analyze, nearestUnitAfter };
