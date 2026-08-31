'use strict';
// P1: reverifyState re-runs TODAY's verifier against a reconstructed HISTORICAL snapshot. Proves the
// engine actually replays old code through the current checks — including undeclared-input predicate
// provenance — and distinguishes states: a clean archived state comes back GREEN; a state whose Cell
// branches on an input its `in:` never declared comes back YELLOW with the predicate flag, even though
// it was archived as an approved state. This is "replay the tape through today's better reader" working
// on one state; the sweep (P2) fans this across all snapshots and diffs against the original attestation.
//
// The Durable history is stood up via the shared scenario factory (test/fixtures/scenario.js) — the
// same builder the demo and confirmation report use — so this test exercises the real fixture path.

const assert = require('assert');
const { scenario } = require('./fixtures/scenario');
const { reverifyState } = require('../src/reverify');

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); console.log('  ✓ ' + msg); };

// The shared spec for both states; only the body changes between them.
const SPEC = { unit: 'applyDiscount', intent: 'apply a percentage discount to a price',
  in: 'price: number, pct: number', out: 'number', ensures: 'out === price * (1 - pct)', pure: true, file: 'cart.js' };
// State 1: a clean, machine-provable pure Cell (will be GREEN).
const CLEAN = 'function applyDiscount(price, pct){ return price * (1 - pct); }';
// State 2: SAME promise, but the code now branches on `mode` — an input `in:` never declares. Both
// branches return the same value, so the ensures still holds (prover passes) — yet today's
// predicate-provenance check flags the undeclared control input → YELLOW.
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
  const snaps = s.snapshots();
  ok(snaps.length >= 2, 'two archived snapshots (got ' + snaps.length + ')');
  const key = s.archiveKeyResolved();

  // Reverify the CLEAN historical state under today's verifier.
  const r1 = reverifyState(p, snaps[0], key, config, {});
  ok(!r1.error, 'reverify of state 1 ran without error' + (r1.error ? ' — ' + r1.error : ''));
  ok(r1.cells['C-1'] && r1.cells['C-1'].state === 'GREEN', 'state 1 (clean) → GREEN under today\'s verifier');
  ok(r1.cells['C-1'] && r1.cells['C-1'].predicate === false, 'state 1 has no undeclared-input predicate flag');
  ok(r1.capability && r1.fingerprint, 'reverdict records the current capability + fingerprint');

  // Reverify the BAIT historical state — today's predicate check should flag it.
  const r2 = reverifyState(p, snaps[1], key, config, {});
  ok(!r2.error, 'reverify of state 2 ran without error' + (r2.error ? ' — ' + r2.error : ''));
  ok(r2.cells['C-1'] && r2.cells['C-1'].state === 'YELLOW', 'state 2 (undeclared `mode` branch) → YELLOW under today\'s verifier');
  ok(r2.cells['C-1'] && r2.cells['C-1'].predicate === true, 'state 2 carries the ◈ undeclared-input predicate finding');

  console.log('\nReverify P1: all ' + n + ' checks passed.');
} finally {
  s.cleanup();
}
