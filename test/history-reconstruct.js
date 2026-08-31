'use strict';
// P0 of the reverify engine: prove a HISTORICAL tree can be faithfully reconstructed from the Durable
// archive. Uses the shared scenario factory to build a longitudinal fixture (a project evolved across
// signed + archived states), then reconstructs an EARLIER snapshot and asserts it round-trips
// bit-for-bit (rebuilt codeTreeHash === the recorded one). This is the load-bearing primitive the
// sweep/report (P2/P3) stands on, and the seed of the temporal-provenance suite.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const D = require('../src/durable');
const A = require('../src/attest');
const { buildManifest } = require('../src/manifest');
const { scenario, specBlock } = require('./fixtures/scenario');

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); console.log('  ✓ ' + msg); };

// State-1 bytes we reconstruct back to — captured from the factory's own rendering so the round-trip
// comparison is exact (the factory is the single source of the marker grammar).
const C1_V1 = specBlock('C-1', { unit: 'applyDiscount', intent: 'apply a percentage discount to a price',
  in: 'price: number, pct: number', out: 'number', ensures: 'out === price * (1 - pct)', pure: true },
  'function applyDiscount(price, pct){ return price * (1 - pct); }');

const s = scenario({ name: 'cart', archiveKey: 'archive-key-secret-123' });
try {
  s.gitInit();

  // ── State 1: just C-1 (v1) ──
  s.cell('C-1', { unit: 'applyDiscount', intent: 'apply a percentage discount to a price',
    in: 'price: number, pct: number', out: 'number', ensures: 'out === price * (1 - pct)', pure: true,
    file: 'cart.js', body: 'function applyDiscount(price, pct){ return price * (1 - pct); }' });
  s.init({ durable: true });
  s.sign('C-1', { brief: 'Initial discount helper.' }).archive().commit('state1');

  // ── State 2: C-1 changes (floor at zero) + a new C-2 ──
  s.cell('C-1', { unit: 'applyDiscount', intent: 'apply a percentage discount, never below zero',
    in: 'price: number, pct: number', out: 'number', ensures: 'out === Math.max(0, price * (1 - pct))', pure: true,
    file: 'cart.js', body: 'function applyDiscount(price, pct){ return Math.max(0, price * (1 - pct)); }' });
  s.cell('C-2', { unit: 'formatMoney', intent: 'format a number as a USD string',
    in: 'n: number', out: 'string', pure: true, file: 'cart.js', body: 'function formatMoney(n){ return "$" + n.toFixed(2); }' });
  s.sign(['C-1', 'C-2'], { brief: 'Floor discounts at zero and add a money formatter.' }).archive().commit('state2');

  // ── The archive should now hold one reconstructable snapshot per state ──
  const p = s.paths();
  const snaps = s.snapshots();
  ok(snaps.length >= 2, 'archive recorded a snapshot per state (got ' + snaps.length + ')');
  const s1 = snaps[0];
  ok(s1.files && s1.files['cart.js'] && s1.codeTreeHash, 'snapshot 1 carries a file→blob-hash map + a codeTreeHash');
  ok(snaps[1].files['cart.js'] !== s1.files['cart.js'], 'snapshot 2 points at a different blob (the tree changed)');

  // ── Reconstruct STATE 1 from the encrypted blobs into a fresh dir ──
  const key = s.archiveKeyResolved();
  const recon = fs.mkdtempSync(path.join(require('os').tmpdir(), 'yay-recon-'));
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
  try { fs.rmSync(recon, { recursive: true, force: true }); } catch (_) {}

  console.log('\nHistory reconstruction (P0): all ' + n + ' checks passed.');
} finally {
  s.cleanup();
}
