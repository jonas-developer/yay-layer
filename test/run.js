'use strict';
// Unified test runner — one command, all confirmations. Discovers every top-level test/*.js suite
// (excluding this runner, the confirmation report, and the shared fixtures/), runs each in its own
// process, and prints a single summary: per-suite pass/fail + a grand total of individual checks.
// Exits non-zero if any suite fails, so `npm test` is a real CI gate. Suites run in a stable order
// (smoke — the fast core — first, then the slower CLI-driven integration suites).

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SKIP = new Set(['run.js', 'confirm.js']);
// Preferred ordering; anything not listed runs afterward in alphabetical order.
const ORDER = ['smoke.js', 'history-reconstruct.js', 'reverify-p1.js', 'reverify-p2.js'];

const suites = fs.readdirSync(DIR)
  .filter((f) => f.endsWith('.js') && !SKIP.has(f) && fs.statSync(path.join(DIR, f)).isFile())
  .sort((a, b) => {
    const ia = ORDER.indexOf(a), ib = ORDER.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.localeCompare(b);
  });

const CHECKS = /([0-9]+)\s+checks passed/i;
const results = [];
let grandChecks = 0, failed = 0;
const t0 = Date.now();

console.log('\nYayLayer test suite — ' + suites.length + ' suites\n' + '─'.repeat(52));
for (const f of suites) {
  const started = Date.now();
  const r = spawnSync('node', [path.join(DIR, f)], { cwd: path.join(DIR, '..'), encoding: 'utf8' });
  const out = (r.stdout || '') + (r.stderr || '');
  const m = out.match(CHECKS);
  const checks = m ? parseInt(m[1], 10) : 0;
  const passed = r.status === 0 && !!m;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (passed) { grandChecks += checks; }
  else { failed++; }
  results.push({ f, passed, checks, secs, out });
  const mark = passed ? '[32m✓[0m' : '[31m✗[0m';
  const cnt = passed ? checks + ' checks' : 'FAILED';
  console.log('  ' + mark + '  ' + f.padEnd(26) + cnt.padStart(12) + '   ' + secs + 's');
  if (!passed) {
    // Surface the failing suite's tail so the reason is right here, not buried in a re-run.
    const tail = out.trim().split('\n').slice(-12).map((l) => '        ' + l).join('\n');
    console.log('      ── output ──\n' + tail + '\n');
  }
}

const total = ((Date.now() - t0) / 1000).toFixed(1);
console.log('─'.repeat(52));
if (failed === 0) {
  console.log('[32m✓ all ' + suites.length + ' suites passed — ' + grandChecks + ' checks — ' + total + 's[0m\n');
  process.exit(0);
} else {
  console.log('[31m✗ ' + failed + ' of ' + suites.length + ' suites failed (' + grandChecks + ' checks passed elsewhere) — ' + total + 's[0m\n');
  process.exit(1);
}
