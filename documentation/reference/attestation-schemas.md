# Reference — Attestation schemas

> **Status: TO BE FINALIZED DURING IMPLEMENTATION (P2+).** Sketch only; the authoritative shapes land with the code.

Will define, with exact fields, canonicalization, and hashing/signing rules:

1. **Human authorization object** (forward sign) — signer, timestamp, Brief hash, spec-set (per-Cell specHashes). Signed: phone key.
2. **Grant object** — repository, starting tree, expiry, capability envelope (allowed/prohibited/deps/max-cells/risk/deployment/child-grants), constraints the current verifier can enforce. Signed: owner phone key.
3. **Verification attestation** — spec-set hash, code-tree hash, verifier package (version + bytes digest), ruleset (version + digest), cell schema, mutation engine, config hash, evidence manifest (static / mutation / prover / test, each hashed), result, timestamp, platform assumptions. Hashed → attestation hash. Signed: **verifier key** (project/CI-scoped; never shipped in the package).
4. **Ratification object** — human, time, ratified operation id, approved intent (Brief + spec-set), reviewed implementation (code-tree hash), verification observed (attestation hash), reviewed-bundle hash (TOCTOU). Signed: phone key.
5. **Tombstone object** — content hash, status `deliberately removed`, deletion timestamp, reason, remover. Part of the append-only chain.

Canonicalization reuses the existing `util.canonical` scheme (same as `roster.eventBytes`). Each event also carries `previous_event_hash` and `event_hash = hash(previous_event_hash + attestation_hash + metadata)`.
