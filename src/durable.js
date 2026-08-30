'use strict';
// P4 — DURABLE MODE + governance. Standard mode keeps specs/attestations/grants forever (the tiny
// bespoke sha256 store) and leans on git for the bulk SOURCE. Durable mode additionally keeps an
// encrypted, self-contained archive of the signed source, so "what the code actually was when it was
// signed" survives even if git history is lost, rebased, or the remote disappears (regulated / audit
// settings). Per the locked design (D10, D12):
//   • Trust anchor = OUR sha256 over the PLAINTEXT bytes (not git SHA-1) — content-addressed.
//   • Source is encrypted AES-256-GCM under a PROJECT-HELD key YayLayer never stores (from
//     $YAY_ARCHIVE_KEY or a passphrase, scrypt-derived). We hold ciphertext + clear, signed metadata.
//   • Metadata (cell id, file, plaintext hash, size, time) stays CLEAR + signed → auditable without
//     decrypting; only the body is sealed.
//   • Pre-archive SECRET SCAN → refuse to seal code containing obvious secrets (they'd be preserved
//     forever). Deletion is honest: a signed TOMBSTONE replaces a blob, never a silent rewrite.
//
// This is a self-contained encrypted store (the bespoke core extended to code). A git-bundle bulk
// transport is a later storage optimization; the guarantees above are what Durable mode promises.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const C = require('./crypto');
const { canonical } = require('./util');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function archiveDir(p) { return path.join(p.yay, 'archive'); }
function archiveManifestPath(p) { return path.join(p.yay, 'archive.json'); }
function blobPath(p, hash) { const h = String(hash); return path.join(archiveDir(p), h.slice(0, 2), h.slice(2)); }

// Resolve the project-held archive key. From $YAY_ARCHIVE_KEY (raw or base64) or a passphrase
// (scrypt with a per-project salt kept in the archive manifest). Returns a 32-byte Buffer. YayLayer
// never persists the key or passphrase.
function resolveKey(passphrase, salt) {
  const env = process.env.YAY_ARCHIVE_KEY;
  if (env) { const b = Buffer.from(env, /^[A-Za-z0-9+/=]+$/.test(env) && env.length >= 43 ? 'base64' : 'utf8'); return b.length === 32 ? b : crypto.scryptSync(env, salt || 'yay-archive', SCRYPT.keylen, SCRYPT); }
  if (!passphrase) throw new Error('Durable archive needs a key — set $YAY_ARCHIVE_KEY or pass a passphrase (never stored by YayLayer).');
  return crypto.scryptSync(passphrase, salt || 'yay-archive', SCRYPT.keylen, SCRYPT);
}

function encryptBlob(plaintext, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return { v: 1, alg: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ct: ct.toString('base64') };
}
function decryptBlob(blob, key) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'base64'));
  d.setAuthTag(Buffer.from(blob.tag, 'base64'));
  try { return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8'); }
  catch (_) { throw new Error('wrong archive key, or the blob is corrupt'); }
}

// ── pre-archive secret scan ────────────────────────────────────────────────────────────────────
// Conservative: catch the obvious, high-confidence leaks (a false miss is better than crying wolf on
// every file, but these patterns are specific enough to rarely false-positive). Returns [{line,kind}].
const SECRET_PATTERNS = [
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/],
  ['generic api/secret assignment', /\b(?:api[_-]?key|secret|token|passwd|password)\b\s*[:=]\s*['"][^'"]{12,}['"]/i],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['bearer/JWT-ish', /\bey[JA][0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{6,}\b/],
];
function secretScan(text) {
  const out = [];
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    for (const [kind, re] of SECRET_PATTERNS) { if (re.test(lines[i])) out.push({ line: i + 1, kind }); }
  }
  return out;
}

function loadArchive(p) {
  try { return JSON.parse(fs.readFileSync(archiveManifestPath(p), 'utf8')); } catch (_) { return null; }
}
function saveArchive(p, arc) { fs.mkdirSync(p.yay, { recursive: true }); fs.writeFileSync(archiveManifestPath(p), JSON.stringify(arc, null, 2) + '\n'); }

