# 09 — Roadmap & build plan

The whole architecture (all three advisor papers + our decisions) is adopted; the question is only **order**. We deliver the *complete* vision **incrementally** so it ships. Relaunch `1.0` on a clean, honest foundation and grow in versions — matching YayLayer's own "the verifier improves over versions" ethos.

## Guiding decisions (see [10 — Decision log](10-decision-log.md))

- **Relaunch incrementally** — don't hold `1.0` for the whole provenance system.
- **Storage:** tiny bespoke sha256 store for specs/attestations; **git bundles** for bulk code (our sha256 as trust anchor; shared incremental pack).
- **Verifier key:** project/CI-scoped first; hosted service later; **never in the package.**
- **Naming:** Autopilot (friendly) / Delegated execution (formal); retire "Freedom mode"; drop "auto-approved."

## Phases

### P0 — Relaunch hygiene *(in 1.0 — small, security-relevant)*
- [x] Rename **"auto-approved" → "Delegated · Awaiting ratification"** everywhere (badge, banner, the `//∷YAY-AUTO` code stamp, docs, site). Reserve "approved/approval" for human signatures.
- [x] Rename **"Freedom mode" → "Autopilot"** (friendly) / "Delegated execution" (formal) across UI, CLI help, docs, site.
- [x] **Fix the `yay ratify --sign` TOCTOU hole** — reviewed-bundle hash; recompute at sign; refuse on drift. Batch default: refuse-whole-batch on any drift. **Not-optional for the relaunch.**
- [x] Audit "agent can't broaden its own grant" — confirm grant-scope config (incl. sensitivity) lives outside the delegated surface.

