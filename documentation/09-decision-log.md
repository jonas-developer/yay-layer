# 09 — Decision log

Locked decisions with rationale, so we never re-litigate. Source: three advisor papers (adopted **in full**, not as a menu) + our own calls. Date of convergence: 2026-08-29.

## Architecture (from the papers, adopted in full)

**D1. The triad, with separation of duties.** Human (authority) / Agent (production, *untrusted*) / Machine verifier (deterministic assessment). No actor grades its own work.
*Why:* the only structure that makes "trust for AI-written code" defensible — the producer can't certify itself.

**D2. Two chains, never collapsed.** Human authorization (Brief + specs + phone signature) is separate from implementation verification (spec-set + code + verifier evidence).
*Why:* lets code change (refactors) without new human signatures; keeps YayLayer approving *intent*, not *bytes*.

**D3. Three cryptographic identities.** Artifact hashes / verifier attestation (verifier key) / human signature (phone key). Human ratification references the verifier attestation hash.
*Why:* a hash proves "unchanged"; a signature proves "who" — and the human must be tied to the exact verifier result, not the word "Green."

**D4. Append-only, content-addressed, never rewritten.** Corrections and re-verifications are new events; each references its predecessor's hash.
*Why:* auditability requires that history can't be silently altered.

**D5. "Green is an event," not a property.** Every verdict records the verifier semantics that produced it; better verifiers append new assessments, never rewrite old ones.
*Why:* verifier improvements become a compounding retrospective asset instead of history-rewriting.

**D6. Preserve every historical spec, always** (both Standard and Durable).
*Why:* specs are tiny and irreplaceable; this is what kills the "history blanks" problem.

**D7. Autopilot reform.** A grant authorizes *action within an envelope*, not the artifact. State vocabulary: Delegated / Awaiting ratification / Ratified / Rejected / Superseded. Two orthogonal axes (Authority × Verification). Non-delegable-by-default high-risk categories. Persist rejections.
*Why:* "approved" must mean human sign-off; delegated ≠ approved; auditors must see the true temporal state.

## Naming (our call)

**D8. Autopilot (friendly) + Delegated execution (formal); retire "Freedom mode"; drop "auto-approved."**
*Why:* "Freedom mode" implies the AI is *unbound* — wrong polarity for a control/trust product and alarming to auditors. Autopilot = bounded, supervised, retake-control-anytime. Technical nouns (`yay grant`, Delegated, Ratified) unchanged. Cheap to change now (package unpublished).

## Implementation choices (our calls, my four addenda)

**D9. Deliver the complete vision incrementally; relaunch 1.0 on a foundation.**
*Why:* building it all before shipping = months and re-couples "finish" to a deadline we just escaped by unpublishing. Incremental matches the "verifier improves over versions" ethos.

**D10. Storage = hybrid.** Tiny bespoke sha256 store (`.yaylayer/objects/`) for specs/attestations/evidence/grants/ratifications; **git (shared incremental pack) for bulk source** in Durable mode. **Trust anchor = our sha256 over archived bytes** (not git SHA-1). **Never per-approval bundles** (kills dedup).
*Why:* reinventing git's packing/GC is high-stakes code for no gain on bulk blobs; pure-git can't anchor trust (SHA-1) or hold our attestation objects. The split takes the best of both.

**D11. Verifier key: project/CI-scoped first, hosted service later. Never ship it in the npm package.**
*Why:* a public verifier key lets anyone forge "Green," making the whole machine-attestation half worthless.

**D12. Governance is first-class in Durable mode.** Metadata clear + signed; **source encrypted (AES-256-GCM) under a project-held key YayLayer never sees**; owner-signed retention; pre-archive secret scan; deletion **tombstones**.
*Why:* "keep code forever" inherits secret/PII/licensing/erasure liabilities the moment it ships.

**D13. Pin the two capture points.** Human authorization mints at **sign**; verifier attestation mints at **commit/verify-pass**.
*Why:* under Architecture A the code doesn't exist at sign; leaving timing implicit makes attestations ambiguous.

**D14. TOCTOU fix is not-optional for the relaunch.** `yay ratify --sign` signs the exact reviewed bundle; refuses on drift.
*Why:* it's a hole in a shipped feature that makes its core guarantee ("a human reviewed this exact result") silently false — the worst class of bug for a sign-off product. Small fix, high severity.

**D15. Envelope constraints are gated by detectors.** A grant only carries constraints the running verifier version can detect; each attestation records verifier version + capabilities.
*Why:* an unenforceable boundary is theater. Scope constraints (paths/cells) enforceable now; content constraints (deps/network/effects) as detectors land, as capability bumps.

**D16. Be honest about prover determinism.** The prover is logically deterministic (no RNG); the only nondeterminism is wall-clock timeouts + cross-environment drift. Attestations record the environment and claim "Green under this verifier + environment at this time." Later: replace wall-clock timeout with a deterministic step/fuel budget, or flag "timing-sensitive" cases.
*Why:* corrects an earlier overstatement ("stochastic"); sets honest expectations for reproducibility.

## Language scope for 1.0 (our call)

**D17. v1 = all five (Ruby/PHP/Solidity/Rust/C#) static first-class + Ruby/PHP behaviorally proven. Postpone C#/Rust/Solidity behavioral proof** (C# → Rust → Solidity; Solidity its own EVM-harness release).
*Why:* Ruby/PHP fit the existing Python subprocess pattern (cheap); C#/Rust need compile-harnesses and Solidity needs an EVM — doing all five behaviorally in v1 would blow the relaunch. Static first-class for all five is achievable and a real upgrade over the JS-regex fallback.

## Docs process (our call)

**D18. Write the canonical manual first (this `/documentation/` set), build the engine against it, update docs alongside code.** Deeper reference (schemas, object-store layout) finalized *during* implementation.
*Why:* the design is large and multi-session; a committed source-of-truth is the best hedge against context-reset drift — and building spec-first against it is YayLayer's own philosophy applied to itself.
