'use strict';
// AST-based JS analyzer (acorn). Enumerates every NAMED executable unit —
// function declaration, function expression assigned to a name, arrow-prop,
// object method, class method/getter/setter — at ANY nesting depth. This is
// what lets YayLayer see units inside IIFEs, objects and classes (the old regex
// only saw top-level `function name(`).
//
// A "unit" is a named block that does a job. Anonymous inline callbacks
// (arr.map(x => …), event handlers) are considered part of their enclosing unit,
// not separate units. Also flags top-level imperative code that runs at load.

const acorn = require('acorn');

const PARSE_OPTS = {
  ecmaVersion: 'latest', locations: true, allowHashBang: true,
  allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true,
  allowImportExportEverywhere: true,
};

function parse(code) {
  try { return acorn.parse(code, { ...PARSE_OPTS, sourceType: 'script' }); }
  catch (_) {
    try { return acorn.parse(code, { ...PARSE_OPTS, sourceType: 'module' }); }
    catch (_2) { return null; } // e.g. TS syntax — caller falls back
  }
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
function analyze(code) {
  const ast = parse(code);
  if (!ast) return { ok: false, units: [], loose: [] };
  const units = [];
  const seen = new Set();
  walk(ast, [], (node, ancestors) => {
    if (!FN_TYPES.has(node.type)) return;
    const named = nameFn(node, ancestors);
    if (!named) return;
    const key = named.name + '@' + node.loc.start.line;
    if (seen.has(key)) return;
    seen.add(key);
    units.push({ name: named.name, kind: named.kind, startLine: node.loc.start.line, endLine: node.loc.end.line });
  });
  units.sort((a, b) => a.startLine - b.startLine);
  return { ok: true, units, loose: looseTopLevel(ast) };
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
