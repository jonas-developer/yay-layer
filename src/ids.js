'use strict';
// Cell-id scheme for distributed (multi-branch / multi-clone) work.
//
// The problem: a bare sequential counter (C-001, C-002…) assumes ONE writer — two branches mint
// the same ids and collide on merge. And the id is part of the signed seal (items[id]=specHash),
// so renumbering after the fact invalidates the seal. So we prevent collisions AT CREATION with a
// short, stable per-CONTRIBUTOR shard: ids look like C-<shard>-<n> (e.g. C-3f2a-7). Two clones get
// different shards → new cells from different people NEVER collide, no renumber, no re-sign.
//
// And numbers are MONOTONIC / never reused: `taken` includes every id that ever appeared in the
// ledger, so a deleted feature's id is retired forever — an id always means one cell, like a git
// commit hash. Deletions leave permanent gaps, which is correct for an audit trail.

const C = require('./crypto');

// A short shard derived from a seed — the signer/root key fingerprint when available (stable and
// identity-tied), else random. 4 hex chars ≈ 65k space, so two contributors practically never coincide.
function deriveShard(seed) {
  const hex = C.sha256(String(seed == null ? ('r' + Date.now() + Math.random()) : seed));
  return hex.slice(0, 4);
}

// Highest counter already used for `shard` across a set of ids (current cells ∪ ledger history).
function maxForShard(ids, shard) {
  let mx = 0; const re = new RegExp('^C-' + String(shard).replace(/[^a-z0-9]/gi, '') + '-(\\d+)$');
  const each = (id) => { const m = String(id).match(re); if (m) { const v = parseInt(m[1], 10); if (v > mx) mx = v; } };
  if (ids && typeof ids.forEach === 'function') ids.forEach(each); else for (const id of (ids || [])) each(id);
  return mx;
}

// The next monotonic, sharded id. `taken` (a Set) should include current cell ids AND all historical
// ledger ids, so a deleted-but-once-used id is never handed out again.
function nextCellId(shard, taken) {
  let n = maxForShard(taken, shard) + 1, id;
  do { id = 'C-' + shard + '-' + n; n++; } while (taken && taken.has && taken.has(id));
  if (taken && taken.add) taken.add(id);
  return id;
}

module.exports = { deriveShard, maxForShard, nextCellId };
