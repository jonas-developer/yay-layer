'use strict';
// Reverify engine — P1: re-run TODAY's verifier against a reconstructed HISTORICAL snapshot and report
// the per-Cell verdict as the machine sees it NOW. This is the "replay the tape through today's better
// reader" primitive. It assesses VERIFICATION only (code⇔spec) — the snapshot was an already-approved
// state, and re-verification is the machine re-judging, independent of the human-authority axis (the
// papers keep those two chains separate). P2/P3 will sweep every snapshot and diff against the original
// attestation to produce the upgrade report; this is the single-state core they stand on.

const fs = require('fs');
const path = require('path');
const os = require('os');
const D = require('./durable');
const A = require('./attest');
const { buildManifest } = require('./manifest');
const { verifyManifest } = require('./verify');
const cap = require('./capability');

// Reconstruct `snap` into a throwaway dir and verify it under the current verifier.
// Returns { codeTreeHash, capability, fingerprint, counts, passed, cells:{id:{state,proven,predicate}} }
// or { error } if the tree can't be faithfully rebuilt. `key` is the resolved Durable archive key.
function reverifyState(p, snap, key, config, opts) {
  opts = opts || {};
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yay-reverify-'));
    D.reconstructSnapshot(p, snap, key, dir);
    // Fidelity gate: a re-verdict is only meaningful if the rebuilt tree IS the recorded one.
    const manifest = buildManifest(dir);
    const rebuilt = A.codeTreeHashOf(manifest);
    if (snap.codeTreeHash && rebuilt !== snap.codeTreeHash) {
      return { error: 'reconstruction mismatch (rebuilt ' + rebuilt.slice(0, 12) + '… ≠ recorded ' + String(snap.codeTreeHash).slice(0, 12) + '…)' };
    }
    // Verification-only: assumeSigned (the snapshot was approved) so the state reflects the machine's
    // code⇔spec judgment under today's checks, not the UNSIGNED gate (there is no lock in the temp dir).
    const verified = verifyManifest(manifest, { approvals: [] }, config, { mutate: opts.mutate !== false, assumeSigned: true });
    const cells = {};
    for (const id of Object.keys(verified.results)) {
      const r = verified.results[id];
      cells[id] = {
        state: r.state,
        proven: !!r.proven,
        predicate: !!(r.predicate && r.predicate.findings && r.predicate.findings.length),
        coverage: (r.coverage && r.coverage.total) ? { exercised: r.coverage.exercised, total: r.coverage.total } : null,
      };
    }
    return {
      codeTreeHash: rebuilt,
      capability: cap.CAPABILITY || null,
      fingerprint: cap.capabilityFingerprint ? cap.capabilityFingerprint() : null,
      counts: verified.counts,
      passed: verified.passed,
      cells,
    };
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  } finally {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} }
  }
}

// ── P2: the sweep ───────────────────────────────────────────────────────────────────────────────
// Replay every preserved snapshot through TODAY's verifier and diff each Cell against its ORIGINAL
// recorded verdict, so a verifier upgrade turns into an "what changed" report. Never rewrites history —
// the originals stand; this only computes deltas (and P3 will append reverification attestations).
const RANK = { GREEN: 0, YELLOW: 1, RED: 2, PINK: 2, UNSIGNED: 2 };
function classify(from, to) {
  if (from == null) return 'no-baseline';
  if (from === to) return 'unchanged';
  const rf = RANK[from] != null ? RANK[from] : 2;
  const rt = RANK[to] != null ? RANK[to] : 2;
  return rt > rf ? 'regressed' : (rt < rf ? 'improved' : 'changed');
}
// The baseline for a snapshot = the per-Cell evidence + capability of its linked (signature-verified)
// attestation. Pluggable so callers/tests can supply a baseline; default reads the real attestation.
function defaultBaselineOf(p, config) {
  return (snap) => {
    if (!snap || !snap.attest) return null;
    try { const att = A.loadAttestation(p, config, snap.attest); return att ? { capability: att.capability || null, evidence: att.evidence || null } : null; }
    catch (_) { return null; }
  };
}
// Sweep all snapshots (deduped by codeTreeHash — identical trees re-verified once). Returns a report:
// { total, checked, deduped, errors, unchanged, improved, regressed, noBaseline, capability, fingerprint,
//   regressions:[…], improvements:[…], states:[…] }.
function reverifySweep(p, key, config, opts) {
  opts = opts || {};
  const baselineOf = opts.baselineOf || defaultBaselineOf(p, config);
  const snaps = D.listSnapshots(p);
  const cache = {};
  const report = {
    total: snaps.length, checked: 0, deduped: 0, errors: 0,
    unchanged: 0, improved: 0, regressed: 0, noBaseline: 0,
    capability: cap.CAPABILITY || null, fingerprint: cap.capabilityFingerprint ? cap.capabilityFingerprint() : null,
    regressions: [], improvements: [], states: [],
  };
  for (const snap of snaps) {
    const ck = snap.codeTreeHash;
    let rv;
    if (ck && cache[ck]) { rv = cache[ck]; report.deduped++; }
    else { rv = reverifyState(p, snap, key, config, opts); if (ck) cache[ck] = rv; }
    if (rv.error) { report.errors++; report.states.push({ at: snap.at, error: rv.error }); continue; }
    report.checked++;
    const base = baselineOf(snap);
    const baseCap = (base && base.capability) || null;
    const baseEv = (base && base.evidence) || null;
    const perCell = {};
    for (const id of Object.keys(rv.cells)) {
      const to = rv.cells[id].state;
      const from = baseEv && baseEv[id] ? baseEv[id].state : null;
      const verdict = classify(from, to);
      perCell[id] = { from, to, verdict, predicate: rv.cells[id].predicate };
      if (verdict === 'regressed') { report.regressed++; report.regressions.push({ at: snap.at, cell: id, from, to, fromCapability: baseCap, toCapability: rv.capability, predicate: rv.cells[id].predicate }); }
      else if (verdict === 'improved') { report.improved++; report.improvements.push({ at: snap.at, cell: id, from, to, fromCapability: baseCap, toCapability: rv.capability }); }
      else if (verdict === 'unchanged') report.unchanged++;
      else if (verdict === 'no-baseline') report.noBaseline++;
    }
    report.states.push({ at: snap.at, codeTreeHash: ck, fromCapability: baseCap, toCapability: rv.capability, cells: perCell });
  }
  return report;
}

module.exports = { reverifyState, reverifySweep, classify };
