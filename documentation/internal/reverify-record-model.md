<!--
  INTERNAL — NOT PUBLISHED.
  This directory (documentation/internal/) is engineering decision history. It is NOT copied to the
  public site (yaylayer.com pulls only public/docs/manual.html), NOT shipped in the npm package
  (package.json `files` excludes documentation/), and the repo is private. Keep design deliberation,
  rejected alternatives, and reasoning here — not in the user-facing manual or the public decision log.
-->

# Internal decision — the reverification record model (reverify engine, P3)

**Status:** DECIDED — Hybrid (open report + opt-in signing). P3 (engine + records) and P4 (grandfathering
posture) SHIPPED 2026-08-31. Per-Cell scoping (P4b) + posture hardening deferred (see §6).
**Date:** 2026-08-31.
**Scope:** How `yay reverify` (the historical sweep) records what it finds. Companion to the public
decision log (`10-decision-log.md`); this file holds the *deliberation* — the alternatives we rejected
and why — which does not belong in user-facing docs.

---

## 1. Context

The reverify engine "replays the tape through today's verifier": it reconstructs preserved (Durable)
snapshots and re-runs the current verifier over them, so a verifier improvement can re-judge old,
already-approved code. P0–P2 built the substrate (reconstruction, `reverifyState`, the sweep + diff).
P3 turns that into a real command with a rendered upgrade report and an appended record.

The open design question P3 forced: **when the sweep finds that an old GREEN is now YELLOW under a
better verifier, how is that finding recorded?** Three models were on the table.

---

## 2. The three options

### Option A — Hybrid (CHOSEN)
`yay reverify --all` always prints/saves the upgrade report with **no key needed**. Minting **signed,
append-only reverification records** is an explicit opt-in step (`--attest`) that uses the verifier key.

- **Pros:** read-only viewing is frictionless and keyless; cheap preview before committing to a record;
  the durable record is still cryptographically signed + verifiable; no ledger spam; dedups re-runs.
  Faithfully matches the paper's *two distinct artifacts* (a shown report + a signed immutable record).
  It is a **superset**: enforcement can later be layered on by policy (see §5) to make it behave "Closed"
  where a team needs that.
- **Cons:** two steps — if a team never runs `--attest`, the delta isn't yet a durable fact (mitigated by
  the post-bump nudge and, in P4, a "must-record" policy).

### Option B — Always sign
Every sweep that finds deltas mints signed records automatically (with dedup); the verifier key is
required to run reverify at all.

- **Pros:** one command; guarantees a complete signed ledger; no unsigned verdicts in circulation.
  Closest to the paper's literal "should be signed" wording.
- **Cons:** reverify then *always* needs the crown-jewel verifier key present (worse key hygiene, more
  exposure in CI/logs); no keyless preview; risks minting on a mere look; still needs dedup anyway.

### Option C — Lightweight annotation (REJECTED)
Record deltas as plain, unsigned append-only log entries referencing the originals.

- **Pros:** simplest; no key ever.
- **Cons:** the paper explicitly argued against this — it wanted the record *signed, not merely hashed*.
  An unsigned record is advisory only and won't verify at yaylayer.com/verify. Rejected outright.

---

## 3. What the papers said (faithful paraphrase)

Primary source: **Paper 3** (verification-provenance reviewer). The user had, in that very paper, asked
the reviewer whether a re-verification "needs a unique hash too, like phone approvals." Substance of the
guidance:

1. **Append, never rewrite.** A re-verification is a *new immutable record*; the original stays. History
   then truthfully reads both verdicts at once — e.g. GREEN under verifier 1.8.4 (2026) *and* YELLOW under
   4.2.0 (2029). The reviewer framed keeping both as *better* than overwriting, and drew a clean line
   between **historical truth** (it passed the standard that existed then) and **present-day confidence**
   (what we know now).
2. **Hash AND sign it.** A hash proves the bytes are unchanged; a signature proves a specific trusted
   identity attested to them. The reviewer recommended the verifier record have its own unique hash and,
   to prove *what* produced it, ideally also be cryptographically signed — via the *verifier* identity
   (the 2nd of the three cryptographic identities), the same key `yay attest` uses.
3. **It's an immutable object with granular evidence**, chained into the append-only ledger
   (`prev_event_hash + attestation_hash → event_hash`): spec-set hash, code-tree hash, verifier version +
   ruleset/config digests, evidence manifest, result, reason.
4. **The upgrade report is a distinct, shown artifact** — the "1,779 remain Green / 42 → Yellow / 4 → Red"
   summary. The *report* is shown; the *signed record* is what makes the finding durable.
5. **Grandfathering is org policy, not automatic.** A stronger verifier must not silently fail old builds.
   Config examples the reviewer gave: "new cells must pass ≥4.0; existing grandfathered unless modified,"
   or "critical cells auto-reverify to latest; normal cells original-sufficient." → this is a policy layer.

