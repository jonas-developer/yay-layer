# Reference — Object-store layout

> **Status: TO BE FINALIZED DURING IMPLEMENTATION (P1/P4).** Sketch only.

Will define the on-disk layout and formats:

1. **`.yaylayer/objects/` — bespoke content-addressed store** (sha256) for the tiny audit-core objects: spec blocks, verification attestations, evidence manifests, grant/ratification/tombstone objects. Layout `objects/<first2>/<rest>`, deduped. This is what makes the "as signed" spec never blank (read store-first; git is fallback).

2. **Durable-mode code archive** — a **git bundle / shared incremental pack** holding the relevant tree+blobs. **Our sha256 over the archived bytes is the trust anchor** (not git's SHA-1). One shared incremental pack (never a bundle-per-approval, which loses dedup). Encrypted at rest (AES-256-GCM, project-held key) per [Governance](../02-provenance-architecture.md#governance--designed-in-not-bolted-on).

3. **Append-only event ledger** — extends today's `prev`-chained `lock.json`; each event references `previous_event_hash`; Cell **revisions** are immutable and approvals reference a revision id.

4. **Encryption envelope** — how ciphertext blobs, plaintext-hashes (kept clear for integrity), and key references (KMS / age / passphrase) are laid out so the chain verifies without decrypting content.
