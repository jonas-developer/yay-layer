# 10 — Decision log

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

**D9. ~~Deliver the complete vision incrementally; relaunch 1.0 on a foundation.~~ → REVERSED 2026-08-29: ship the whole architecture (P2+P3+P4) in 1.0.**
*Original why:* building it all before shipping = months and re-couples "finish" to a deadline we just escaped by unpublishing.
*Reversal why:* the product's own claim is a *cryptographic provenance layer*. Shipping without the **verifier attestation** (P2 — the third crypto identity) would repeat the overclaim that got `0.1.0` pulled; and P3 (envelopes/two-axis/rejections) and P4 (durable/governance/reverify) are core to the vision, not optional polish. The version machinery handles later bug-fixes cleanly (patch bumps, `npm deprecate`), so there's no need to ship a thin slice to de-risk. Only genuinely-later **language** work stays deferred (C#/Rust/Solidity behavioral proof, class/instance-method proving, framework-boot provers) — per D17, unchanged. (User call.)

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

## Post-launch decisions (2026-08-30)

**D19. Distributed Cell ids: sharded, monotonic, never reused.** New ids are `C-<shard>-<n>`; the shard is unique to each *working copy* (gitignored `.yaylayer/local.json`, never committed) and numbers only ever count up (seeded from tree + ledger history), so a deleted Cell's number is retired forever. The append-only ledgers (`lock/attest/rejections.json`) are set to git `merge=union` via a written `.gitattributes`; `yay merge` re-verifies after a merge and lists collisions / Cells needing re-sign. `yay id` shows the shard.
*What it means:* several people in separate clones can build in parallel and merge without id collisions — a bare sequential counter (single-writer assumption) would mint the same id for different Cells on two branches.
*What it affects:* `adopt` + the generated Constitution (Article 2) mint sharded ids; `.gitattributes` + `local.json` join the foundation-sealed set / gitignore. Backward-compatible — legacy flat `C-NNN` ids keep working; only new ids are sharded. A same-Cell edit on both branches is still a genuine conflict → Cell drops to Unsigned → re-sign (a clean "take one side" needs no re-sign, because the union-merged lock already holds that side's seal).

**D20. Undeclared-input predicate provenance — the 3rd prong of the pincer.** A deterministic static check (`src/predicate.js`, `@babel/parser`) flags a branch that keys off a function *parameter the Cell's `in:` never declares* (`if (mode === 'admin')` when `in:` lists only `items`). Yellow by default (advisory, never blocks on its own); owner-signed policy `{ "predicate": "declared" }` escalates to gate-blocking. Runs on passing JS/TS Cells regardless of `--mutate`.
*What it means:* it catches the hidden-mode / undeclared-control-input shape the other checks structurally miss — the branch *does* something (inertness stays quiet), *is* exercised (coverage happy), and carries *no* magic constant (literal-seeding finds nothing), yet depends on an input the human never signed.
*What it affects:* new capability check `predicate-provenance` + policy kind `predicate-declared`; **capability bumped 1.0.0 → 1.1.0** (new fingerprint registered in `capability.js` AND the published `yaylayer.com/capabilities.json`). Conservative by design (simple-identifier params only, member-property names excluded, uncertain parse → nothing). The fix is to *declare the input in `in:`* — the spec-strengthening loop.

**D21. Ratification is the human's decision surface; enrich it by *surfacing already-computed signals*, never new checks.** `yay ratify` (CLI) and the dashboard Ratify panel now show each delegated Cell's state + its existing flags (coverage `5/7 branches`, `◈ undeclared input`, `inert`, weak-`ensures`) and, in the dashboard, a click-through to the full detail; `yay ratify -d` expands spec + code inline. The TOCTOU snapshot/`--sign` guarantee is unchanged.
*What it means:* at the one moment a human blesses code they didn't watch being written, they see complexity + smells at a glance and can triage which Cell needs a close look.
*What it affects:* pure surfacing — no new stored state, no new baseline, nothing an agent can reset. This establishes a reusable seam: future decision-signals (risk level, blast radius, envelope proximity, effect descriptor, earned-autonomy history) slot in as additional chips. **Guardrail:** promote a signal to the list level only if it changes a ratify decision; everything else stays behind `-d` / click-through — the surface must not become noise.

**D22. ~~Code-aware concolic "`yay verify --reach`" feeding coverage~~ → REJECTED.** Proposed: an AI reads the code, crafts inputs to reach unexercised branches, re-runs the prover, and counts them as exercised.
*Why rejected:* it Goodharts the honesty metric. Coverage is meaningful *only* because inputs are **spec-derived**; letting code-derived inputs count would turn an honest "unexercised" boundary into a false "fully covered" green — and a dormant-payload author can craft the exact input that reaches their own branch just as easily. Reaching a branch ≠ justifying it (that's what D20 answers). *Salvage:* a reach loop is acceptable only as a walled-off **diagnostic** that never touches coverage / `coverage: full` / the attestation and only says "here's an input that reaches line 14 — spec it or prune it." Not built.

**D23. ~~Shape-drift tripwire (record AST branch/statement counts at signing; note "grew 3→11 since signing")~~ → REJECTED.** Proposed: an advisory metric to make "quietly grew" loud.
*Why rejected:* (1) spec-first breaks the baseline — at sign time the code doesn't exist yet, so it would fire "grew 0→N" on every Cell; (2) it fires on *normal iteration* (code churns under a stable signed spec by design) → alarm fatigue, against our low-noise ethos; (3) its unique gap is thin — grown code is already caught by inertness / predicate / effects / coverage / mutation-grading; (4) an advisory baseline the agent can rewrite is defeatable (theater). Even relocated to ratify the baseline doesn't exist (a grant is a forward envelope, signed before the delegated code exists) and the delta window is empty. The real need it points at — "help the human notice complexity at ratify" — is served by D21 (surface the *existing* precise signals), not by a noisy proxy.
