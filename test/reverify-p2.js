'use strict';
// P2: the sweep. Replay every preserved snapshot through today's verifier and diff each Cell against its
// ORIGINAL verdict, producing an "upgrade report." This test builds a real Durable history (a clean
// state + a state whose Cell branches on an undeclared `mode`), then sweeps with a baseline standing in
// for "an older verifier (1.0.0, before the predicate check) said GREEN here" — an honest simulation,
// since 1.0.0 genuinely couldn't detect the undeclared input. The sweep must report exactly one
// regression (the bait Cell: GREEN@1.0.0 → YELLOW@today) and leave the clean state unchanged. Nothing
// in the recorded history is mutated — deltas are computed, never written over.
//
// The history is stood up via the shared scenario factory (test/fixtures/scenario.js).

const assert = require('assert');
const { scenario } = require('./fixtures/scenario');
const { reverifySweep } = require('../src/reverify');

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); console.log('  ✓ ' + msg); };

const SPEC = { unit: 'applyDiscount', intent: 'apply a percentage discount to a price',
  in: 'price: number, pct: number', out: 'number', ensures: 'out === price * (1 - pct)', pure: true, file: 'cart.js' };
const CLEAN = 'function applyDiscount(price, pct){ return price * (1 - pct); }';
const BAIT = 'function applyDiscount(price, pct, mode){ if (mode === "wholesale") return price * (1 - pct); return price * (1 - pct); }';

const s = scenario({ name: 'cart', archiveKey: 'archive-key-secret-123' });
try {
  s.gitInit();
  s.cell('C-1', { ...SPEC, body: CLEAN });
  s.init({ durable: true });
  s.sign('C-1', { brief: 'Discount helper.' }).archive().commit('s1');

  s.cell('C-1', { ...SPEC, body: BAIT });
  s.sign('C-1', { brief: 'Wholesale branch (undeclared mode).' }).archive().commit('s2');

  const p = s.paths();
  const config = s.config();
  const key = s.archiveKeyResolved();

  // Baseline stand-in: "verifier 1.0.0 (no predicate check) recorded C-1 as GREEN here." Honest —
  // 1.0.0's descriptor genuinely lacked predicate-provenance, so this Cell truly was Green then.
  const baselineOf = () => ({ capability: '1.0.0', evidence: { 'C-1': { state: 'GREEN', proven: true } } });

  const report = reverifySweep(p, key, config, { baselineOf });

  ok(report.checked === 2, 'sweep re-verified both snapshots (checked=' + report.checked + ')');
  ok(report.errors === 0, 'no reconstruction/verify errors');
  ok(report.capability && report.fingerprint, 'report records the current capability + fingerprint');
  ok(report.regressed === 1, 'exactly one regression detected (regressed=' + report.regressed + ')');
  ok(report.unchanged === 1, 'the clean state is unchanged under the new verifier (unchanged=' + report.unchanged + ')');

  const reg = report.regressions[0];
  ok(reg && reg.cell === 'C-1', 'the regression is C-1');
  ok(reg && reg.from === 'GREEN' && reg.to === 'YELLOW', 'C-1: GREEN → YELLOW');
  ok(reg && reg.fromCapability === '1.0.0' && reg.toCapability === report.capability, 'diff spans 1.0.0 → ' + report.capability);
  ok(reg && reg.predicate === true, 'the regression is attributed to the ◈ undeclared-input predicate check');

  console.log('\nReverify P2 (sweep + diff): all ' + n + ' checks passed.');
} finally {
  s.cleanup();
}
