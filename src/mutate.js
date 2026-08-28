'use strict';
// Generate small, systematic corruptions ("mutants") of a unit's source, to grade
// how strong its `ensures` is. Each mutant is a copy of the source with ONE edit.
// We locate edit sites via the AST (@babel/parser) but splice the source string
// directly, so no code-generator dependency is needed.

const babel = require('@babel/parser');
const PLUGINS = ['estree', 'typescript', 'jsx', 'decorators-legacy'];

// operator → what we flip it to (each flip is a distinct bug class)
const ARITH = { '+': '-', '-': '+', '*': '/', '/': '*', '%': '*' };
const CMP = { '<': '>=', '>': '<=', '<=': '>', '>=': '<' };
const EQ = { '==': '!=', '!=': '==', '===': '!==', '!==': '===' };
const LOGIC = { '&&': '||', '||': '&&' };

function parse(src) {
  try {
    return babel.parse(src, {
      sourceType: 'unambiguous', errorRecovery: true,
      allowReturnOutsideFunction: true, allowImportExportEverywhere: true, plugins: PLUGINS,
    }).program;
  } catch (_) { return null; }
}

function mutants(src, cap = 30) {
  const ast = parse(src);
  if (!ast) return [];
  const out = [];
  const seen = new Set();
  const add = (start, end, rep, op) => {
    if (start == null || end == null || start < 0 || end > src.length) return;
    const key = start + ':' + end + ':' + rep;
    if (seen.has(key)) return; seen.add(key);
    out.push({ code: src.slice(0, start) + rep + src.slice(end), op });
  };

  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    const v = node.value;

    if ((node.type === 'BinaryExpression' || node.type === 'LogicalExpression') && node.left && node.right) {
      const o = node.operator;
      const map = (o in ARITH) ? ARITH : (o in CMP) ? CMP : (o in EQ) ? EQ : (o in LOGIC) ? LOGIC : null;
      if (map && map[o] != null && node.left.end != null && node.right.start != null) {
        const gap = src.slice(node.left.end, node.right.start);
        const i = gap.indexOf(o);
        if (i >= 0) { const s = node.left.end + i; add(s, s + o.length, map[o], `${o} → ${map[o]}`); }
      }
    }
    // literals (estree: Literal; babel: Numeric/String/BooleanLiteral)
    if (node.type === 'Literal' || node.type === 'NumericLiteral' || node.type === 'StringLiteral' || node.type === 'BooleanLiteral') {
      if (typeof v === 'number') add(node.start, node.end, String(v + 1), `num ${v} → ${v + 1}`);
      else if (typeof v === 'string') add(node.start, node.end, JSON.stringify(v + 'X'), 'string +"X"');
      else if (typeof v === 'boolean') add(node.start, node.end, String(!v), `bool → ${!v}`);
    }
    // template literal static parts: /pfps/ → /pfps/X
    if (node.type === 'TemplateElement' && node.value && node.value.raw && node.start != null) {
      add(node.start, node.end, src.slice(node.start, node.end) + 'X', 'template +"X"');
    }
    if (node.type === 'ReturnStatement' && node.argument && node.argument.start != null) {
      add(node.argument.start, node.argument.end, 'null', 'return → null');
    }
    if (node.type === 'UnaryExpression' && node.operator === '!' && node.argument && node.argument.start != null) {
      add(node.start, node.argument.start, '', 'drop !');
    }

    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
      const c = node[k];
      if (Array.isArray(c)) c.forEach(walk);
      else if (c && typeof c.type === 'string') walk(c);
    }
  })(ast);

  return out.slice(0, cap);
}

