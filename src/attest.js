'use strict';
// P2 — VERIFIER ATTESTATION. The third cryptographic identity (after artifact hashes and the
// human phone signature): the machine verifier signs its OWN verdict with its OWN key, so "Green"
// stops being a local, unfalsifiable claim and becomes a portable, verifiable object — "Green
// under THIS verifier + environment at this time" (see docs 02, 03; decisions D3, D5, D13, D16).
//
// Separation of duties (D1): the verifier key is DISTINCT from any human/owner key and from the
// machine grant key. It is project/CI-scoped and MACHINE-HELD (private half gitignored in
// .yaylayer/keys/, never committed, NEVER shipped in the npm package — D11); only its PUBLIC key
// is committed (config.verifier), so anyone can verify an attestation without being able to forge
// one. A fresh clone / a CI runner without the secret can VERIFY attestations but cannot MINT them.
//
// "Green is an event" (D5): attestations are append-only. Each references the previous one's hash;
// a better verifier appends new attestations (P4 `yay reverify`), never rewrites old ones. The
// verifier carries a CAPABILITY VERSION (PATCH/MINOR/MAJOR) recorded in every attestation, so a
// capability bump is a first-class, dated event.

const fs = require('fs');
const path = require('path');
const os = require('os');
const C = require('./crypto');
const { canonical } = require('./util');
const rosterMod = require('./roster');

// The verifier's capability version. Bump on a change to what the verifier can DETECT/PROVE:
//   PATCH = bug fix, same verdicts;  MINOR = new detectors/provers (a Yellow may become Green/Red);
//   MAJOR = a semantics change that can flip existing verdicts. Recorded in every attestation so
//   old Green can be re-verified against a newer capability (P4) without rewriting history.
const CAPABILITY = '1.0.0';

function pkgVersion() {
  try { return require('../package.json').version || '0.0.0'; } catch (_) { return '0.0.0'; }
}

function verifierKeyPath(p) { return path.join(p.keys, 'verifier.json'); }
function attestPath(p) { return path.join(p.yay, 'attest.json'); }
function attDir(p) { return path.join(p.yay, 'attestations'); }
function attFile(p, hash) { return path.join(attDir(p), String(hash) + '.json'); }