// Archive one plaintext body: anchor by sha256(plaintext), encrypt, write the blob. Idempotent
// (same content → same anchor → write-once). Returns { hash, size, existed }.
function putBlob(p, plaintext, key) {
  const hash = C.sha256(String(plaintext));
  const bp = blobPath(p, hash);
  const existed = fs.existsSync(bp);
  if (!existed) { fs.mkdirSync(path.dirname(bp), { recursive: true }); fs.writeFileSync(bp, JSON.stringify(encryptBlob(plaintext, key))); }
  return { hash, size: Buffer.byteLength(plaintext, 'utf8'), existed };
}
// Read + decrypt a blob by its plaintext anchor; verifies the decrypted bytes re-hash to the anchor.
function getBlob(p, hash, key) {
  const bp = blobPath(p, hash);
  if (!fs.existsSync(bp)) return null;
  const blob = JSON.parse(fs.readFileSync(bp, 'utf8'));
  const pt = decryptBlob(blob, key);
  if (C.sha256(pt) !== String(hash)) throw new Error('archive blob failed its content check (anchor mismatch) — tampered');
  return pt;
}

// Replace a blob with a signed TOMBSTONE — honest erasure that never rewrites history: the entry
// stays, its status becomes "deliberately removed" with who/when/why. The ciphertext is deleted.
function tombstone(p, hash, reason, signer) {
  const bp = blobPath(p, hash);
  try { if (fs.existsSync(bp)) fs.unlinkSync(bp); } catch (_) {}
  return { contentHash: String(hash), status: 'deliberately removed', deletedAt: new Date().toISOString(), reason: reason || null, by: signer || null };
}

// ── reconstructable snapshots (the reverify substrate) ──────────────────────────────────────────
// Blobs are content-addressed and never deleted, but arc.files only holds the LATEST path→hash map,
// so a HISTORICAL tree can't be rebuilt without an index of "which blobs composed the tree at moment N".
// recordSnapshot captures exactly that — the file→blob-hash map for one archived state, tied to the
// verification it captured (codeTreeHash + the attestation hash). This is capture-going-forward: only
// states archived after this exists become fully reconstructable. Append-only, deduped by codeTreeHash.
function recordSnapshot(p, snap) {
  const arc = loadArchive(p);
  if (!arc) return null;
  arc.snapshots = arc.snapshots || [];
  const dup = arc.snapshots.find((s) => s.codeTreeHash && s.codeTreeHash === snap.codeTreeHash && s.specSetHash === (snap.specSetHash || s.specSetHash));
  if (dup) return dup;
  const rec = {
    at: snap.at || null,
    codeTreeHash: snap.codeTreeHash || null,
    specSetHash: snap.specSetHash || null,
    attest: snap.attest || null,
    capability: snap.capability || null,
    files: snap.files || {},
  };
  arc.snapshots.push(rec);
  saveArchive(p, arc);
  return rec;
}
function listSnapshots(p) { const arc = loadArchive(p); return (arc && arc.snapshots) || []; }

// Materialize a snapshot's exact source into destDir from the encrypted blobs. Throws on a
// tombstoned/missing/tampered blob (getBlob anchor-checks). Returns { dir, files: [rel…] }.
function reconstructSnapshot(p, snap, key, destDir) {
  const files = (snap && snap.files) || {};
  const written = [];
  for (const rel of Object.keys(files)) {
    const hash = files[rel];
    const pt = getBlob(p, hash, key);
    if (pt == null) throw new Error('cannot reconstruct — blob ' + String(hash).slice(0, 12) + '… for ' + rel + ' is missing or tombstoned');
    const abs = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, pt);
    written.push(rel);
  }
  return { dir: destDir, files: written };
}

module.exports = {
  archiveDir, archiveManifestPath, blobPath, resolveKey, encryptBlob, decryptBlob,
  secretScan, SECRET_PATTERNS, loadArchive, saveArchive, putBlob, getBlob, tombstone,
  recordSnapshot, listSnapshots, reconstructSnapshot,
};
