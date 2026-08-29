# 07 — Security model

## Separation of duties (the triad)

No actor grades its own work. The agent **proposes**, the verifier **measures**, the human **authorizes**. The agent — however capable — is the **untrusted producer**: it may state *what* it made, never that its work is correct or that a human approved it. This is the foundational security property; everything below supports it.

## Three keys / identities, kept separate

| Identity | Key | Attests |
|----------|-----|---------|
| **Human** | Phone key (ed25519, biometric-gated) | "I authorized / ratified this intent." |
| **Verifier** | Verifier key (separate) ✅ | "This verifier's semantics evaluated this code against this spec → Z." |
| **Artifacts** | Content hashes (no key) | "This is the exact thing referred to." |

Never conflate them. A human ratification *references* the verifier attestation hash but is signed with the **phone** key; the verifier attestation is signed with the **verifier** key. The human signature means *a person decided*; the verifier signature means *the machine measured*.

## The verifier-key rule (do not get this wrong)

 **Never ship the verifier's signing key inside the npm package.** If the key is public, anyone can forge a `GREEN` attestation and the entire machine-attestation half is worthless. The verifier signature only carries trust if its key is **not universally available**:

- **v1:** a **project/CI-scoped** verifier key (enrolled like a machine signer). Meaning: "our trusted CI verifier said Green" — trustworthy within the org.
- **Later:** optionally a **hosted YayLayer attestation service** signing with a central key, for cross-org third-party-checkable attestations.

A hash proves bytes are unchanged; only a **signature from a non-public key** proves *who* produced the attestation.

## Phone signing — why the key lives on the phone

✅ Shipped. The human's private key is generated on the **phone** and never leaves it — held in the phone's secure hardware (Secure Enclave / Android Keystore), released only by biometric, per signature. The AI's machine only ever sees the **public** key (in the committed roster). So even a fully compromised dev machine or a rogue agent cannot sign as the human — signing authority is physically off the box the AI runs on.

## What a signature attests to

✅ Shipped. The human signs the **spec + Brief** (the intent), **never the code bytes**. Consequences:
- A refactor preserving the spec needs no new signature.
- Editing a signed Cell's spec changes its specHash, so the old seal no longer covers it → it drops to needs-signing. You can't silently alter what was approved.

## The gate — enforcement lives outside the AI's reach

✅ Shipped. `yay verify --strict` runs as a required CI check on `main`. Red / Unsigned / **Pink** fail and can't merge. This is the real enforcement — infrastructure the AI doesn't control — not a local hook it could disable.

## Pink — no code without a governing Cell

✅ Shipped. Any unit with **no** spec, or loose top-level imperative code in any scanned language, shows **Pink** and blocks the gate. This closes the "sneak in a raw `DO THIS` line with no Cell" hole — you can't smuggle ungoverned code past the gate by simply not writing a spec for it.

## Injection resistance

✅ Shipped. If an AI injects code that wasn't there before:
- Un-specced injected unit → **Pink** (blocked).
- Injected effect in a `pure`-declared Cell → **Red** (the offending line pinpointed by the per-language effect net).
- Injected behavior contradicting the spec → **Red** (behavioral prover counterexample).
- A tampered/absent seal → **Unsigned** (blocked).
So injected code can't reach Green without either matching an approved spec or getting a fresh human signature.

## TOCTOU safety in ratification

✅ 1.0 (P0). `yay ratify --sign` must sign the **exact bundle the human reviewed** (reviewed-bundle hash over grant+brief+spec-set+code-tree+evidence; refuse on drift). Otherwise a human reviews T93 and unknowingly signs T94 — turning ratification into a false record. See [03](03-autopilot-delegated-execution.md#toctou-safety--not-optional-for-the-relaunch).

## Silent-drift detection

✅ Shipped (per-Brief health) / (history diff). A validly-signed Brief whose covered Cell has since drifted must not read as green. The Briefs view shows covered-Cell health; the history lens shows a **What changed** diff against the signed version. A valid seal over drifted code is exactly the "silent false green" YayLayer exists to catch.

## Independent integrity witness

🔭 Later. Because YayLayer independently retains approved-spec hashes, implementation-tree hashes, verification evidence, and signatures, a rewritten git history can be compared against the provenance ledger to detect *"the code git now claims existed here isn't what YayLayer originally verified."* See [02](02-provenance-architecture.md#the-integrity-witness).

## Grant containment

 Only a human can issue a grant (the agent holds no owner key). The agent **must never broaden its own grant** — grant-scope-determining config lives *outside* the delegated surface. Non-delegable categories (auth, payments, secrets, deploy, CI/security, trust config) default to human-approval-before-execution. See [03](03-autopilot-delegated-execution.md#non-delegable-by-default).

## Trust roster & the constitution

✅ Shipped. The signer roster is an append-only, owner-signed event log (`prev`-chained). The **Constitution** written into AI-harness files instructs the agent on the loop (spec-first, sign, implement, commit code + `.yaylayer/` together, never push unasked, never implement unapproved specs). The roster is authoritative; the CI installs the verifier fresh and pins trust, so the AI can't quietly swap in a permissive verifier.

## Data governance (Durable mode)

🔭 Later. Source retained forever is a liability (secrets, PII, licensed code, deletion duties). Mitigations shipped *with* Durable mode: metadata clear + signed, **source encrypted (AES-256-GCM) under a project-held key YayLayer never sees**, owner-signed retention policy, pre-archive secret scanning, and **deletion tombstones** that honor erasure without rewriting the chain. See [02 — Governance](02-provenance-architecture.md#governance--designed-in-not-bolted-on).