// Ensure a project verifier identity exists. The private half lives machine-side (gitignored keys/);
// the public half is mirrored into config.verifier (committed) as the project's verifier of record.
// `create` false → return null instead of generating (used by pure verification / read paths).
function verifierIdentity(p, config, opts) {
  const create = !opts || opts.create !== false;
  const kp = verifierKeyPath(p);
  let rec = null;
  try { rec = JSON.parse(fs.readFileSync(kp, 'utf8')); } catch (_) { rec = null; }
  if (!rec) {
    if (!create) return null;
    const gk = C.generateKeypair();
    rec = { pub: gk.pubB64, priv: Buffer.from(gk.privDer).toString('base64'), createdAt: new Date().toISOString() };
    fs.mkdirSync(p.keys, { recursive: true });
    fs.writeFileSync(kp, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
  }
  return { pub: rec.pub, privDer: Buffer.from(rec.priv, 'base64'), fp: rosterMod.fingerprint(rec.pub) };
}

// The public verifier of record for this project: config.verifier.pub if pinned (committed),
// else the local key's public half. Used to VERIFY attestations (needs no private key).
function verifierPub(p, config) {
  if (config && config.verifier && config.verifier.pub) return config.verifier.pub;
  const id = verifierIdentity(p, config, { create: false });
  return id ? id.pub : null;
}

// Pin the local verifier's PUBLIC key into config (committed) as the project verifier of record.
// Returns true if config changed (caller writes it).
function pinVerifier(config, id) {
  config.verifier = config.verifier || {};
  const changed = config.verifier.pub !== id.pub || config.verifier.capability !== CAPABILITY;
  config.verifier.pub = id.pub;
  config.verifier.fp = id.fp;
  config.verifier.capability = CAPABILITY;
  return changed;
}

// ── the canonical Verification object (what gets hashed + signed) ──────────────────────────────
// A deterministic digest of exactly the inputs and outputs of a verification run:
//   specSetHash  — the set of signed spec identities (per-Cell specHash)
//   codeTreeHash — the exact code that was judged (per-Cell body hash)
//   rulesetHash  — the signing/inertness policy in force (verdicts depend on it)
//   evidenceHash — the per-Cell verdict + whether it was machine-proven
//   result       — the gate summary (passed + colour counts)
//   env          — recorded for determinism honesty (D16): same verifier can differ across
//                  environments only on timing-sensitive cases; the attestation says so.
// The leaf Cells (specs, not modules) in stable order — the unit of both spec-set and code-tree.
function leafIds(manifest) {
  const cells = manifest.cells || {};
  return Object.keys(cells).filter((id) => !(cells[id].contains && cells[id].contains.length)).sort();
}

// Hash of the exact code that was (or would be) judged — per-leaf-Cell body. Cheap: needs only the
// manifest, so callers (e.g. `yay sign`) can test "does an attestation cover this exact tree?"
// without re-running the full verifier.
function codeTreeHashOf(manifest) {
  const cells = manifest.cells || {};
  const codeTree = {};
  for (const id of leafIds(manifest)) codeTree[id] = C.sha256(String(cells[id].unitBody || ''));
  return C.sha256(canonical(codeTree));
}

function buildVerification(manifest, verified, opts) {
  opts = opts || {};
  const cells = manifest.cells || {};
  const results = (verified && verified.results) || {};
  const leaves = leafIds(manifest);

  const specSet = {};
  const codeTree = {};
  const evidence = {};
  for (const id of leaves) {
    const c = cells[id];
    specSet[id] = c.specHash || null;
    codeTree[id] = C.sha256(String(c.unitBody || ''));
    const r = results[id] || {};
    evidence[id] = { state: r.state || 'UNSIGNED', proven: !!r.proven };
    // Record the branch-coverage boundary of a proof, so the signed verdict is honest about
    // how much of the code its inputs actually exercised (not just "proven").
    if (r.coverage && r.coverage.total) evidence[id].branches = { exercised: r.coverage.exercised, total: r.coverage.total };
  }
  const counts = (verified && verified.counts) || {};
  const result = {
    passed: !!(verified && verified.passed),
    counts: { GREEN: counts.GREEN || 0, YELLOW: counts.YELLOW || 0, RED: counts.RED || 0, UNSIGNED: counts.UNSIGNED || 0, PINK: counts.PINK || 0 },
    proven: counts.proven || 0,
  };
  return {
    v: 1,
    kind: 'verification',
    project: (opts.config && opts.config.project) || null,
    capability: CAPABILITY,
    verifierPkg: pkgVersion(),
    specSetHash: C.sha256(canonical(specSet)),
    codeTreeHash: C.sha256(canonical(codeTree)),
    rulesetHash: C.sha256(canonical(opts.policy || { rules: [] })),
    rootFp: (verified && verified.rootFp) || null,
    evidenceHash: C.sha256(canonical(evidence)),
    evidence, // per-Cell {state,proven} — small, self-describing, and lets `yay reverify` diff verdicts across capability versions
    cells: leaves.length,
    result,
    env: { node: process.version, platform: os.platform() + '/' + os.arch() },
    at: opts.at || new Date().toISOString(),
  };
}

// Sign a verification object with the verifier key → a self-contained attestation. `hash` and the
// signature both cover the SAME canonical bytes of the bare verification object, so a verifier
// re-canonicalises {everything except hash/verifier/signature} and checks both.
function signAttestation(verObj, id) {
  const bytes = canonical(verObj);
  const hash = C.sha256(bytes);
  const signature = C.sign(bytes, id.privDer);
  return Object.assign({}, verObj, { hash, verifier: { pub: id.pub, fp: id.fp }, signature });
}

// Recompute the canonical bytes of an attestation's verification core (strip the wrapper fields).
function coreBytes(att) {
  const core = Object.assign({}, att);
  delete core.hash; delete core.verifier; delete core.signature; delete core.prev;
  return canonical(core);
}

// Validate an attestation: its hash matches its core, the signature verifies under its embedded
// verifier key, and (if a project verifier is pinned) that key IS the project's verifier of record.
function verifyAttestation(att, expectedPub) {
  if (!att || !att.verifier || !att.signature) return { ok: false, reason: 'not an attestation' };
  const bytes = coreBytes(att);
  if (C.sha256(bytes) !== att.hash) return { ok: false, reason: 'hash does not match content (tampered)' };
  if (!C.verify(bytes, att.signature, att.verifier.pub)) return { ok: false, reason: 'bad verifier signature' };
  if (expectedPub && att.verifier.pub !== expectedPub) return { ok: false, reason: 'signed by a different verifier than the project verifier of record' };
  return { ok: true };
}

// Append-only attestation ledger (committed). Each entry references the previous hash → a chain
// anchored by the project verifier. The full attestation object is stored content-addressed in
// objects/ (keyed by its own hash); the ledger keeps the ordered index.
function loadLedger(p, config) {
  const led = (function () { try { return JSON.parse(fs.readFileSync(attestPath(p), 'utf8')); } catch (_) { return null; } })();
  return led || { project: (config && config.project) || null, capability: CAPABILITY, entries: [] };
}

function appendAttestation(p, config, att) {
  const led = loadLedger(p, config);
  const prev = led.entries.length ? led.entries[led.entries.length - 1].hash : 'genesis';
  att.prev = prev;
  // Persist the full attestation (committed), keyed by its own attestation hash. The tamper check
  // is verifyAttestation() — stronger than a raw sha256(content) check because it also re-validates
  // the verifier signature. The ledger keeps the ordered, chained index.
  fs.mkdirSync(attDir(p), { recursive: true });
  fs.writeFileSync(attFile(p, att.hash), JSON.stringify(att, null, 2) + '\n');
  led.entries.push({ hash: att.hash, at: att.at, passed: att.result.passed, capability: att.capability, codeTreeHash: att.codeTreeHash, prev });
  led.capability = CAPABILITY;
  fs.mkdirSync(path.dirname(attestPath(p)), { recursive: true });
  fs.writeFileSync(attestPath(p), JSON.stringify(led, null, 2) + '\n');
  return att;
}

// Load a stored attestation by its hash, re-validating signature + integrity before returning it
// (null if missing or tampered — never hand back an unverified attestation).
function loadAttestation(p, config, hash) {
  let att = null;
  try { att = JSON.parse(fs.readFileSync(attFile(p, hash), 'utf8')); } catch (_) { return null; }
  const chk = verifyAttestation(att, verifierPub(p, config));
  return chk.ok ? att : null;
}

function latestEntry(p, config) {
  const led = loadLedger(p, config);
  return led.entries.length ? led.entries[led.entries.length - 1] : null;
}

module.exports = {
  CAPABILITY, verifierKeyPath, attestPath, attDir, attFile, verifierIdentity, verifierPub, pinVerifier,
  buildVerification, codeTreeHashOf, leafIds, signAttestation, verifyAttestation, coreBytes,
  loadLedger, appendAttestation, loadAttestation, latestEntry,
};
