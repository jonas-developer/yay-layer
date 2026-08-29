'use strict';
// Append-only, content-addressed store in `.yaylayer/objects/` — the audit core that must never
// blank. Objects are keyed by their own sha256 (hex), laid out git-style as objects/<first2>/<rest>,
// deduped (identical content stored once). Spec blocks are archived here at sign time (keyed by
// their specHash), so "as signed" reconstruction NEVER depends on git surviving. Committed with
// the repo. (P2 will store signed verification attestations here too; P4 adds the Durable code
// archive alongside.) Small + tiny volume, so no packing/GC needed — that's why it's bespoke here
// while bulk code archival (Durable) leans on git.
const fs = require('fs');
const path = require('path');
const { sha256 } = require('./crypto');

const YAY_DIR = '.yaylayer';
function objRoot(root) { return path.join(root, YAY_DIR, 'objects'); }
function objPath(root, hash) { const h = String(hash); return path.join(objRoot(root), h.slice(0, 2), h.slice(2)); }

// Store `content`, keyed by its sha256; returns the hash. Idempotent (write-once). Best-effort:
// the seal in lock.json remains the source of truth, so a failed archive write never blocks signing.
function putObject(root, content) {
  const s = String(content); const h = sha256(s); const p = objPath(root, h);
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); if (!fs.existsSync(p)) fs.writeFileSync(p, s); } catch (_) { /* best effort */ }
  return h;
}
// Read the object with this hash, but only if its content still hashes to the key (tamper check).
function getObject(root, hash) {
  try { const p = objPath(root, hash); if (!fs.existsSync(p)) return null; const c = fs.readFileSync(p, 'utf8'); return sha256(c) === String(hash) ? c : null; }
  catch (_) { return null; }
}
function hasObject(root, hash) { try { return fs.existsSync(objPath(root, hash)); } catch (_) { return false; } }

module.exports = { objRoot, objPath, putObject, getObject, hasObject };
