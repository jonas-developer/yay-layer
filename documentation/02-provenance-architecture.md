# 02 — Provenance architecture

This is the durable-audit heart of YayLayer — shipped in 1.0 (spec archive, verifier attestation, reverify, integrity witness, Durable mode). The design principle everything serves:

> **Every statement material to an approval remains reconstructable forever unless an explicit retention policy says otherwise — and nothing is ever silently rewritten.**

YayLayer offers this at **two levels** — a per-project choice made at setup, compared in full under [Standard vs Durable](#standard-vs-durable) below. In short:

- **Standard** *(default)* — YayLayer archives the specs and attestations; the **code** at each point is referenced by git.
- **Durable** — the code is *additionally* archived (encrypted) inside the project's own store, so the record survives even if git is lost or rewritten.

They differ **only in how code is stored** — everything else in this section holds either way. So when the text below says "in both Standard and Durable," that's what it means.

## The provenance chain

An approval is not a single fact; it's a chain of authority and evidence:

```
Human Grant G42                      (authority: "what the agent may do")
   └─ Delegated operation A81        (or a direct forward sign)
        ├─ Brief B17
        ├─ Spec Set S91  (exact Cell revisions)
        └─ Code Tree T93
             └─ Verification V22     (verifier 1.8.4, ruleset 3, evidence E72 → GREEN)
                  └─ Human Ratification R12   (Alice, references V22's hash)
```

Every node is an **immutable, content-addressed object**. Nothing in this chain is mutated; corrections and re-verifications are **new** events.

## Three levels of history

| What's retained | Audit strength | Our stance |
|-----------------|----------------|------------|
| Brief only | Low | Insufficient — decision history only |
| Brief + exact Cells | Medium | **Minimum we ship** |
| Brief + Cells + implementation identity + verifier evidence | High | **The target** |

## Preserve every historical spec — always

✅ 1.0. Specs are tiny; deleting them destroys information that can't be reconstructed. So **every** signed Cell spec is archived (content-addressed in `.yaylayer/objects/`), in **both** Standard and Durable modes. This is what kills the "history comes back blank" problem: the "as signed" spec never depends on git being intact.

- On sign, the normalized spec block is written to a content-addressed store keyed by its **specHash** (the hash the seal already signs).
- The history lens reads the spec **store-first**; git is a fallback/cross-check, not the source of truth.
- Integrity is free: the stored body must hash to the signed specHash, so it's tamper-evident against the seal without being separately signed.

> This replaces today's git-only reconstruction (`src/history.js`, ✅ shipped), which can blank on a rename, squash, or lost commit.

## Two capture points

The two chains have **two birthdays** — state this explicitly or attestation timing is ambiguous:

- **Human authorization** mints at **sign** (forward) — the code doesn't exist yet under Architecture A.
- **Verifier attestation** mints at **commit / verify-pass** — the code exists then.

(Ratification is the exception where a human signs *after* code exists — see [03](03-autopilot-delegated-execution.md).)

## Verifier attestation

✅ 1.0 (`yay attest`). `yay verify` is *ephemeral* — re-derived every run. The attestation makes a "Green" a durable, **signed** fact. Minted at commit/verify-pass, it records:

```
Verification V22
  spec-set hash        sha256:S91…
  code-tree hash       sha256:T93…
  verifier package     yay-layer 1.8.4  + sha256:91ab…   (bytes, not just the version string)
  ruleset              v3 + sha256:f73c…
  cell schema          2
  mutation engine      1.4.2
  config hash          sha256:8ca2…
  evidence manifest    { static: …, mutation: …, prover: …, tests: … }  (each hashed separately)
  result               GREEN
  timestamp            2026-08-29T11:42:17Z
```

Then the whole record is canonicalized, **hashed**, and **signed by the verifier's own key**:

- A **hash** proves "these bytes haven't changed."
- A **signature** proves "the trusted verifier produced this" — so a malicious agent can't fabricate a `GREEN` record (it could compute a valid hash for a fake, but not the verifier's signature).

The human ratification then references `V22`'s attestation hash, tying the person to the exact result they saw. See [07 — Security model](07-security-model.md) for the **verifier-key-never-in-package** rule.

## Verifier versioning

✅ Shipped. The verifier is a **versioned participant** in provenance. "Green" always expands to "Green under these exact semantics." Consequences:

