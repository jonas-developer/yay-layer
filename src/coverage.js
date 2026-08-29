'use strict';
// BRANCH-EXERCISE HONESTY. During proving we count which branches the spec-derived inputs actually
// EXECUTED. A Cell can pass its `ensures` yet leave branches unexercised — and a dormant payload is,
// by definition, an unexercised branch. So instead of hiding that inside an unqualified green, we
// show the coverage boundary ("proven — 5/7 branches exercised") and feed the missed branches to
// inertness + policy. HONESTY INVARIANT preserved: coverage is a BADGE, never a Green→X downgrade by
// itself (a legitimate `throws:` guard is often unexercised on purpose); only an owner-signed policy
// (`coverage: full`) makes missing exercise gate-blocking for sensitive Cells.
//
// Instrumentation is a Babel pass: probe each branch with `__ylcov[i]++`, keyed to the ORIGINAL
// source line. Babel is an OPTIONAL dep (same as the JSX prover) — absent ⇒ we return null and there
// is simply no badge, never an error.

// Instrument the branches of `source` whose position falls within [startLine,endLine] (1-based, the
// unit's body) so each records a hit in a global `__ylcov` array. TS/JSX are lowered in the same pass
// (so the output runs), while probe line numbers stay in ORIGINAL-source coordinates. Returns
// { code, probes:[{line,kind}] } or null (Babel missing / parse fail — graceful, no badge).
function instrument(source, startLine, endLine, opts) {
  opts = opts || {};
  let babel, t;
  try { babel = require('@babel/core'); t = require('@babel/types'); }
  catch (_) { return null; }

  const probes = [];
  const inRange = (node) => !!node.loc && node.loc.start.line >= startLine && node.loc.start.line <= endLine;
  const lineOf = (node, fallback) => ((node && node.loc) ? node.loc.start.line : fallback);
  const member = (idx) => t.memberExpression(t.identifier('__ylcov'), t.numericLiteral(idx), true);
  const stmtProbe = (idx) => t.expressionStatement(t.updateExpression('++', member(idx)));
  const exprProbe = (idx, expr) => t.sequenceExpression([t.updateExpression('++', member(idx)), expr]);
  const asBlock = (node) => t.isBlockStatement(node) ? node : t.blockStatement([t.isStatement(node) ? node : t.expressionStatement(node)]);
  // add a probe as the first statement of a (possibly newly-wrapped) block; returns the block.
  const probedBlock = (node, kind) => { const idx = probes.length; probes.push({ line: lineOf(node), kind }); const b = asBlock(node); b.body.unshift(stmtProbe(idx)); return b; };
  const probedExpr = (node, kind) => { const idx = probes.length; probes.push({ line: lineOf(node), kind }); return exprProbe(idx, node); };

  const plugin = () => ({ visitor: {
    IfStatement(pth) {
      const n = pth.node; if (!inRange(n)) return;
      n.consequent = probedBlock(n.consequent, 'if');
      if (n.alternate) n.alternate = probedBlock(n.alternate, 'else');
    },
    ConditionalExpression(pth) {
      const n = pth.node; if (!inRange(n)) return;
      n.consequent = probedExpr(n.consequent, 'ternary');
      n.alternate = probedExpr(n.alternate, 'ternary');
    },
    LogicalExpression(pth) {
      const n = pth.node; if (!inRange(n)) return;
      n.right = probedExpr(n.right, 'logical'); // RHS only runs when the operator short-circuits into it
    },
    SwitchCase(pth) {
      const n = pth.node; if (!inRange(n) || !n.consequent.length) return;
      const idx = probes.length; probes.push({ line: lineOf(n), kind: 'case' });
      n.consequent.unshift(stmtProbe(idx));
    },
    CatchClause(pth) {
      const n = pth.node; if (!inRange(n)) return;
      const idx = probes.length; probes.push({ line: lineOf(n), kind: 'catch' });
      n.body.body.unshift(stmtProbe(idx));
    },
    'ForStatement|WhileStatement|DoWhileStatement|ForInStatement|ForOfStatement'(pth) {
      const n = pth.node; if (!inRange(n)) return;
      n.body = probedBlock(n.body, 'loop');
    },
  } });

  // Coverage plugin FIRST (capture branches at original positions), then TS/JSX lowering.
  const plugins = [plugin];
  if (opts.ts) { try { let p = require('@babel/plugin-transform-typescript'); plugins.push([p.default || p, { isTSX: !!opts.tsx, allowDeclareFields: true }]); } catch (_) { return null; } }
  if (opts.jsx) { try { let p = require('@babel/plugin-transform-react-jsx'); plugins.push([p.default || p, { runtime: 'classic', pragma: '__h', pragmaFrag: '__Fragment' }]); } catch (_) { return null; } }
  try {
    const out = babel.transformSync(source, { filename: opts.file || 'cell.js', babelrc: false, configFile: false, compact: false, plugins });
    if (!out || out.code == null) return null;
    return { code: out.code, probes };
  } catch (_) { return null; }
}

module.exports = { instrument };
