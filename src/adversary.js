'use strict';
// Spec-only adversary — the "independent author" from the test-independence design.
// An LLM is shown ONLY a Cell's formal spec (never the code) and asked to WRITE code
// that tries to BREAK it: hostile/edge/boundary/metamorphic inputs that throw if the
// function violates its promises. We then run that probe against the REAL function in
// the prover's sandbox. Because the author never saw the implementation, a failure
// can't be an echo of the code — it's a genuine spec↔code violation.

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { runSource } = require('./prove');
const plan = require('./plan');

const SYSTEM = [
  'You are an adversarial test author inside a verification system.',
  'You are given ONLY the formal SPEC of one function — never its source code. Assume nothing beyond the spec.',
  'Goal: TRY TO BREAK IT. Write JavaScript that calls the function with hostile, edge, boundary, empty/zero/negative,',
  'large, and metamorphic inputs, and THROWS if the function ever violates the spec.',
  'Return ONLY JavaScript defining exactly one function: function probe(fn) { ... }',
  '- Inside probe, call fn(...) and `throw new Error("<why> for input <values>")` on any violation of the spec.',
  '- Check every postcondition in `ensures`, and if `throws:` is stated, assert it throws on those inputs.',
  '- Judge ONLY against the given spec — do not invent requirements it does not state.',
  '- No prose, no markdown fences, no import/require. Deterministic checks only. Math/JSON/Error are available.',
].join('\n');

// The spec shown to the model — spec fields ONLY, never the code body.
function specText(cell) {
  const s = cell.spec || {};
  const L = ['unit: ' + (cell.unitName || '')];
  if (s.intent) L.push('intent: ' + s.intent);
  if (s.in) L.push('in: ' + s.in);
  if (s.out) L.push('out: ' + s.out);
  if (s.pure) L.push('pure: ' + s.pure);
  if (s.ensures) L.push('ensures: ' + s.ensures);
  if (s.throws) L.push('throws: ' + s.throws);
  return L.join('\n');
}

function extractCode(t) {
  t = String(t || '').trim();
  const f = t.match(/```(?:js|javascript)?\s*([\s\S]*?)```/i);
  if (f) t = f[1].trim();
  return t.replace(/^\s*(import|export)\b.*$/gm, ''); // probes need no modules
}

function eligible(cell) {
  const s = cell.spec || {};
  const isLeaf = !(cell.contains && cell.contains.length);
  return isLeaf && cell.unitFound && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cell.unitName || '') && !!(s.ensures || s.throws || s.out);
}

// Run the model's probe(fn) against the real function in a fresh sandbox.
function runProbe(source, unitName, probeSource) {
  const base = runSource(source, [unitName]);
  if (base.error || typeof base.fns[unitName] !== 'function') return { status: 'skip', reason: 'unit not callable in isolation' };
  try { vm.runInContext(probeSource + '\n;', base.ctx, { timeout: 3000 }); }
  catch (e) { return { status: 'skip', reason: 'generated probe did not load: ' + (e && e.message ? e.message.split('\n')[0] : 'error') }; }
  if (!vm.runInContext('typeof probe === "function"', base.ctx)) return { status: 'skip', reason: 'model did not define probe(fn)' };
  base.ctx.__advfn = base.fns[unitName];
  try { vm.runInContext('probe(__advfn)', base.ctx, { timeout: 5000 }); return { status: 'survived' }; }
  catch (e) { return { status: 'broke', counterexample: String((e && e.message) || e).slice(0, 500) }; }
}

// auth: the provider config (from resolvePlanAuth). opts.cells = optional id filter.
// opts.chat lets tests inject a fake LLM. Returns { id: {status, counterexample?, reason?, probe?} }.
async function adversaryManifest(manifest, auth, opts) {
  opts = opts || {};
  const chat = opts.chat || plan.chat;
  const out = {};
  const byFile = {};
  for (const id of Object.keys(manifest.cells)) {
    const c = manifest.cells[id];
    if (opts.cells && opts.cells.indexOf(id) < 0) continue;
    if (!eligible(c)) continue;
    (byFile[c.file] = byFile[c.file] || []).push(c);
  }
  for (const file of Object.keys(byFile)) {
    let source; try { source = fs.readFileSync(path.join(manifest.root, file), 'utf8'); }
    catch (_) { for (const c of byFile[file]) out[c.id] = { status: 'skip', reason: 'file unreadable' }; continue; }
    for (const c of byFile[file]) {
      let probeSrc;
      try { probeSrc = extractCode(await chat(SYSTEM, specText(c), auth)); }
      catch (e) { out[c.id] = { status: 'error', reason: 'LLM error: ' + (e && e.message ? e.message : String(e)) }; continue; }
      out[c.id] = runProbe(source, c.unitName, probeSrc);
      out[c.id].probe = probeSrc;
    }
  }
  return out;
}

module.exports = { adversaryManifest, specText, extractCode, runProbe, SYSTEM, eligible };
