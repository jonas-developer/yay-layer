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

module.exports = { reverifyState };
