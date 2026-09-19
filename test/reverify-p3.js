'use strict';
// P3: the CLI surface + the signed reverification RECORD MODEL.
//   • `yay reverify --all` renders the keyless upgrade report (works with the verifier key removed);
//   • the record model: reverifyState → reverificationObj → sign → append yields a kind:"reverification"
//     record that references the ORIGINAL attestation, validates under the verifier key, and chains;
//   • `yay reverify --all --attest` runs cleanly (mints only for changed states; needs the verifier key).
// Regression *content* (GREEN→YELLOW under a newer capability) is covered by reverify-p2.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const A = require('../src/attest');
const RV = require('../src/reverify');
const { scenario } = require('./fixtures/scenario');

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); console.log('  ✓ ' + msg); };

const s = scenario({ name: 'cart', archiveKey: 'p3-archive-key' });
try {
  s.gitInit();
  s.cell('C-1', { unit: 'add', intent: 'add two numbers', in: 'a: number, b: number', out: 'number', ensures: 'out === a + b', pure: true, file: 'cart.js', body: 'function add(a, b){ return a + b; }' });
  s.init({ durable: true });
  s.sign('C-1', { brief: 'Adder.' });
  s.attest({ force: true });     // original attestation, before archive, so the snapshot has a baseline
  s.archive().commit('s1');

  const p = s.paths();
  const config = s.config();
  const snaps = s.snapshots();
  ok(snaps.length >= 1 && snaps[0].attest, 'archived snapshot links to its original attestation');
  const snap0 = snaps[0];
  const key = s.archiveKeyResolved();

  // ── 1) keyless upgrade report ──
  const rpt = s.yay(['reverify', '--all']);
  ok(/Verifier upgrade report/.test(rpt), 'yay reverify --all renders the upgrade report');
  ok(/unchanged/.test(rpt) && /regress/.test(rpt), 'report summarises the diff counts (unchanged / improved / regressed)');

  // ── 2) the signed reverification record model (the primitives the CLI --attest uses) ──
  const led0 = A.loadLedger(p, config).entries.length;
  const rv = RV.reverifyState(p, snap0, key, config, {});
  ok(rv.verObj, 'reverifyState returns a signable verification object');
  const baseline = { capability: A.loadAttestation(p, config, snap0.attest).capability };
  const robj = RV.reverificationObj(rv.verObj, { attest: snap0.attest, at: snap0.at }, baseline);
  ok(robj.kind === 'reverification' && robj.reassesses === snap0.attest, 'reverificationObj is tagged kind:"reverification" and references the original attestation');
  const id = A.verifierIdentity(p, config);
  const att = A.signAttestation(robj, id);
  A.appendAttestation(p, config, att);
  const led = A.loadLedger(p, config);
  ok(led.entries.length === led0 + 1, 'the reverification appends exactly one ledger entry');
  const stored = A.loadAttestation(p, config, led.entries[led.entries.length - 1].hash);
  ok(stored && stored.kind === 'reverification' && stored.reassesses === snap0.attest, 'the stored record is a reverification of the original');
  ok(A.verifyAttestation(stored, A.verifierPub(p, config)).ok, 'it is signed + validates under the verifier key');
  ok(stored.prev === led.entries[led.entries.length - 2].hash, 'it chains onto the previous entry (append-only)');

  // ── 3) the CLI --attest path runs cleanly (no changed states here → nothing to mint) ──
  const out = s.yay(['reverify', '--all', '--attest']);
  ok(/nothing new to record|already recorded|appended \d+ reverification/.test(out), 'yay reverify --all --attest runs cleanly');

  // ── 4) keyless: report works without the verifier key; --attest refuses ──
  fs.rmSync(path.join(p.keys, 'verifier.json'));
  ok(/Verifier upgrade report/.test(s.yay(['reverify', '--all'])), 'report still renders with the verifier private key removed (keyless)');
  let threw = false, err = '';
  try { s.yay(['reverify', '--all', '--attest']); }
  catch (e) { threw = true; err = String((e && e.stderr) || '') + String((e && e.stdout) || ''); }
  ok(threw && /needs the verifier identity/.test(err), '--attest without the verifier key fails with a clear message');

  console.log('\nReverify P3 (CLI + signed reverification records): all ' + n + ' checks passed.');
} finally {
  s.cleanup();
}
