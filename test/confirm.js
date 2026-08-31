'use strict';
// Confirmation report — a hand-to-someone artifact that PROVES the load-bearing YayLayer claims behave,
// on a real project, right now. Unlike the test suite (terse pass/fail for CI), this stands up one
// realistic Durable project with the scenario factory, runs the REAL verifier + reverify engine against
// it, and prints a readable rollup: each claim, what it expected, what the machine actually returned,
// and ✓/✗. It ends with the current verifier capability + fingerprint, so the report says exactly which
// verifier produced these confirmations. `node test/confirm.js [-o report.txt]` (or `npm run confirm`).

const fs = require('fs');
const U = require('../src/util');
const { buildManifest } = require('../src/manifest');
const { verifyManifest } = require('../src/verify');
const { reverifyState, reverifySweep } = require('../src/reverify');
const D = require('../src/durable');
const A = require('../src/attest');
const { scenario } = require('./fixtures/scenario');

// ── tiny formatter (color to the terminal; -o gets a clean plaintext copy) ──────────────────────
const g = (s) => '\x1b[32m' + s + '\x1b[0m';
const r = (s) => '\x1b[31m' + s + '\x1b[0m';
const dim = (s) => '\x1b[2m' + s + '\x1b[0m';
const bold = (s) => '\x1b[1m' + s + '\x1b[0m';
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
const lines = [];
const say = (s) => { console.log(s); lines.push(strip(s || '')); };

const checks = [];
function confirm(claim, expect, got, pass) { checks.push({ claim, expect, got, pass }); }
let exitCode = 1;

// ── the scenario: one Durable project exercising the core claims ────────────────────────────────
const SPEC = (over) => Object.assign({ in: 'price: number, pct: number', out: 'number',
  ensures: 'out === price * (1 - pct)', pure: true, file: 'cart.js' }, over);
const s = scenario({ name: 'coinwatch', archiveKey: 'confirm-archive-key' });