// ── deletion candidates (for the INERTNESS check) ───────────────────────────
// The dual of mutation: instead of corrupting code and asking "does the ensures
// notice?", we DELETE a branch and ask "does anything notice?". A branch that can be
// removed with every spec-derived test still passing is semantically inert under the
// promise — dead weight, ahead-of-spec scaffolding, or a dormant payload. Each entry
// is one candidate: { code, desc, line, removed } where `removed` is the deleted
// source (used for the throws:-guard exemption).
function lineOf(src, idx) { let n = 1; for (let i = 0; i < idx && i < src.length; i++) if (src[i] === '\n') n++; return n; }
function deletions(src, cap = 20) {
  const ast = parse(src);
  if (!ast) return [];
  const out = [];
  const seen = new Set();
  const add = (start, end, rep, desc) => {
    if (start == null || end == null || start < 0 || end > src.length || start >= end) return;
    const key = start + ':' + end + ':' + rep;
    if (seen.has(key)) return; seen.add(key);
    out.push({ code: src.slice(0, start) + rep + src.slice(end), desc, line: lineOf(src, start), removed: src.slice(start, end) });
  };
  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'IfStatement' && node.start != null) {
      if (!node.alternate) {
        add(node.start, node.end, '', 'delete if-branch'); // guard / early-return / dormant gate
      } else {
        // keep else-body only (drop the test + consequent), and keep if-only (drop else)
        if (node.alternate.start != null) add(node.start, node.alternate.start, '', 'delete if-arm (keep else)');
        if (node.consequent && node.consequent.end != null) add(node.consequent.end, node.end, '', 'delete else-arm');
      }
    }
    if (node.type === 'ConditionalExpression' && node.test && node.consequent && node.alternate) {
      // t ? a : b → a   and   → b  (removes the condition's influence entirely)
      const a = src.slice(node.consequent.start, node.consequent.end);
      const b = src.slice(node.alternate.start, node.alternate.end);
      add(node.start, node.end, a, 'ternary → then-value');
      add(node.start, node.end, b, 'ternary → else-value');
    }
    // `cond && doThing()` / `cond || doThing()` as a bare statement — a gated action
    if (node.type === 'ExpressionStatement' && node.expression && node.expression.type === 'LogicalExpression') {
      add(node.start, node.end, '', 'delete gated statement');
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
      const c = node[k];
      if (Array.isArray(c)) c.forEach(walk);
      else if (c && typeof c.type === 'string') walk(c);
    }
  })(ast);
  return out.slice(0, cap);
}

// ── literal harvesting (for LITERAL-SEEDED TRIGGER HUNTING) ──────────────────
// A dormant gate compares an input against a magic constant it hopes the tests never
// produce (`if (s === 'xK9!')`, `if (items.length === 9 && items[0].price === 4.44)`).
// Harvest those constants so the prover can feed them back in and trigger the branch.
// Returns [{ root, kind, key, value }] — root = the base param identifier; kind =
// 'eq' (param === lit) | 'prop' (param.KEY === lit) | 'length' (param.length === N) |
// 'index-prop' (param[I].KEY === lit). Code-derived → a RED-ONLY hunt lane (never a pass).
function litValue(node) {
  if (!node) return { has: false };
  if (node.type === 'Literal' && (typeof node.value === 'string' || typeof node.value === 'number' || typeof node.value === 'boolean')) return { has: true, value: node.value };
  if (node.type === 'StringLiteral' || node.type === 'NumericLiteral' || node.type === 'BooleanLiteral') return { has: true, value: node.value };
  if (node.type === 'UnaryExpression' && node.operator === '-' && node.argument && (node.argument.type === 'NumericLiteral' || node.argument.type === 'Literal') && typeof node.argument.value === 'number') return { has: true, value: -node.argument.value };
  return { has: false };
}
function pathOf(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return { root: node.name, kind: 'eq', key: null };
  if (node.type === 'MemberExpression' && !node.computed && node.property && node.property.type === 'Identifier') {
    const base = node.object;
    if (base.type === 'Identifier') {
      return node.property.name === 'length'
        ? { root: base.name, kind: 'length', key: 'length' }
        : { root: base.name, kind: 'prop', key: node.property.name };
    }
    if (base.type === 'MemberExpression' && base.computed && base.object && base.object.type === 'Identifier'
      && base.property && (base.property.type === 'NumericLiteral' || base.property.type === 'Literal') && typeof base.property.value === 'number') {
      return { root: base.object.name, kind: 'index-prop', key: { index: base.property.value, prop: node.property.name } };
    }
  }
  return null;
}
function harvestLiterals(src, cap = 30) {
  const ast = parse(src);
  if (!ast) return [];
  const out = [];
  const seen = new Set();
  const add = (p, value) => {
    if (!p) return;
    const k = p.root + '|' + p.kind + '|' + JSON.stringify(p.key) + '|' + JSON.stringify(value);
    if (seen.has(k)) return; seen.add(k);
    out.push({ root: p.root, kind: p.kind, key: p.key, value });
  };
  (function walk(node) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'BinaryExpression' && /^(===|==|!==|!=)$/.test(node.operator)) {
      let p = pathOf(node.left), l = litValue(node.right);
      if (!p || !l.has) { p = pathOf(node.right); l = litValue(node.left); }
      if (p && l.has) add(p, l.value);
    }
    if (node.type === 'SwitchStatement' && node.discriminant) {
      const p = pathOf(node.discriminant);
      if (p) for (const c of node.cases || []) { const l = litValue(c.test); if (l.has) add(p, l.value); }
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue;
      const c = node[k];
      if (Array.isArray(c)) c.forEach(walk);
      else if (c && typeof c.type === 'string') walk(c);
    }
  })(ast);
  return out.slice(0, cap);
}

module.exports = { mutants, deletions, harvestLiterals };
