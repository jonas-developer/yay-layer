# Reference (deeper specs)

> **Status: to be finalized during implementation.** These specs firm up as the code is built (P2–P4). Writing them in full now would just create rot, so they start as stubs and are filled in *alongside* the engine — that's the docs-and-code-together rule from [Decision D18](../10-decision-log.md).

- [attestation-schemas.md](attestation-schemas.md) — canonical JSON shapes for the human-authorization, verification, grant, and ratification objects; canonicalization + hashing rules.
- [object-store-layout.md](object-store-layout.md) — the `.yaylayer/objects/` content-addressed layout, the git-bundle archive format for Durable mode, and the append-only event/hash-chain format.
