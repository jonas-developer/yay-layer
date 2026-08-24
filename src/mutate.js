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

module.exports = { mutants };
