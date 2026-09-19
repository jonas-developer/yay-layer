'use strict';
// End-to-end quickstart / demo: drive the REAL CLI through the whole trust arc a newcomer sees —
//   PINK (un-specced) → UNSIGNED (spec, no signature) → GREEN (signed + proven) → RED (code drifts).
// This proves the 5-minute loop's mechanics actually work and can't silently regress, and doubles as
// the "starts Pink/Unsigned, becomes Green, then deliberately Red" demo the 1.0 review asked for.
// (Relay phone-pairing can't be dogfooded headless, so this uses local signing — the loop is identical.)

const assert = require('assert');
const U = require('../src/util');
const { buildManifest } = require('../src/manifest');
const { verifyManifest } = require('../src/verify');
const { scenario } = require('./fixtures/scenario');

let n = 0;
const ok = (c, m) => { n++; assert.ok(c, m); console.log('  ✓ ' + m); };

const s = scenario({ name: 'hello-yay' });
const stateOf = () => {
  const p = s.paths();
  const v = verifyManifest(buildManifest(p.root), U.readJSON(p.lock, {}), s.config(), { mutate: true });
  return { passed: v.passed, results: v.results };
};
const hasState = (st, want) => Object.values(st.results).some((r) => r.state === want);

try {
  s.gitInit();

  // 1 · A raw, un-specced function → PINK, gate blocked.
  s.write('m.js', 'function add(a, b) { return a + b; }\n');
  s.init({});
  let st = stateOf();
  ok(!st.passed && hasState(st, 'PINK'), 'un-specced code is PINK and blocks the gate');

  // 2 · Add the spec (a Cell) but don't sign → UNSIGNED, still blocked.
  s.cell('C-1', { unit: 'add', intent: 'add two numbers', in: 'a: number, b: number', out: 'number', ensures: 'out === a + b', pure: true, file: 'm.js', body: 'function add(a, b) { return a + b; }' });
  st = stateOf();
  ok(!st.passed && st.results['C-1'] && st.results['C-1'].state === 'UNSIGNED', 'a spec with no signature is UNSIGNED and blocks the gate');

  // 3 · Sign it → GREEN, gate passes.
  s.sign('C-1', { brief: 'Add two numbers and return their sum — a pure helper with no side effects.' });
  st = stateOf();
  ok(st.passed && st.results['C-1'].state === 'GREEN', 'signed + proven → GREEN, gate PASS');
  ok(st.results['C-1'].proven === true, 'C-1 is machine-proven (the behavioural prover actually ran)');

  // 4 · Break it — the code now contradicts the signed promise → RED.
  s.write('m.js', s.files['m.js'].replace('return a + b', 'return a - b'));
  st = stateOf();
  ok(!st.passed && st.results['C-1'].state === 'RED', 'code that drifts from the signed spec → RED, gate blocked');

  console.log('\nQuickstart e2e (Pink → Unsigned → Green → Red): all ' + n + ' checks passed.');
} finally {
  s.cleanup();
}
