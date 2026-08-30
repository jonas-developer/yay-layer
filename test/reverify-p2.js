'use strict';
// P2: the sweep. Replay every preserved snapshot through today's verifier and diff each Cell against its
// ORIGINAL verdict, producing an "upgrade report." This test builds a real Durable history (a clean
// state + a state whose Cell branches on an undeclared `mode`), then sweeps with a baseline standing in
// for "an older verifier (1.0.0, before the predicate check) said GREEN here" — an honest simulation,
// since 1.0.0 genuinely couldn't detect the undeclared input. The sweep must report exactly one
// regression (the bait Cell: GREEN@1.0.0 → YELLOW@today) and leave the clean state unchanged. Nothing
// in the recorded history is mutated — deltas are computed, never written over.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const U = require('../src/util');
const D = require('../src/durable');
const { reverifySweep } = require('../src/reverify');

const YAY = path.join(__dirname, '..', 'bin', 'yay.js');
let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); console.log('  ✓ ' + msg); };

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yay-rvp2-'));
const proj = path.join(work, 'cart');
fs.mkdirSync(proj, { recursive: true });
const ARCH_KEY = 'archive-key-secret-123';
const env = { ...process.env, YAY_PASSPHRASE: 'secret123', YAY_ARCHIVE_KEY: ARCH_KEY };
const yay = (args) => execFileSync('node', [YAY, ...args], { cwd: proj, env, stdio: 'pipe' });
const git = (args) => execFileSync('git', args, { cwd: proj, env, stdio: 'pipe' });

const CLEAN =
  '//∷YAY⟨C-1⟩\n// unit: applyDiscount\n// intent: apply a percentage discount to a price\n' +
  '// in: price: number, pct: number\n// out: number\n// ensures: out === price * (1 - pct)\n// pure: yes\n' +
  '//∷YAY-END⟨C-1⟩\nfunction applyDiscount(price, pct){ return price * (1 - pct); }\n';
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
  const arc = D.loadArchive(p);
  const key = D.resolveKey(ARCH_KEY, arc.salt);

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
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
}
