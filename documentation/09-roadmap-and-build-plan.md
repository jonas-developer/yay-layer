# 09 — Roadmap & build plan

The whole architecture (all three advisor papers + our decisions) is adopted; the question is only **order**. We deliver the *complete* vision **incrementally** so it ships. Relaunch `1.0` on a clean, honest foundation and grow in versions — matching YayLayer's own "the verifier improves over versions" ethos.

## Guiding decisions (see [10 — Decision log](10-decision-log.md))

- **Relaunch incrementally** — don't hold `1.0` for the whole provenance system.
- **Storage:** tiny bespoke sha256 store for specs/attestations; **git bundles** for bulk code (our sha256 as trust anchor; shared incremental pack).
- **Verifier key:** project/CI-scoped first; hosted service later; **never in the package.**
- **Naming:** Autopilot (friendly) / Delegated execution (formal); retire "Freedom mode"; drop "auto-approved."

## Phases

### P0 — Relaunch hygiene *(in 1.0 — small, security-relevant)*
- [ ] Rename **"auto-approved" → "Delegated · Awaiting ratification"** everywhere (badge, banner, the `//∷YAY-AUTO` code stamp, docs, site). Reserve "approved/approval" for human signatures.
- [ ] Rename **"Freedom mode" → "Autopilot"** (friendly) / "Delegated execution" (formal) across UI, CLI help, docs, site.
- [ ] **Fix the `yay ratify --sign` TOCTOU hole** — reviewed-bundle hash; recompute at sign; refuse on drift. Batch default: refuse-whole-batch on any drift. **Not-optional for the relaunch.**
- [ ] Audit "agent can't broaden its own grant" — confirm grant-scope config (incl. sensitivity) lives outside the delegated surface.

### P1 — Spec provenance *(in 1.0 — kills the "history comes back blank")*
- [ ] Append-only content-addressed store `.yaylayer/objects/` for normalized spec blocks keyed by specHash; write at sign.
- [ ] History lens reads **store-first**; git is fallback/cross-check. (Replaces today's git-only `src/history.js`, which blanks on rename/squash.)
- [ ] Formalize immutable Cell **revisions**; approvals reference a revision id.

### P1.5 — Languages *(in 1.0)*
- [ ] Per-language **effect/purity nets** for all five (Ruby, PHP, Solidity, Rust, C#) — stop the JS-regex fallback; make all five first-class on the gate (correct Pink/Red/Yellow).
- [ ] **Behavioral proof adapters for Ruby + PHP** (Python subprocess pattern → pure funcs reach Green), with graceful toolchain degradation.

### P2 — Verifier attestation *(the leap to "provenance system")*
- [ ] Canonical Verification object (spec-set/code-tree/verifier-pkg/ruleset/config/evidence hashes + result + timestamp).
- [ ] **Hash + sign** it with a **project/CI-scoped verifier key**; mint at commit/verify-pass.
- [ ] Human ratification/approval references the verification attestation hash.
- [ ] Start verifier **capability-versioning** (PATCH/MINOR/MAJOR).

### P3 — Grants → envelopes, two-axis, rejections
- [ ] Expand grants into signed **capability envelopes** (scope constraints first; detection-gated constraints as detectors land — build detector + constraint together).
- [ ] Non-delegable-by-default risk tiers (auth/payments/secrets/deploy/CI/trust-config) → forward-sign before execution; verifier backstop detects violations.
- [ ] **Two-axis UI** (Authority × Verification) with progressive disclosure.
- [ ] Meaningful ratify screen: grant scope + boundary/deviation report + effect/dep/perm summary + verifier attestation.
- [ ] Persist **Rejected** as first-class provenance events (with reason).

### P4 — Long-lived assurance
- [ ] **Durable mode**: encrypted git-bundle code archive + `yay archive --install` commit hook.
- [ ] Governance: encryptable project-controlled store + owner-signed retention policy + deletion **tombstones** + pre-archive secret scan.
- [ ] **Historical re-verification** (`yay reverify`): append new results on verifier upgrades, never rewrite; org grandfathering policy; upgrade report.
- [ ] **Integrity witness** (git vs ledger).
- [ ] **Cell semantic-timeline UI**.
- [ ] **Earned-autonomy metrics** from rejection history.

## What ships in 1.0

P0 + P1 + P1.5. Result: correctly-worded, TOCTOU-safe, non-blanking release with **JS/TS + Python + Ruby + PHP behaviorally proven** and **Solidity/Rust/C# statically first-class** — a foundation the rest layers onto cleanly.

## Explicitly deferred (post-1.0)

- C# → Rust → Solidity **behavioral** proof (each a capability bump; Solidity is its own EVM-harness release).
- Verifier attestation (P2), grant envelopes/rejections (P3), Durable mode + governance + reverification + integrity witness + timeline + metrics (P4).
- Hosted attestation service.

## Already shipped this session (the foundation to build on)

The Briefs **history lens** (git-based): `src/history.js` `cellAsSigned` (matches by specHash), `/api/cell-history`, `cellAsOf` dep, and the 3-tab **As signed / Current / What changed** modal. Its blank-on-git-loss weakness is exactly what **P1** fixes.

## npm relaunch note

`yay-layer@0.1.0` was unpublished (2026-08-29) after finding many faults. Republish under a **new** version (`0.1.0` is burned) only after the 24h name cooldown; the name is held for the owner. Run pre-flight (smoke tests, `npm pack` dry-run, version bump, secrets scan) before publishing.
