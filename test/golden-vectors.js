'use strict';
// Golden vectors — freeze the load-bearing crypto/canonicalisation invariants. If any of these change,
// EVERY previously-signed spec, seal, and attestation silently stops verifying — the worst possible
// regression for a trust tool. These frozen values are the contract a future version (or a second
// implementation) must reproduce byte-for-byte. If one breaks, that's a deliberate, breaking-change
// decision (a MAJOR bump + re-sign), never an accident.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../src/crypto');
const { canonical } = require('../src/util');
const { buildManifest } = require('../src/manifest');

let n = 0;
const eq = (got, want, msg) => { n++; assert.strictEqual(got, want, msg + `\n    got:  ${got}\n    want: ${want}`); console.log('  ✓ ' + msg); };
const ok = (cond, msg) => { n++; assert.ok(cond, msg); console.log('  ✓ ' + msg); };

// ── 1. SHA-256 is real SHA-256 (well-known vectors) ──
eq(C.sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'sha256("") = the canonical empty-string digest');
eq(C.sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256("abc") = the canonical NIST vector');

// ── 2. Canonicalisation is stable (deterministic key ordering) ──
// Keys sorted; arrays preserve order. Attestations + seals hash canonical(obj), so this ordering is law.
const OBJ = { b: 2, a: 1, nested: { y: [3, 1, 2], x: 'hi' } };
eq(canonical(OBJ), '{"a":1,"b":2,"nested":{"x":"hi","y":[3,1,2]}}', 'canonical() sorts keys, preserves array order');
eq(C.sha256(canonical(OBJ)), '2bffac39531af657a3dd2e38b1444a69ea0e12d23bf9a6929205b1fda2eb885c', 'sha256(canonical(obj)) is frozen');

// ── 3. ed25519 sign/verify — a fixed keypair produces a fixed signature (RFC 8032 is deterministic) ──
const PUB_B64 = 'MCowBQYDK2VwAyEA7rZr+E3O3EjkGJ8VF0q/Pci2owxP2lJ+QQxeUf5rVeI=';
const PRIV_B64 = 'MC4CAQAwBQYDK2VwBCIEIFbYsRAZ8MZfaPby4gMiWmkA0o9FTmXPRQzp4CeDxdVx';
const MSG = 'yaylayer-golden-vector-v1';
const SIG_B64 = '656rqdDihux6yXSuFTmRONRYwTWJZXl4eXQlIFFnqeWjkyoJ8v6iiS/BFrajKX1yrM/eNBrD1TArzX1FlfWgDg==';
const privDer = Buffer.from(PRIV_B64, 'base64');
eq(C.sign(MSG, privDer), SIG_B64, 'ed25519 signature over a fixed key+message is byte-for-byte stable');
ok(C.verify(MSG, SIG_B64, PUB_B64) === true, 'the frozen signature verifies under its public key');
ok(C.verify(MSG + '!', SIG_B64, PUB_B64) === false, 'a tampered message fails verification');
ok(C.verify(MSG, SIG_B64, PUB_B64.slice(0, -3) + 'AAA') === false, 'a wrong public key fails verification');

// ── 4. specHash — the exact bytes a seal signs → a frozen hash ──
// Raw spec-block bytes (not via any test helper), so this catches drift in the verifier's own
// extraction/normalisation, which is what old seals depend on.
const SPEC = '//∷YAY⟨C-1⟩\n// unit: add\n// intent: add two numbers\n// in: a: number, b: number\n// out: number\n// ensures: out === a + b\n// pure: yes\n//∷YAY-END⟨C-1⟩\nfunction add(a, b) { return a + b; }\n';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yay-gv-'));
try {
  fs.writeFileSync(path.join(dir, 'm.js'), SPEC);
  const m = buildManifest(dir);
  eq(m.cells['C-1'] && m.cells['C-1'].specHash, '8fb89d2f57f364c0e9d8c5295346cab13e51a79f646f5748cca0c08c0b05cdaf', 'specHash of a fixed spec block is frozen (seals stay verifiable)');
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
}

console.log('\nGolden vectors: all ' + n + ' checks passed.');
