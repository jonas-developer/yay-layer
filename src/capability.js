'use strict';
// VERIFIER CAPABILITY — the verifier's own versioned identity, DERIVED from what it can actually
// detect and prove, so the declared version can't drift from reality.
//
// The problem this closes: `CAPABILITY` is a semver a human bumps by hand. If someone adds a prover,
// an effect net, or a check but forgets to bump it, an attestation would claim capability 1.0.0 while
// the verifier is really doing more (or, after a semantics change, something different) — a silent,
// unversioned claim. So we compute a FINGERPRINT over a machine-derived descriptor of the live
// capabilities and REGISTER the expected fingerprint per version. `assertCapability()` compares the
// two; `yay attest` refuses on drift and tells you to bump + re-register. A shipped package never
// drifts (its code and registry match); only a *modified* verifier does — exactly when we want the
// guard to fire.

const { sha256 } = require('./crypto');
const { canonical } = require('./util');
const { ADAPTERS } = require('./prove');
const { effectNetDescriptor } = require('./verify');

// Declared capability version (PATCH = bug fix, same verdicts · MINOR = new detectors/provers, a
// verdict may improve · MAJOR = a semantics change that can flip existing verdicts). Bump this AND
// re-register the fingerprint (below) whenever `describeCapability()` changes.
const CAPABILITY = '1.1.0';

// Checks the verifier runs on a passing Cell, and the policy rule kinds it understands. Listed
// explicitly (and hashed) so adding/removing one is a visible, version-forcing change. Provers and
// effect nets are pulled from the live code, so those shift the fingerprint on their own.
const CHECKS = ['branch-coverage', 'ensures-prover', 'inertness', 'jsx-render-prover', 'literal-seeding', 'mutation-grading', 'predicate-provenance'];
const POLICY_KINDS = ['coverage-full', 'ignore-source', 'inert-level', 'non-delegable', 'predicate-declared', 'required-signer'];

// A structured, machine-derived description of everything the verifier can currently do.
function describeCapability() {
  return {
    v: 1,
    provers: ADAPTERS.map((a) => a.name).sort(),   // ← live: adding an adapter changes this
    effectNets: effectNetDescriptor(),             // ← live: adding a net / signal changes this
    checks: CHECKS.slice().sort(),
    policyKinds: POLICY_KINDS.slice().sort(),
  };
}

// A stable hash over the descriptor — the verifier's capability fingerprint.
function capabilityFingerprint() { return sha256(canonical(describeCapability())); }

// The fingerprint expected for each declared version. The entry for the CURRENT CAPABILITY must
// equal the live fingerprint; if it doesn't, the code changed without a version bump.
const REGISTERED = {
  '1.0.0': '1579c1ec83344596b4e3de93162ac7062d9846e0bd9793c7969b1fe3064e1aa1',
  '1.1.0': '1d2a74604dcffc789bf7de6ee98f9368fee68241ea7aafcb87c57c858167388c',
};

// Compare the live fingerprint to the one registered for the declared version.
function assertCapability() {
  const actual = capabilityFingerprint();
  const expected = REGISTERED[CAPABILITY] || null;
  return { ok: expected === actual, declared: CAPABILITY, expected, actual, drift: expected !== actual };
}

module.exports = { CAPABILITY, describeCapability, capabilityFingerprint, assertCapability, REGISTERED };
