'use strict';
// P4: the reverification POSTURE (grandfathering). Proves the project-level gate control:
//   • posture defaults to off (history grandfathered); off ⇒ the gate never consults reverification;
//   • `yay reverify posture <mode>` persists off/guarded/strict to committed config;
//   • strict does NOT block when preserved history is already at the current capability (verify → PASS);
//   • under a NEWER capability, the gate reports the old states as pending (guarded warns / strict blocks);
//   • a signed reverification at the new capability SATISFIES the gate (pending clears).
//
// We can't bump the live verifier capability inside a test, so the newer-capability cases drive
// reverifyGate() with a `capability` override and inject a matching reverification via the primitives
// (the same signAttestation/appendAttestation the CLI uses).

const assert = require('assert');
const A = require('../src/attest');
const RV = require('../src/reverify');
const CAP = require('../src/capability');
const POL = require('../src/policy');
const { scenario } = require('./fixtures/scenario');

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); console.log('  ✓ ' + msg); };

const s = scenario({ name: 'cart', archiveKey: 'p4-archive-key' });
try {
  s.gitInit();
  s.cell('C-1', { unit: 'add', intent: 'add two numbers', in: 'a: number, b: number', out: 'number', ensures: 'out === a + b', pure: true, file: 'cart.js', body: 'function add(a, b){ return a + b; }' });
  s.init({ durable: true });
  s.sign('C-1', { brief: 'Adder.' });
  s.attest({ force: true });   // original attestation at the current capability, before archive
  s.archive().commit('s1');

  const p = s.paths();
  let config = s.config();
  const key = s.archiveKeyResolved();
  const snaps = s.snapshots();
  ok(snaps.length >= 1 && snaps[0].attest, 'archived snapshot links to its original attestation');
  const snap0 = snaps[0];
  const baseCap = A.loadAttestation(p, config, snap0.attest).capability;

  // ── posture default: off ⇒ grandfathered, gate not subject ──
  ok(RV.reverifyPosture(config) === 'off', 'posture defaults to off');
  ok(RV.reverifyGate(p, config).subject === false, 'off ⇒ the gate does not consult reverification (history grandfathered)');

  // ── posture CLI: set / show / persist ──
  s.yay(['reverify', 'posture', 'strict']);
  config = s.config();
  ok(config.reverification === 'strict', '`yay reverify posture strict` persists to committed config');
  ok(/strict/.test(s.yay(['reverify', 'posture'])), '`yay reverify posture` (no arg) shows the current posture');

  // ── strict, but history already at the current capability ⇒ NOT blocked ──
  const gNow = RV.reverifyGate(p, config, { posture: 'strict' });
  ok(gNow.subject && gNow.satisfied && gNow.pending.length === 0, 'strict is satisfied when history is at the current capability (nothing to re-verify)');
  const v = s.yay(['verify']);
  ok(/GATE: PASS/.test(v), 'yay verify passes under strict when nothing predates the current capability');
  ok(/reverification posture \(strict\)/.test(v), 'verify surfaces the satisfied posture line');

  // ── under a NEWER capability, the old state is pending ──
  const NEW = '9.9.9';
  const gStrict = RV.reverifyGate(p, config, { posture: 'strict', capability: NEW });
  ok(gStrict.subject && !gStrict.satisfied && gStrict.pending.length === 1, 'a newer capability makes the old state pending under strict');
  ok(gStrict.pending[0].fromCapability === baseCap, 'the pending state reports its original capability');
  const gGuard = RV.reverifyGate(p, config, { posture: 'guarded', capability: NEW });
  ok(gGuard.posture === 'guarded' && !gGuard.satisfied, 'guarded sees the same pending state (it warns rather than blocks)');

  // ── a signed reverification at the new capability SATISFIES the gate ──
  const id = A.verifierIdentity(p, config);
  const rv = RV.reverifyState(p, snap0, key, config, {});
  const robj = RV.reverificationObj(rv.verObj, { attest: snap0.attest, at: snap0.at }, { capability: baseCap });
  robj.capability = NEW;                       // simulate the record a bumped verifier would produce
  const att = A.signAttestation(robj, id);
  A.appendAttestation(p, config, att);
  const gCovered = RV.reverifyGate(p, config, { posture: 'strict', capability: NEW });
  ok(gCovered.satisfied && gCovered.pending.length === 0, 'a reverification at the new capability clears the pending state (strict now satisfied)');

  // ── P4b: per-Cell scoping ──
  ok(CAP.CAPABILITY === '1.2.0' && !CAP.assertCapability().drift, 'capability bumped to 1.2.0 with the reverify-latest policy kind (no drift)');
  ok(CAP.describeCapability().policyKinds.includes('reverify-latest'), 'reverify-latest is a registered policy kind');
  const scopePolicy = { rules: [{ match: { tag: 'sensitive' }, reverify: 'latest' }] };
  ok(POL.hasReverifyScope(scopePolicy) && !POL.hasReverifyScope({ rules: [] }), 'hasReverifyScope detects a reverify:latest rule');
  ok(POL.reverifyRequired(scopePolicy, { file: 'x.js', spec: { tag: 'sensitive' } }) === true
    && POL.reverifyRequired(scopePolicy, { file: 'x.js', spec: {} }) === false, 'reverifyRequired matches only in-scope Cells');
  // Scoped gate under the newer capability: the old state (evidence = {C-1}) is subject only if C-1 is in scope.
  const gInScope = RV.reverifyGate(p, config, { posture: 'strict', capability: '9.9.8', scoped: true, scopedIds: new Set(['C-1']) });
  ok(gInScope.scoped && !gInScope.satisfied && gInScope.pending.length === 1, 'scoped strict: a state containing an in-scope Cell is pending');
  const gOutScope = RV.reverifyGate(p, config, { posture: 'strict', capability: '9.9.8', scoped: true, scopedIds: new Set(['C-2']) });
  ok(gOutScope.scoped && gOutScope.satisfied && gOutScope.pending.length === 0, 'scoped strict: a state with no in-scope Cell is grandfathered (not pending)');

  console.log('\nReverify P4 (grandfathering posture + scoping): all ' + n + ' checks passed.');
} finally {
  s.cleanup();
}
