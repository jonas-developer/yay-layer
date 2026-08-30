'use strict';
// P1: reverifyState re-runs TODAY's verifier against a reconstructed HISTORICAL snapshot. Proves the
// engine actually replays old code through the current checks — including undeclared-input predicate
// provenance — and distinguishes states: a clean archived state comes back GREEN; a state whose Cell
// branches on an input its `in:` never declared comes back YELLOW with the predicate flag, even though
// it was archived as an approved state. This is "replay the tape through today's better reader" working
// on one state; the sweep (P2) fans this across all snapshots and diffs against the original attestation.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const U = require('../src/util');
const D = require('../src/durable');
const { reverifyState } = require('../src/reverify');

const YAY = path.join(__dirname, '..', 'bin', 'yay.js');
let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); console.log('  ✓ ' + msg); };

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yay-rvp1-'));
const proj = path.join(work, 'cart');
fs.mkdirSync(proj, { recursive: true });
const ARCH_KEY = 'archive-key-secret-123';
const env = { ...process.env, YAY_PASSPHRASE: 'secret123', YAY_ARCHIVE_KEY: ARCH_KEY };
const yay = (args) => execFileSync('node', [YAY, ...args], { cwd: proj, env, stdio: 'pipe' });
const git = (args) => execFileSync('git', args, { cwd: proj, env, stdio: 'pipe' });

// State 1: a clean, machine-provable pure Cell (will be GREEN).
const CLEAN =
  '//∷YAY⟨C-1⟩\n// unit: applyDiscount\n// intent: apply a percentage discount to a price\n' +
  '// in: price: number, pct: number\n// out: number\n// ensures: out === price * (1 - pct)\n// pure: yes\n' +
  '//∷YAY-END⟨C-1⟩\nfunction applyDiscount(price, pct){ return price * (1 - pct); }\n';
// State 2: SAME promise, but the code now branches on `mode` — an input `in:` never declares.
// Both branches return the same value, so the ensures still holds (prover passes) — yet today's
// predicate-provenance check flags the undeclared control input → YELLOW.
const BAIT =
  '//∷YAY⟨C-1⟩\n// unit: applyDiscount\n// intent: apply a percentage discount to a price\n' +
  '// in: price: number, pct: number\n// out: number\n// ensures: out === price * (1 - pct)\n// pure: yes\n' +
  '//∷YAY-END⟨C-1⟩\nfunction applyDiscount(price, pct, mode){ if (mode === "wholesale") return price * (1 - pct); return price * (1 - pct); }\n';

try {
  git(['init', '-q']); git(['config', 'user.email', 't@e.com']); git(['config', 'user.name', 'T']);

  fs.writeFileSync(path.join(proj, 'cart.js'), CLEAN);
  yay(['init', '--durable', '--key', 'local', '--name', 'alex', '--passphrase', 'secret123', '--no-adopt', '--tags', 'none', '--no-pair']);
  yay(['sign', '--cell', 'C-1', '--brief', 'Discount helper.', '--no-title', '--yes']);
  yay(['archive', '--quiet']);
  git(['add', '-A']); git(['commit', '-q', '-m', 's1']);

  fs.writeFileSync(path.join(proj, 'cart.js'), BAIT);
  yay(['sign', '--cell', 'C-1', '--brief', 'Wholesale branch (undeclared mode).', '--no-title', '--yes']);
  yay(['archive', '--quiet']);
  git(['add', '-A']); git(['commit', '-q', '-m', 's2']);

  const p = U.paths(proj);
  const config = U.readJSON(p.config, {});
  const snaps = D.listSnapshots(p);
  ok(snaps.length >= 2, 'two archived snapshots (got ' + snaps.length + ')');
  const arc = D.loadArchive(p);
  const key = D.resolveKey(ARCH_KEY, arc.salt);

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
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
}