try {
  s.gitInit();

  // State 1 — a clean, machine-provable pure Cell.
  s.cell('C-1', SPEC({ unit: 'applyDiscount', intent: 'apply a percentage discount to a price',
    body: 'function applyDiscount(price, pct){ return price * (1 - pct); }' }));
  s.init({ durable: true });
  s.sign('C-1', { brief: 'Discount helper.' }).archive().commit('state-1');

  // State 2 — C-1 now secretly branches on an undeclared `mode` (both branches equal, so the promise
  // still holds); plus a second clean signed Cell (a Green event) and a third left UNSIGNED (the gate).
  s.cell('C-1', SPEC({ unit: 'applyDiscount', intent: 'apply a percentage discount to a price',
    body: 'function applyDiscount(price, pct, mode){ if (mode === "wholesale") return price * (1 - pct); return price * (1 - pct); }' }));
  s.cell('C-2', SPEC({ unit: 'lineTotal', intent: 'total a line item as price times quantity',
    in: 'price: number, qty: number', ensures: 'out === price * qty',
    body: 'function lineTotal(price, qty){ return price * qty; }' }));
  s.cell('C-3', SPEC({ unit: 'withTax', intent: 'add sales tax to a price',
    in: 'price: number, rate: number', ensures: 'out === price * (1 + rate)',
    body: 'function withTax(price, rate){ return price * (1 + rate); }' }));
  s.sign(['C-1', 'C-2'], { brief: 'Wholesale branch, line totals; tax helper left unsigned.' });
  s.archive().commit('state-2');

  const p = s.paths();
  const config = s.config();

  // ── 1–3: the LIVE verdict under today's verifier (the real gate) ──
  const live = verifyManifest(buildManifest(p.root), U.readJSON(p.lock, {}), config, { mutate: false });
  const c1 = live.results['C-1'], c2 = live.results['C-2'], c3 = live.results['C-3'];

  confirm('Green is an event (signed + machine-proven → GREEN)',
    'C-2 = GREEN', 'C-2 = ' + c2.state, c2.state === 'GREEN');

  confirm('Unsigned code cannot pass the gate',
    'C-3 = UNSIGNED, gate BLOCKED', 'C-3 = ' + c3.state + ', gate ' + (live.passed ? 'PASS' : 'BLOCKED'),
    c3.state === 'UNSIGNED' && !live.passed);

  confirm('Undeclared-input predicate (◈) is caught',
    'C-1 = YELLOW + predicate finding',
    'C-1 = ' + c1.state + (c1.predicate && c1.predicate.findings && c1.predicate.findings.length ? ' + predicate' : ' (no predicate)'),
    c1.state === 'YELLOW' && !!(c1.predicate && c1.predicate.findings && c1.predicate.findings.length));

  // ── 4: faithful historical reconstruction ──
  const snaps = s.snapshots();
  const key = s.archiveKeyResolved();
  const os = require('os'), path = require('path');
  const recon = fs.mkdtempSync(path.join(os.tmpdir(), 'yay-confirm-'));
  D.reconstructSnapshot(p, snaps[0], key, recon);
  const rebuilt = A.codeTreeHashOf(buildManifest(recon));
  try { fs.rmSync(recon, { recursive: true, force: true }); } catch (_) {}
  confirm('Durable history reconstructs bit-for-bit',
    'rebuilt hash === recorded hash',
    (rebuilt === snaps[0].codeTreeHash ? 'match ' : 'MISMATCH ') + dim(String(rebuilt).slice(0, 12) + '…'),
    rebuilt === snaps[0].codeTreeHash);

  // ── 5: reverify sweep surfaces the regression a newer verifier now sees ──
  // Baseline stand-in: an older verifier (1.0.0, pre-predicate) honestly recorded C-1 as GREEN.
  const report = reverifySweep(p, key, config, { baselineOf: () => ({ capability: '1.0.0', evidence: { 'C-1': { state: 'GREEN', proven: true } } }) });
  const reg = report.regressions.find((x) => x.cell === 'C-1');
  confirm('Reverify sweep re-judges history under today\'s verifier',
    '1 regression: C-1 GREEN→YELLOW (◈)',
    report.regressed + ' regression(s)' + (reg ? ', C-1 ' + reg.from + '→' + reg.to + (reg.predicate ? ' (◈)' : '') : ''),
    report.regressed === 1 && !!reg && reg.from === 'GREEN' && reg.to === 'YELLOW' && reg.predicate === true);

  // ── render ──
  const pass = checks.filter((c) => c.pass).length;
  const all = pass === checks.length;
  say('');
  say(bold('  YayLayer — confirmation report'));
  say(dim('  A real Durable project, verified by the live engine. ' + checks.length + ' claims.'));
  say('  ' + '─'.repeat(64));
  for (const c of checks) {
    say('  ' + (c.pass ? g('✓') : r('✗')) + '  ' + c.claim);
    say('       ' + dim('expect: ') + c.expect);
    say('       ' + dim('got:    ') + (c.pass ? c.got : r(c.got)));
  }
  say('  ' + '─'.repeat(64));
  say('  verifier capability ' + bold(report.capability || '?') + dim('  fingerprint ' + String(report.fingerprint || '').slice(0, 16) + '…'));
  say('  ' + (all ? g('✓ ALL ' + checks.length + ' CLAIMS CONFIRMED') : r('✗ ' + pass + '/' + checks.length + ' confirmed — ' + (checks.length - pass) + ' FAILED')));
  say('');

  // ── optional plaintext artifact ──
  const oi = process.argv.indexOf('-o');
  if (oi >= 0 && process.argv[oi + 1]) {
    fs.writeFileSync(process.argv[oi + 1], lines.join('\n') + '\n');
    console.log(dim('  → wrote ' + process.argv[oi + 1]));
  }

  exitCode = all ? 0 : 1;
} finally {
  s.cleanup();
}
process.exit(exitCode);
