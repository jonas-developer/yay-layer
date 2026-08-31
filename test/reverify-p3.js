'use strict';
// P3: the CLI surface + signed reverification records. Drives the REAL `yay reverify --all` against a
// Durable history and asserts the whole user-facing arc:
//   • the upgrade report renders and is KEYLESS (works with the verifier private key removed);
//   • --attest mints a signed, append-only reverification record (kind:'reverification') that references
//     the ORIGINAL attestation, validates under the verifier key, and chains into the ledger;
//   • re-running --attest DEDUPS (records the same re-assessment once);
//   • --attest without the verifier key fails with a clear message (report still works without it).
//
// The regression *content* (GREEN→YELLOW under a newer capability) is covered by reverify-p2; here the
// detectable per-state delta is an UNSIGNED→GREEN improvement (the original attestation recorded C-2 as
// UNSIGNED; reverify, treating the archived state as approved, now judges it GREEN), which exercises the
// mint path end-to-end without needing a capability time-machine.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const A = require('../src/attest');
const { scenario } = require('./fixtures/scenario');

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); console.log('  ✓ ' + msg); };

const SPEC = (over) => Object.assign({ in: 'a: number, b: number', out: 'number', pure: true, file: 'cart.js' }, over);

const s = scenario({ name: 'cart', archiveKey: 'p3-archive-key' });
try {
  s.gitInit();
  // One signed, machine-provable Cell + one left UNSIGNED in the same (archived) file.
  s.cell('C-1', SPEC({ unit: 'add', intent: 'add two numbers', ensures: 'out === a + b', body: 'function add(a, b){ return a + b; }' }));
  s.cell('C-2', SPEC({ unit: 'sub', intent: 'subtract two numbers', ensures: 'out === a - b', body: 'function sub(a, b){ return a - b; }' }));
  s.init({ durable: true });
  s.sign('C-1', { brief: 'Adder (C-2 intentionally left unsigned).' });
  s.attest({ force: true });     // original attestation: C-1 GREEN, C-2 UNSIGNED — must precede archive
  s.archive().commit('s1');      // snapshot links to that attestation

  const p = s.paths();
  const config = s.config();

  // Snapshot must carry a baseline attestation for the sweep to diff against.
  const snaps = s.snapshots();
  ok(snaps.length >= 1 && snaps[0].attest, 'archived snapshot links to its original attestation');
  const ledgerBefore = A.loadLedger(p, config).entries.length;

  // ── 1) keyless upgrade report ──
  const rpt = s.yay(['reverify', '--all']);
  ok(/Verifier upgrade report/.test(rpt), 'yay reverify --all renders the upgrade report');
  ok(/improved/.test(rpt) && /regress/.test(rpt), 'report summarises improved / regressed counts');

  // ── 2) --attest mints a signed reverification record ──
  const out = s.yay(['reverify', '--all', '--attest']);
  ok(/appended \d+ reverification record/.test(out), 'yay reverify --all --attest appends record(s)');
  const led = A.loadLedger(p, config);
  ok(led.entries.length === ledgerBefore + 1, 'exactly one new ledger entry appended');
  const rev = A.loadAttestation(p, config, led.entries[led.entries.length - 1].hash);
  ok(rev && rev.kind === 'reverification', 'the new record is kind:"reverification"');
  ok(rev && rev.reassesses === snaps[0].attest, 'it references the ORIGINAL attestation it re-assesses');
  ok(A.verifyAttestation(rev, A.verifierPub(p, config)).ok, 'the reverification is signed + validates under the verifier key');
  ok(rev.prev === led.entries[led.entries.length - 2].hash, 'it chains onto the previous ledger entry (append-only)');

  // ── 3) dedup ──
  const out2 = s.yay(['reverify', '--all', '--attest']);
  ok(/already recorded|nothing new to record/.test(out2), 're-running --attest dedups (does not re-mint)');
  ok(A.loadLedger(p, config).entries.length === ledgerBefore + 1, 'ledger unchanged on the second --attest');

  // ── 4) keyless: report works without the verifier private key; --attest refuses ──
  fs.rmSync(path.join(p.keys, 'verifier.json'));
  const rptKeyless = s.yay(['reverify', '--all']);
  ok(/Verifier upgrade report/.test(rptKeyless), 'report still renders with the verifier private key removed (keyless)');
  let threw = false, stderr = '';
  try { s.yay(['reverify', '--all', '--attest']); }
  catch (e) { threw = true; stderr = String((e && e.stderr) || '') + String((e && e.stdout) || ''); }
  ok(threw && /needs the verifier identity/.test(stderr), '--attest without the verifier key fails with a clear message');

  console.log('\nReverify P3 (CLI + signed reverification records): all ' + n + ' checks passed.');
} finally {
  s.cleanup();
}