**Paper 1** (full historical provenance) reinforced "append-only, never lose history" — a lean toward
capturing everything. **Paper 2** (grants / security guard) carried a least-privilege instinct — protect
the sensitive key — a lean toward keyless routine reads.

**How the papers map to A/B/C:** they clearly reject C. They describe *both* a shown report and a signed
immutable record — which is literally Hybrid (A). The hash-vs-signature framing implies the reviewer is
comfortable with a *keyless, reproducible verdict* and treats the signature as the identity layer on top —
which supports the "open" default. Papers split on completeness (lean B) vs key hygiene (lean A); the
reconciliation they'd most likely endorse is **open by default, closeable by policy** — i.e. Hybrid + P4.

---

## 4. Open vs closed (the deeper axis)

The real axis under A-vs-B: **does the re-verdict require the verifier signing key to *compute and view*,
or only to *record*?**

**Key technical fact — re-verification is deterministic.** Computing "this old code is YELLOW under
today's verifier" needs no secret; it is just running the verifier over reconstructed code. The key is
only needed to *sign*. This is exactly the paper's hash-vs-signature split: the **verdict** falls out of
the bytes (reproducible by anyone); the **signature** adds identity. So "open viewing" is not a security
hole — it is reproducing a public computation.

**Caveat — Standard vs Durable.** In Durable mode, reconstructing history needs the *archive decryption
key* (`YAY_ARCHIVE_KEY`) regardless — separate from the verifier signing key. So "fully keyless" is only
truly keyless in Standard mode (plaintext git history). In Durable you always need the archive key to read
old blobs; the question is only whether you *additionally* need the signing key. (P3 ships Durable-only;
Standard reconstruct-from-git is not yet wired — see §6.)

**Arguments for OPEN (Hybrid keyless report):**
- Key hygiene / blast radius — don't pull the crown-jewel signing key into shells and CI just to look.
- Cheap preview before committing to a record; minting-on-peek spams the ledger.
- Independent reproducibility = stronger trust — an auditor with no key can reconstruct + re-run and
  confirm your signed reverdict matches; the signature stops being the only evidence.
- Broad visibility — contributors, forks, read-only clones can assess historical confidence.
- *Scenarios:* CI dashboard posting "42 cells would drop to Yellow" without the key in its env; external
  security audit with no key; solo/OSS maintainer wanting impact across 400 cells immediately.

**Arguments for CLOSED (Always sign, key required):**
- No ambiguous unsigned verdicts in circulation (a keyless report could be pasted as "official").
- Guaranteed complete record — opt-in signing lets a team look, shrug, and never record the fact.
- Compliance defensibility — "we looked but didn't record" is a liability in regulated settings.
- One path, no "did you remember `--attest`?" footgun.
- *Scenarios:* bank/compliance needing a signed record per re-assessment of a critical module;
  sloppy-follow-through team that won't run a second step; misinformation-averse org.

**Deciding asymmetry:** Hybrid can *become* closed by adding an enforcement policy; Closed cannot recover
Hybrid's keyless preview or key hygiene. Hybrid is strictly the more flexible base.

---

## 5. "Closeable by policy" — how it works (and why NOT an init switch)

The mechanism stays uniform (report keyless; signing records it). "Closed" becomes an **owner-signed
policy + posture**, in the same family as required-signers, non-delegable, `predicate: declared`, and the
foundation seal's Off/Guarded/Strict. A **reverification posture**:

- **Off** (default) — reverify is a pure tool; nothing enforced.
- **Guarded** — after the verifier capability bumps, `yay verify` / the gate *warns*: "signed history not
  re-verified under capability X.Y — run `yay reverify --all`."
- **Strict** — the gate *blocks* main until signed reverification records exist for the affected history
  (and, optionally, until regressions are acknowledged/ratified).

Two design points:
1. It enforces the **existence of the signed record at the gate — not key-possession at view time.** Anyone
   can still run the keyless report; the policy only requires that someone holding the verifier key has
   *recorded* the re-assessment before main advances. Key hygiene preserved; completeness guaranteed where
   it matters.
2. It is **scopeable by match** — `{ match: { tag: "critical" }, reverify: "latest" }` vs normal cells
   grandfathered. Exactly the paper's "critical cells auto-reverify / normal cells original-sufficient."
   This is the **P4** grandfathering layer; "Closed" is just its strictest posture.

**Why not make Hybrid-vs-Closed an init choice (like Durable vs Standard)? — No.** The distinguishing test:

- **Durable vs Standard is an *architecture/substrate* choice.** It changes *how history is physically
  captured* (encrypted content-addressed archive vs plaintext git). Expensive to change later because it
  changes the ground everything sits on → genuinely belongs at init.
- **Hybrid vs Closed is a *governance/enforcement* choice.** It changes nothing about the substrate or the
  engine — the re-verdict is the same deterministic computation either way. "Closed" is purely an
  enforcement overlay. In YayLayer, governance is always owner-signed **policy**, precisely so it can be
  **scoped** (critical vs normal — a boolean can't), **evolved without re-init** (land a compliance
  customer in year two by signing a new policy), and **attributed** (policy is owner-signed, so the record
  shows *who* tightened enforcement and *when* — an init flag is an unsigned config value).

