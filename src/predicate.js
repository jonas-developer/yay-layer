'use strict';
// UNDECLARED-INPUT PREDICATE PROVENANCE. A branch condition IS behaviour, and behaviour must trace to
// the signed spec. This flags a branch that keys off a FUNCTION PARAMETER the Cell's `in:` never
// declares — e.g. `if (mode === 'admin')` in a unit whose in: lists only `items`. That is the
// hidden-mode / undeclared-control-input shape the other checks structurally miss: the branch DOES
// something (so inertness stays quiet), IS exercised (so coverage is happy), and has no magic constant
// (so literal-seeding finds nothing) — yet it depends on an input the human never signed.
//
// It is the third prong of the pincer: inertness = branch does nothing; literal-seeding = magic-constant
// gate; THIS = branch keys off an undeclared input.
//
// Deliberately conservative (under-flag, never cry wolf):
//   • only SIMPLE identifier params count (destructuring / rest params are skipped — can't map cleanly);
//   • member-property names are NOT reads (`opts.mode` contributes `opts`, never `mode`);
//   • if @babel/parser is absent or the source won't parse, it returns null (no finding), never an error.
// Default severity is Yellow and always DECLARABLE — the fix is to add the input to `in:` (or a
// `throws:` / `ensures` case), which is the spec-strengthening loop working. Owner-signed policy
// (`predicate: declared`) can escalate it to gate-blocking for sensitive Cells.

let parser = null;
try { parser = require('@babel/parser'); } catch (_) { parser = null; }

function parseAst(source, opts) {
  if (!parser) return null;
  const plugins = [];
  if (opts.ts) plugins.push('typescript');
  if (opts.jsx) plugins.push('jsx');
  for (const mode of ['module', 'script']) {
    try { return parser.parse(source, { sourceType: mode, errorRecovery: true, plugins }); } catch (_) { /* try next */ }
  }
  return null;
}

// Collect identifier "reads" in an expression subtree, skipping non-computed member property names and
// object-literal keys — so `opts.mode` contributes `opts` (the input), not `mode` (a field name).
function readIdents(node, out) {
  if (!node || typeof node.type !== 'string') return;
  switch (node.type) {
    case 'Identifier': out.add(node.name); return;
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      readIdents(node.object, out);
      if (node.computed) readIdents(node.property, out); // a[b] reads b; a.b does not
      return;
    case 'ObjectProperty':
    case 'ObjectMethod':
    case 'Property':
      if (node.computed) readIdents(node.key, out);
      if (node.value) readIdents(node.value, out);
      return;
    default: break;
  }
  for (const k in node) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'range' || k === 'comments' || k === 'leadingComments' || k === 'trailingComments') continue;
    const v = node[k];
    if (Array.isArray(v)) { for (const c of v) readIdents(c, out); }
    else if (v && typeof v.type === 'string') readIdents(v, out);
  }
}

// Find the unit's function node by name: `function name(){}`, `const name = (…) =>{}`, `const name = function(){}`.
function findFn(ast, name) {
  let found = null;
  (function visit(node) {
    if (!node || found || typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration' && node.id && node.id.name === name) { found = node; return; }
    if (node.type === 'VariableDeclarator' && node.id && node.id.name === name && node.init &&
        (node.init.type === 'ArrowFunctionExpression' || node.init.type === 'FunctionExpression')) { found = node.init; return; }
    for (const k in node) {
      if (found) return;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) { if (c && typeof c.type === 'string') visit(c); } }
      else if (v && typeof v.type === 'string') visit(v);
    }
  })(ast.program || ast);
  return found;
}

// Simple identifier params (incl. default params `mode = 'user'`). Destructuring / rest are skipped.
function simpleParams(fn) {
  const names = [];
  for (const p of (fn.params || [])) {
    if (p.type === 'Identifier') names.push(p.name);
    else if (p.type === 'AssignmentPattern' && p.left && p.left.type === 'Identifier') names.push(p.left.name);
  }
  return names;
}

const TEST_OF = { IfStatement: 'test', ConditionalExpression: 'test', WhileStatement: 'test', DoWhileStatement: 'test', SwitchStatement: 'discriminant' };

function collectFindings(fn, undeclared, source) {
  const undeclaredSet = new Set(undeclared);
  const findings = [];
  const seen = new Set();
  (function visit(node) {
    if (!node || typeof node.type !== 'string') return;
    const key = TEST_OF[node.type];
    const test = key && node[key];
    if (test) {
      const reads = new Set();
      readIdents(test, reads);
      for (const nm of reads) {
        if (!undeclaredSet.has(nm)) continue;
        const line = (test.loc && test.loc.start.line) || (node.loc && node.loc.start.line) || 0;
        const dk = nm + '@' + line;
        if (seen.has(dk)) continue;
        seen.add(dk);
        let snippet = '';
        try { snippet = source.slice(test.start, test.end).replace(/\s+/g, ' ').trim(); if (snippet.length > 80) snippet = snippet.slice(0, 77) + '…'; } catch (_) {}
        findings.push({ line, name: nm, snippet });
      }
    }
    for (const k in node) {
      if (k === 'loc') continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) { if (c && typeof c.type === 'string') visit(c); } }
      else if (v && typeof v.type === 'string') visit(v);
    }
  })(fn.body || fn);
  return findings;
}

// Analyze one Cell's unit. `declaredNames` = the names in the spec's `in:` (passed in to avoid a
// circular require on prove.js). Returns { findings:[{line,name,snippet}], undeclared:[names] } or null.
function analyzePredicates(source, cell, declaredNames, opts) {
  opts = opts || {};
  if (!parser || !cell || !cell.unitName) return null;
  const file = opts.file || cell.file || '';
  const ast = parseAst(source, { ts: /\.tsx?$/.test(file), jsx: !!opts.jsx || /\.(jsx|tsx)$/.test(file) });
  if (!ast) return null;
  const fn = findFn(ast, cell.unitName);
  if (!fn) return null;
  const params = simpleParams(fn);
  if (!params.length) return null;
  const declared = new Set(declaredNames || []);
  const undeclared = params.filter((p) => !declared.has(p));
  if (!undeclared.length) return null;
  const findings = collectFindings(fn, undeclared, source);
  if (!findings.length) return null;
  return { findings, undeclared };
}

module.exports = { analyzePredicates };