### P1 — Spec provenance *(in 1.0 — kills the "history comes back blank")*
- [x] Append-only content-addressed store `.yaylayer/objects/` for normalized spec blocks keyed by specHash; write at sign.
- [x] History lens reads **store-first**; git is fallback/cross-check. (Replaces today's git-only `src/history.js`, which blanks on rename/squash.)
- [x] Formalize immutable Cell **revisions**; approvals reference a revision id. *(Realized by content-addressing: a Cell's specHash **is** its immutable revision identity, approvals already reference it via `items[id]=specHash`, and each is now archived. An explicit ordered revision index — "revision 1, 2, 3" labels — is deferred as cosmetic.)*

### P1.5 — Languages *(in 1.0)*
- [x] Per-language **effect/purity nets** for all five (Ruby, PHP, Solidity, Rust, C#) — stop the JS-regex fallback; make all five first-class on the gate (correct Pink/Red/Yellow).
- [x] **Behavioral proof adapters for Ruby + PHP** (Python subprocess pattern → pure funcs reach Green), with graceful toolchain degradation.

### P2 — Verifier attestation *(in 1.0 — the leap to "provenance system")* ✅
- [x] Canonical Verification object (spec-set/code-tree/verifier-pkg/ruleset/evidence hashes + result + env + timestamp) — `src/attest.js` `buildVerification`.
- [x] **Hash + sign** it with a **project/CI-scoped verifier key** (machine-held, gitignored; public key pinned in `config.verifier`, committed; never in the npm package); mint via `yay attest` at commit/verify-pass. Refuses a blocked gate unless `--force`.
- [x] Human ratification/approval references the verification attestation hash — the seal carries `attest:{hash,capability}` when a signed attestation covers the exact code-tree (`yay sign`/ratify).
- [x] Verifier **capability-versioning** (`CAPABILITY`, PATCH/MINOR/MAJOR) recorded in every attestation; append-only chained ledger (`.yaylayer/attest.json` + `.yaylayer/attestations/`); `yay attest list` / `yay attest verify`.

### P3 — Grants → envelopes, two-axis, rejections *(in 1.0)* ✅
- [x] Signed **capability envelopes** — `envelope:{allow,deny,cells,maxRisk,childGrants,deps,deployment}`. Scope constraints (allow/deny/cells/maxRisk) enforced now; content constraints (deps/deployment) recorded but detector-gated (D15). Flags on `yay grant`.
- [x] Non-delegable via **owner-signed policy** (`{ "delegable": false }`, path/tag/module) — the authoritative backstop outside the AI-writable surface (closes the P0 grant-broadening gap). **Verifier backstop**: a real grant-key signature over an out-of-envelope Cell → gate-blocking RED with a reason (agent can't widen its own grant).
- [x] **Child grants** — attenuating sub-grants signed by the parent grant key; verifier refuses any child exceeding its parent (allow/deny/count/expiry/risk/depth) and cascades parent revocation.
- [x] **Two-axis surface + meaningful ratify screen** — the dashboard ratify banner shows grant scope + boundary/deviation report (delegations consumed, expiry) + verifier-attestation coverage; delegated state shown distinctly from verification colour.
- [x] Persist **Rejected** as first-class provenance events (`yay ratify --reject --reason [--category]`, signed, append-only `.yaylayer/rejections.json`) — the earned-autonomy substrate; surfaced in the dashboard.

### P4 — Long-lived assurance *(in 1.0)* ✅
- [x] **Durable mode**: encrypted (AES-256-GCM), **sha256-anchored** source archive + `yay archive install` post-commit hook. Key project-held ($YAY_ARCHIVE_KEY / passphrase), never stored. (`src/durable.js`; git-bundle bulk transport is a later storage optimization — the guarantees hold today.)
- [x] Governance: project-controlled encrypted store + retention field + deletion **tombstones** (signed, honest erasure) + **pre-archive secret scan** (refuses to seal secrets). Clear signed metadata; sealed body.
- [x] **Historical re-verification** (`yay reverify`): re-run at the current capability; a capability bump / verdict change / drift **appends** a new chained attestation, never rewrites old Green; prints an upgrade report.
- [x] **Integrity witness** (`yay witness`): attestation chain + spec-archive completeness + git/tree-vs-ledger coverage.
- [x] **Earned-autonomy metrics** (`yay metrics`) from delegation + ratification + rejection history (per-category rates + suggestions).
- [x] **Cell semantic-timeline UI** — each Cell's provenance events stitched from the ledgers (created → signed → delegated → attested → ratified/rejected) in the static detail and as a **Timeline tab** in the live history modal, alongside the existing As-signed / Current / What-changed lens.

## What ships in 1.0

**Decision reversed 2026-08-29:** 1.0 now ships the **whole architecture** — P0 + P1 + P1.5 **+ P2 + P3 + P4**. Rationale: the thesis is a *cryptographic provenance layer*; shipping without the **verifier attestation** (P2, the third crypto identity) would be the same category of overclaim that got `0.1.0` pulled, and P3/P4 are core to the vision rather than optional polish. Only genuinely-later **language** work is deferred (below). Result: a correctly-worded, TOCTOU-safe, non-blanking release with **JS/TS + Python + Ruby + PHP behaviorally proven**, **Solidity/Rust/C# statically first-class**, **signed verifier attestations**, **capability-envelope grants + two-axis authority + first-class rejections + child grants**, and **Durable mode + governance + reverification + integrity witness + timeline + metrics**.

## Explicitly deferred (post-1.0)

- C# → Rust → Solidity **behavioral** proof (each a capability bump; Solidity is its own EVM-harness release).
- **Class/instance-method proving** for the subprocess provers (Ruby/PHP, later others): today they resolve only **top-level/module functions**, so pure *class-based* code skips to Yellow. Extend the harness to call `Klass.method` / instance methods (receiver + args declared in the spec) → unlocks **proven-Green for pure Rails service objects and value objects**, where correctness bugs actually live. Highest-leverage language follow-up.
- **Framework-boot provers** (much bigger, own release, like the Solidity EVM harness): boot Rails/ActiveRecord (or another framework) so effectful, framework-coupled methods can be exercised. Out of scope for the near term.
- **Notary-as-a-service** *(someday — not necessarily the next version)*. The keyless verifier at `yaylayer.com/verify` + the canonical capability registry ship in 1.0 (an attestation is self-verifying; the registry is static). The remaining hosted piece is an optional **notary**: a small third-party service that, given an attestation *hash*, signs *"this hash was presented to me at my clock time"* and records it in a public, append-only list. It adds what a self-verifying attestation can't prove on its own — a **trusted timestamp** (anti-backdating), an **independent public record** an outside auditor/regulator/customer can check without trusting your repo or clock, and a **neutral second signature** so trust doesn't rest solely on the project/CI-scoped verifier key. Never sees code (hashes only) → compatible with the relay's zero-knowledge stance. Needs a real secret (the notary signing key, held as a Vercel env var), so it's the one piece left out of the keyless core. Shape when built: `/api/notarize` + `/api/check` on the site, a keygen script the owner runs, `yay attest --notarize` / `yay attest verify` client flags. *(A full hosted re-verifier that runs the verifier on submitted code is a separate, much larger service — its own sandboxed infra, further out.)*

## Already shipped this session (the foundation to build on)

The Briefs **history lens** (git-based): `src/history.js` `cellAsSigned` (matches by specHash), `/api/cell-history`, `cellAsOf` dep, and the 3-tab **As signed / Current / What changed** modal. Its blank-on-git-loss weakness is exactly what **P1** fixes.

## npm relaunch note

`yay-layer@0.1.0` was unpublished (2026-08-29) after finding many faults. Republish under a **new** version (`0.1.0` is burned) only after the 24h name cooldown; the name is held for the owner. Run pre-flight (smoke tests, `npm pack` dry-run, version bump, secrets scan) before publishing.
