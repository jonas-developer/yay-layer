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
    // The signable verification object for this reconstructed historical tree, judged under TODAY's
    // verifier. `yay reverify --attest` turns this into a signed, append-only reverification record
    // (see reverificationObj). Built from the reconstructed manifest, so its code/spec hashes describe
    // the HISTORICAL state, while its capability/fingerprint describe today's verifier.
    const verObj = A.buildVerification(manifest, verified, { config });
    return {
      codeTreeHash: rebuilt,
      capability: cap.CAPABILITY || null,
      fingerprint: cap.capabilityFingerprint ? cap.capabilityFingerprint() : null,
      counts: verified.counts,
      passed: verified.passed,
      cells,
      verObj,
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
  const nowCap = cap.CAPABILITY || null;
  const allSnaps = D.listSnapshots(p);
  const cache = {};
  const report = {
    total: allSnaps.length, filtered: 0, checked: 0, deduped: 0, errors: 0,
    unchanged: 0, improved: 0, regressed: 0, noBaseline: 0,
    capability: nowCap, fingerprint: cap.capabilityFingerprint ? cap.capabilityFingerprint() : null,
    regressions: [], improvements: [], states: [],
  };
  for (const snap of allSnaps) {
    // Cheap pre-filters (no reconstruction needed): --since keeps snapshots at/after a date; --eligible
    // keeps only those a capability change could actually re-judge (baseline capability ≠ today's).
    if (opts.since && snap.at && String(snap.at) < String(opts.since)) { report.filtered++; continue; }
    if (opts.eligibleOnly) {
      const b = baselineOf(snap);
      if (b && b.capability && b.capability === nowCap) { report.filtered++; continue; }
    }
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
    // A state "changed" if any Cell moved against its baseline — this is what --attest mints a record for.
    const changed = Object.keys(perCell).some((id) => perCell[id].verdict === 'regressed' || perCell[id].verdict === 'improved');
    const st = { at: snap.at, codeTreeHash: ck, attest: snap.attest || null, fromCapability: baseCap, toCapability: rv.capability, changed, cells: perCell };
    if (opts.keepVerObj) st.verObj = rv.verObj;
    report.states.push(st);
  }
  return report;
}

// Turn a reconstructed state's verification object into a signable REVERIFICATION record: the same
// canonical verification bytes (today's capability judging the historical code/spec), tagged as a
// reverification and carrying a reference to the ORIGINAL attestation it re-assesses (Paper 3: append
// a new immutable record beside the old, never rewrite). The caller signs it with the verifier key and
// appends it to the same chain (A.signAttestation → A.appendAttestation).
function reverificationObj(verObj, snap, baseline) {
  return Object.assign({}, verObj, {
    kind: 'reverification',
    reassesses: (snap && snap.attest) || null,      // hash of the original attestation for this state
    reassessedAt: (snap && snap.at) || null,        // when the original state was archived
    originalCapability: (baseline && baseline.capability) || null,
  });
}

// ── P4: the reverification posture (grandfathering) ──────────────────────────────────────────────
// A project-level gate control — off / guarded / strict — in the same spirit as the foundation seal
// posture (and, like it, NOT a per-Cell capability policy kind: it changes gate ENFORCEMENT of record
// existence, never how any Cell's verdict is computed, so it stays out of the capability fingerprint).
//   off      — preserved history is grandfathered (the default). A better verifier never blocks old work.
//   guarded  — `yay verify` WARNS when preserved history predates the current verifier capability.
//   strict   — the gate BLOCKS until each such state has a signed reverification under the current
//              capability (`yay reverify --all --attest`). Enforces the EXISTENCE of the signed record —
//              never key-possession at view time (the keyless report is always available).
function reverifyPosture(config) {
  const m = String((config && config.reverification) || 'off').toLowerCase();
  return (m === 'guarded' || m === 'strict') ? m : 'off';
}

// Consult the posture against preserved history. Returns { posture, capability, subject, pending, satisfied }
// where `pending` lists distinct preserved states whose ORIGINAL attestation predates the current
// capability and that no reverification at the current capability yet covers. `opts.capability` overrides
// the current capability (used in tests to simulate a bump without a live version change).
function reverifyGate(p, config, opts) {
  opts = opts || {};
  const posture = opts.posture || reverifyPosture(config);
  const cur = opts.capability || cap.CAPABILITY || null;
  const out = { posture, capability: cur, subject: posture !== 'off', pending: [], satisfied: true };
  if (posture === 'off') return out;
  // Which original attestations already have a reverification at the CURRENT capability?
  const led = A.loadLedger(p, config);
  const covered = {};
  for (const e of led.entries) {
    const a = A.loadAttestation(p, config, e.hash);
    if (a && a.kind === 'reverification' && a.capability === cur && a.reassesses) covered[a.reassesses] = true;
  }
  // Optional per-Cell scoping (P4b): when opts.scoped is set, only states that contained at least one
  // in-scope Cell (an owner-signed `reverify: latest` match — opts.scopedIds is that Cell-id set) are
  // subject; the rest stay grandfathered. Membership is read from the state's own attestation evidence,
  // so scoping stays KEYLESS (no reconstruction needed to consult the posture).
  const scoped = !!opts.scoped;
  const scopedIds = opts.scopedIds || null;
  if (scoped) out.scoped = true;
  const seen = new Set();
  for (const s of D.listSnapshots(p)) {
    if (!s.attest) continue;                                   // never attested — no baseline capability to compare
    if (s.codeTreeHash && seen.has(s.codeTreeHash)) continue;  // dedup identical trees
    if (s.codeTreeHash) seen.add(s.codeTreeHash);
    const orig = A.loadAttestation(p, config, s.attest);
    const origCap = orig ? orig.capability : null;
    if (!origCap || origCap === cur) continue;                 // already at the current capability
    if (covered[s.attest]) continue;                           // a current-capability reverification covers it
    if (scoped) {
      const ev = (orig && orig.evidence) || {};
      const inScope = Object.keys(ev).some((id) => scopedIds && scopedIds.has(id));
      if (!inScope) continue;                                  // no in-scope Cell in this state — grandfathered
    }
    out.pending.push({ at: s.at, attest: s.attest, fromCapability: origCap, codeTreeHash: s.codeTreeHash });
  }
  out.satisfied = out.pending.length === 0;
  return out;
}

module.exports = { reverifyState, reverifySweep, reverificationObj, classify, reverifyPosture, reverifyGate };
