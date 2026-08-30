'use strict';
// P0 of the reverify engine: prove a HISTORICAL tree can be faithfully reconstructed from the Durable
// archive. Drives the real CLI to build a longitudinal fixture (a project evolved across signed +
// archived states, with synthetic ordering), then reconstructs an EARLIER snapshot and asserts it
// round-trips bit-for-bit (rebuilt codeTreeHash === the recorded one). This is the load-bearing
// primitive the sweep/report (P2/P3) will stand on, and the seed of the temporal-provenance suite.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const U = require('../src/util');
const D = require('../src/durable');
const A = require('../src/attest');
const { buildManifest } = require('../src/manifest');

const YAY = path.join(__dirname, '..', 'bin', 'yay.js');
let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); console.log('  ✓ ' + msg); };

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yay-hist-'));
const proj = path.join(work, 'cart');
fs.mkdirSync(proj, { recursive: true });
const ARCH_KEY = 'archive-key-secret-123';
const env = { ...process.env, YAY_PASSPHRASE: 'secret123', YAY_ARCHIVE_KEY: ARCH_KEY };
const yay = (args) => execFileSync('node', [YAY, ...args], { cwd: proj, env, stdio: 'pipe' });
const git = (args) => execFileSync('git', args, { cwd: proj, env, stdio: 'pipe' });

// A spec block, written with the real marker grammar (∷YAY⟨…⟩).
const cell = (id, unit, intent, ensures, body) =>
  '//∷YAY⟨' + id + '⟩\n// unit: ' + unit + '\n// intent: ' + intent + '\n// in: price: number, pct: number\n// out: number\n// ensures: ' + ensures + '\n// pure: yes\n//∷YAY-END⟨' + id + '⟩\n' + body + '\n';

const C1_V1 = cell('C-1', 'applyDiscount', 'apply a percentage discount to a price',
  'out === price * (1 - pct)', 'function applyDiscount(price, pct){ return price * (1 - pct); }');
const C1_V2 = cell('C-1', 'applyDiscount', 'apply a percentage discount, never below zero',
  'out === Math.max(0, price * (1 - pct))', 'function applyDiscount(price, pct){ return Math.max(0, price * (1 - pct)); }');
const C2 = '//∷YAY⟨C-2⟩\n// unit: formatMoney\n// intent: format a number as a USD string\n// in: n: number\n// out: string\n// pure: yes\n//∷YAY-END⟨C-2⟩\nfunction formatMoney(n){ return "$" + n.toFixed(2); }\n';

try {
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);

  // ── State 1: just C-1 (v1) ──
  fs.writeFileSync(path.join(proj, 'cart.js'), C1_V1);
  yay(['init', '--durable', '--key', 'local', '--name', 'alex', '--passphrase', 'secret123', '--no-adopt', '--tags', 'none', '--no-pair']);
  yay(['sign', '--cell', 'C-1', '--brief', 'Initial discount helper.', '--no-title', '--yes']);
  yay(['archive', '--quiet']);
  git(['add', '-A']); git(['commit', '-q', '-m', 'state1']);

  // ── State 2: C-1 changes (floor at zero) + a new C-2 ──
  fs.writeFileSync(path.join(proj, 'cart.js'), C1_V2 + C2);
  yay(['sign', '--cell', 'C-1,C-2', '--brief', 'Floor discounts at zero and add a money formatter.', '--no-title', '--yes']);
  yay(['archive', '--quiet']);
  git(['add', '-A']); git(['commit', '-q', '-m', 'state2']);

  // ── The archive should now hold one reconstructable snapshot per state ──
  const p = U.paths(proj);
  const snaps = D.listSnapshots(p);
  ok(snaps.length >= 2, 'archive recorded a snapshot per state (got ' + snaps.length + ')');
  const s1 = snaps[0];
  ok(s1.files && s1.files['cart.js'] && s1.codeTreeHash, 'snapshot 1 carries a file→blob-hash map + a codeTreeHash');
  ok(snaps[1].files['cart.js'] !== s1.files['cart.js'], 'snapshot 2 points at a different blob (the tree changed)');

  // ── Reconstruct STATE 1 from the encrypted blobs into a fresh dir ──
  const arc = D.loadArchive(p);
  const key = D.resolveKey(ARCH_KEY, arc.salt);
  const recon = path.join(work, 'recon1');
  fs.mkdirSync(recon, { recursive: true });
  D.reconstructSnapshot(p, s1, key, recon);

  const reconCart = fs.readFileSync(path.join(recon, 'cart.js'), 'utf8');
  ok(reconCart === C1_V1, 'reconstructed cart.js is the STATE-1 bytes (v1), not the current v2');
  ok(reconCart.indexOf('formatMoney') < 0, 'reconstructed tree does NOT contain the later C-2 — it is genuinely the old state');
  ok(reconCart.indexOf('Math.max') < 0, 'reconstructed C-1 is the pre-floor spec/code, not the v2 that floors at zero');

  // ── Fidelity: the rebuilt tree hashes back to exactly what was recorded ──
  const reconManifest = buildManifest(recon);
  ok(A.codeTreeHashOf(reconManifest) === s1.codeTreeHash,
    'rebuilt codeTreeHash === recorded snapshot codeTreeHash (faithful, hash-verified reconstruction)');
  ok(!!reconManifest.cells['C-1'] && !reconManifest.cells['C-2'], 'rebuilt manifest has C-1 only (the state-1 cell set)');

  console.log('\nHistory reconstruction (P0): all ' + n + ' checks passed.');
} finally {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (_) {}
}
