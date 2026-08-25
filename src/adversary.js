'use strict';
// Spec-only adversary — the independent-author layer, done right.
//
// The LLM sees ONLY a Cell's spec (never the code) and PROPOSES adversarial INPUTS
// most likely to violate `ensures`. It does NOT judge. YayLayer's own deterministic
// checker (the prover's) then runs the REAL function on each proposed input and
// evaluates the real `ensures`. So a "break" is machine-confirmed — the LLM can't
// produce a false positive from a bad mock or a wrong expectation; at worst it
// proposes weak inputs and nothing breaks. Restricted to pure, ensures-bearing Cells
// (effectful/render Cells are honestly skipped — they need a code-aware/effect test).

const fs = require('fs');
const path = require('path');
const { runSource, parseIn, buildChecker, show } = require('./prove');
const plan = require('./plan');

const SYSTEM = [
  'You are an adversarial INPUT generator in a verification system.',
  'You are given ONLY the formal SPEC of one function — never its source code.',
  'Propose the input tuples MOST LIKELY to make the function violate its `ensures` postcondition.',
  '- Every tuple MUST be valid per the `in:` declaration (right arity and types). Do not use out-of-type values.',
  '- Hunt domain corners the spec does NOT forbid: zero, negative, empty, boundary, very large, duplicates, unordered, extreme ratios, near-equal, etc.',
  '- You do NOT assert or judge. Return ONLY a JSON array of argument-arrays, e.g. [[0,0],[-1,5],[1000000,1]]. No prose, no code, no comments.',
].join('\n');

// The spec shown to the model — spec fields ONLY, never the code.
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

function extractJSON(t) {
  t = String(t || '').trim();
  const f = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (f) t = f[1].trim();
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try { const j = JSON.parse(t); return Array.isArray(j) ? j : []; } catch (_) { return []; }
}

function eligible(cell) {
  const s = cell.spec || {};
  const isLeaf = !(cell.contains && cell.contains.length);
  const pure = /^yes\b/i.test(s.pure || '');
  return isLeaf && cell.unitFound && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(cell.unitName || '') && pure && !!s.ensures;
}
function skipReason(cell) {
  const s = cell.spec || {};
  if (cell.contains && cell.contains.length) return 'container Cell (composition, not code)';
  if (!cell.unitFound) return 'no code unit found below the spec';
  if (!/^yes\b/i.test(s.pure || '')) return 'not pure (has effects) — needs a code-aware / effect-trace test, not a spec-only probe';
  if (!s.ensures) return 'no machine-checkable `ensures` to judge against';
  return 'not adversary-testable';
}

function fmtArgs(params, A) { return '(' + A.map((v, i) => (params[i] || ('arg' + i)) + '=' + show(v)).join(', ') + ')'; }

// Run the REAL function on the proposed inputs and judge with the real `ensures`.
function judge(source, cell, tuples) {
  const base = runSource(source, [cell.unitName]);
  if (base.error || typeof base.fns[cell.unitName] !== 'function') return { status: 'skip', reason: 'unit not callable in isolation' };
  const params = parseIn(cell.spec).map((p) => p.name);
  let checker; try { checker = buildChecker(base.ctx, params, cell.spec.ensures); }
  catch (e) { return { status: 'skip', reason: 'ensures not evaluable: ' + (e && e.message ? e.message.split('\n')[0] : 'error') }; }
  if (!Array.isArray(tuples) || !tuples.length) return { status: 'survived', note: 'no candidate inputs proposed' };
  const throwsDeclared = !!(cell.spec && cell.spec.throws);
  for (const A of tuples) {
    if (!Array.isArray(A)) continue;
    let r;
    try { r = checker(base.fns[cell.unitName], A); }
    catch (e) {
      if (throwsDeclared) continue; // may be an expected throw — don't judge without an oracle
      return { status: 'broke', counterexample: 'threw on ' + fmtArgs(params, A) + ' — ' + String((e && e.message) || e).slice(0, 160) };
    }
    if (r && r.ok === false) return { status: 'broke', counterexample: 'ensures failed for ' + fmtArgs(params, A) + ' → out=' + show(r.out) };
  }
  return { status: 'survived' };
}

// auth: provider config (resolvePlanAuth). opts.cells = id filter; opts.chat = fake LLM for tests.
async function adversaryManifest(manifest, auth, opts) {
  opts = opts || {};
  const chat = opts.chat || plan.chat;
  const out = {};
  const byFile = {};
  for (const id of Object.keys(manifest.cells)) {
    const c = manifest.cells[id];
    if (opts.cells && opts.cells.indexOf(id) < 0) continue;
    if (!eligible(c)) { if (opts.cells) out[id] = { status: 'skip', reason: skipReason(c) }; continue; }
    (byFile[c.file] = byFile[c.file] || []).push(c);
  }
  for (const file of Object.keys(byFile)) {
    let source; try { source = fs.readFileSync(path.join(manifest.root, file), 'utf8'); }
    catch (_) { for (const c of byFile[file]) out[c.id] = { status: 'skip', reason: 'file unreadable' }; continue; }
    for (const c of byFile[file]) {
      let tuples;
      try { tuples = extractJSON(await chat(SYSTEM, specText(c), auth)); }
      catch (e) { out[c.id] = { status: 'error', reason: 'LLM error: ' + (e && e.message ? e.message : String(e)) }; continue; }
      out[c.id] = judge(source, c, tuples);
      out[c.id].tried = Array.isArray(tuples) ? tuples.length : 0;
    }
  }
  return out;
}

module.exports = { adversaryManifest, specText, extractJSON, eligible, skipReason, judge, SYSTEM };