- Release notes classify upgrades by *capability*, not just SemVer: **PATCH** (bug fix, semantics unchanged) · **MINOR** (new reasoning; may strengthen evidence) · **MAJOR** (meaning of Green materially changed; historical re-verification recommended).
- A stronger verifier can **re-verify history** with `yay reverify --all`: reconstruct every preserved (Durable) state, re-run today's verifier over it, and diff each Cell against its original verdict — a **keyless upgrade report**. `--attest` records each re-assessment as a **new immutable event beside the old** (`2026 → GREEN under 1.0.0` and `2029 → YELLOW under 4.2.0` both remain true — the old Green is **never** rewritten).
- Re-verification is **not** an automatic CI failure. *Historical verification status* is separate from *current policy compliance*: the **reverification posture** (`yay reverify posture off|guarded|strict` — off grandfathers history, guarded warns, strict blocks until re-verified) configures grandfathering, scopeable to crown-jewel Cells with an owner-signed `{ "match": {…}, "reverify": "latest" }` rule. It gates on whether the signed record **exists** — never on holding a key.
- This turns verifier improvements into a **compounding asset** — every improvement can raise confidence in the *historical* codebase, not just new code.

See [04 — Languages](04-languages.md): a language's behavioral prover landing in `1.x` is exactly such a capability bump.

## Storage — the hybrid model

✅ 1.0 (spec store + encrypted code archive). We invent as little as possible:

- **Small YayLayer-native objects** — spec blocks, verification attestations, evidence manifests, grant/ratification objects — live in a tiny **content-addressed store** in `.yaylayer/objects/` (sha256, deduped). These are the must-never-blank audit core; they're tiny, so we don't need git's packing machinery.
- **Bulk source code** (Durable mode) is archived via **git** (a shared, incremental object pack/bundle) — battle-tested, delta-compressed, interoperable.

Two rules that keep git safe as a *container*:
1. **Our sha256 over the archived bytes is the trust anchor** — never git's SHA-1 object id. (Neutralizes SHA-1 weakness.)
2. **One shared incremental pack, never a bundle-per-approval** — or you lose cross-approval dedup.

Why not a fully bespoke object store? Reimplementing git's packing/GC is a lot of high-stakes code for no gain over git on bulk blobs. Why not pure git? SHA-1 as a trust anchor, and git can't natively hold our attestation objects. The split gets the best of both.

## Standard vs Durable

🔭 Later. A **per-project setting** chosen at `yay init` / `yay adopt`, remembered in config, changeable later (owner-controlled):

| | Standard *(default)* | Durable |
|---|---|---|
| Specs + attestations | Archived (always) | Archived (always) |
| Brief tree / history / spec diff | Full | Full |
| **Code** at each point | By **git reference** (available while git has it; labeled if lost) | **Archived (encrypted)** in the provenance store — survives git loss/rewrite |
| Best for | Normal projects | Regulated / compliance / long-lived audit |

Switching Standard → Durable later archives *future* approvals' code; a `backfill` command can pull history in.

## Governance — designed in, not bolted on

🔭 Later. The real cost of "keep code forever" isn't disk; it's **data governance** (secrets, PII, licensed code, deletion obligations). So Durable mode ships *with* governance:

- **Two data classes:**
  - **Audit metadata** (hashes, attestations, signatures, timestamps, tombstones) — kept **in the clear** and signed, so the chain is auditable **without** decrypting any source.
  - **Content** (source blobs) — **encrypted**.
- **Encryption:** source blobs are **AES-256-GCM at rest and in transit**, under a **project-held key** (org KMS / `age`/GPG recipient / passphrase). **YayLayer never sees the key.** The store holds only ciphertext + the `sha256` of the *plaintext* (so integrity still ties to the seal). Decryption is transient, in memory, only when an authorized human opens the "as signed" view.
- **Retention policy** (owner-signed, like `policy`): e.g. "specs forever; code for ratified security Cells forever, others 24 months; never archive files matching `.env`/secret patterns."
- **Pre-archive secret scan** — refuse/redact secrets before they're preserved forever.
- **Deletion tombstones** — honest erasure without rewriting history:

```
Cell C-040 · revision C17
  status:     deliberately removed
  hash:       sha256:8d621b0f…
  removed:    2026-09-14 · reason: "GDPR erasure request #4471"
  removed by: Alice (owner-signed)
```

You lose reconstructability of that one object; you keep the chain, the signatures (which cover the hash, not the content), and an auditable record that a deletion happened. Spec tombstones apply in both modes; **code** tombstones are a Durable-mode concern (in Standard, code lives in git, so purging is a git operation the **integrity witness** will honestly flag).

## The integrity witness

🔭 Later. Because YayLayer independently retains approved-spec hashes, implementation-tree hashes, verification evidence, signatures, and previous-event hashes, a rewritten git history can be **compared against the provenance ledger**:

> "The code git currently claims existed at this approval is not the code YayLayer originally verified."

At that point YayLayer isn't just documenting the workflow — it's an **independent integrity witness** for it.

## Append-only + hash chain

🔭 Later (formalized) / ✅ partially (the lock is already a `prev`-chained ed25519 event log). Cell identities have immutable **revisions**; approvals point to a revision and are never silently repointed; corrections create `superseded-by` events. Each event references its predecessor:

```
event_hash = hash(previous_event_hash + current_event)
```

No blockchain — just tamper evidence across the historical record.