Putting it at init would also **fragment the governance story** (an init flag + the P4 grandfathering
policy for one concern) and would imply "Closed" is a mechanism when it is a rule.

---

## 6. Decision & implementation

**Decision:**
- **Mechanism: uniformly Hybrid.** One engine; keyless deterministic report; sign-to-record via `--attest`.
- **Enforcement: an optional owner-signed reverification posture** (Off → Guarded → Strict), scopeable,
  default **Off** so the happy path stays simple. Delivered in **P4** (alongside grandfathering).
- **Init stays lean** — no new fork. Discoverability comes from the **post-capability-bump nudge**
  (`yay verify` / `yay attest`) and docs, not an init prompt.

**Shipped in P3 (2026-08-31):**
- `yay reverify --all` — historical sweep → rendered "verifier upgrade report" (keyless). `--since <date>`
  and `--eligible` filters; `-o <file>` saves a plaintext copy; `--json` emits the report as data.
- `yay reverify --all --attest` — mints signed, append-only reverification records (`kind:"reverification"`)
  that reference the original attestation, validate under the verifier key, and chain into the ledger.
  Dedups on `(reassesses × capability × codeTreeHash)`; requires the verifier key (clear error without it).
- Post-capability-bump nudge in `reportAttestStatus` (shown under `yay verify` / `yay attest`).
- Record model: `src/reverify.js` `reverificationObj()` wraps the reconstructed state's verification object
  (today's capability judging historical code/spec) as a reverification; signed via `A.signAttestation`,
  appended via `A.appendAttestation` — the SAME chain + verifier identity as `yay attest`.
- Tests: `test/reverify-p3.js` (13 checks) via the shared scenario factory.

**Shipped in P4 (2026-08-31) — the grandfathering posture ("closeable by policy"):**
- `yay reverify posture [off|guarded|strict]` — a project-level gate control stored in committed config
  (`config.reverification`), set via the command, mirroring the foundation seal posture EXACTLY.
  off = grandfather all preserved history (default) · guarded = `yay verify` warns when history predates
  the current capability · strict = the gate BLOCKS until each such state has a signed reverification
  under the current capability.
- Enforcement is on the EXISTENCE of the signed record at the gate — never key-possession at view time
  (the keyless report stays available under any posture). `reverifyGate()` in `src/reverify.js` is the
  pure consultation (ledger + snapshots + capability → { pending, satisfied }); `reportReverifyPosture()`
  surfaces it under `yay verify` and folds a strict, unsatisfied posture into the gate `blocked` decision.
- **Deliberate scope call:** the posture is NOT a per-Cell capability policy kind, so it is absent from
  the capability fingerprint and required NO capability bump — consistent with the foundation posture,
  which is likewise a project-level gate control outside the fingerprint (it changes gate enforcement, not
  how any Cell's verdict is computed). This also avoided the site `capabilities.json` blast radius.
- Tests: `test/reverify-p4.js` (12 checks) — default off, CLI set/show/persist, strict-satisfied when
  history is current, pending under a newer capability (guarded warns / strict blocks), and a
  reverification at the new capability clearing the pending state.

**Open questions / follow-ups (P4b / P5+):**
- **Per-Cell scoping** (the "critical cells reverify / normal grandfathered" refinement) — an owner-signed
  policy rule `{ match: {...}, reverify: "latest" }`. This WOULD be a new POLICY_KIND (`reverify-latest`),
  so it forces a capability bump (1.1.0 → 1.2.0) + a new REGISTERED fingerprint + a site
  `capabilities.json` update. Deferred deliberately: the project-wide posture already delivers a complete
  grandfathering model (off = grandfather-all default; strict = require-all), and scoping is a refinement
  worth its own change so the capability bump is clean and intentional.
- **Posture hardening** — the posture lives in committed config (like `config.foundation`), so it is
  AI-writable in principle; a future step could move it into the owner-signed enforced policy (roster) for
  tamper-evidence, exactly as `yay policy --set` does for signing rules. Matches the foundation precedent's
  current limitation.
- **`assumeSigned` artifact** — reverify treats a reconstructed state as approved, so a Cell that was
  UNSIGNED at attest time reads as an *improvement* (UNSIGNED→GREEN) on reverify. Harmless but slightly
  noisy in the report; consider tracking which cells were actually signed in the snapshot, or excluding
  never-signed cells from the diff.
- **Per-cell dedup in the report** — a cell that recurs across many states lists once per state; consider
  a "by cell" rollup for long histories.
- **Standard-mode reconstruct-from-git** — P3 sweeps Durable snapshots only; wire git-based reconstruction
  so Standard-mode repos can sweep too.
- **`yay attest list`** could label reverification entries distinctly (kind is in the object, not the index).
- **Behavioural re-proof (P5)** with reconstructed historical dependencies.
