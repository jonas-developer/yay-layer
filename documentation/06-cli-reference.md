# 06 — CLI reference

Every command and its main flags. ✅ = shipped in 1.0. Passphrases/keys come from `.env` or env vars. Run `yay help` for the terse version.

## Setup & identity

**`yay init [dir]`** ✅ — Guided setup: files → signing key → adopt → Brief tags → Constitution → optional System Plan.
- `--key local|mobile` · `--relay` / `--lan` (mobile transport) · `--name <you>` · `--tags <set>` · `--adopt` / `--no-adopt` · `--constitution <keys|all>` · `--plan` / `--no-plan` · `--provider anthropic|openai|custom`
- `--durable` ✅ — start in Durable mode (encrypted, sha256-anchored source archive). Switch anytime with `yay archive enable|disable`.

**`yay keygen --name <you>`** ✅ — Create your ed25519 signing key (public → roster, private → encrypted keystore). `--passphrase <p>`.

**`yay pair [--name you]`** ✅ — Pair your phone as the signing device.

**`yay enroll --name X --pubkey <b64>`** ✅ — Enroll another signer via an owner-signed roster event. `--role owner|signer` · `--by <owner>` · `--phone`.

**`yay invite "Bob"`** ✅ — Mint a 30-min one-time join link; approve on your phone. `--role owner|signer`.

## The core loop

**`yay sign [--cell IDs]`** ✅ — Approve the current specs; append a signed seal. Uses the project's signing method automatically.
- `--brief "<text>"` (required by default) · `--title "<headline>"` · `--tags "A,B"` · `--name "<signer>"` (route to a teammate) · `--check [id]` · `--phone` / `--local` · `--no-brief` · `--relay` / `--lan` · `--cell <ids>`.

**`yay verify`** ✅ — Colour every Cell against the working tree. `--strict` (CI: non-zero on Red/Unsigned/Pink) · `--dir <path>`. Reports whether a signed verifier attestation covers the exact current tree (stale on drift).

**`yay batch <n>` / `yay batch off`** ✅ — Set the batch barrier (group N small changes into one Brief) or disable batching.

## Autopilot (Delegated execution)

**`yay grant [--for 2h] [--count 20]`** ✅ — Issue a bounded, owner-signed **capability envelope**. The AI then auto-produces in-scope, non-sensitive Cells until the grant expires or hits the count. The signature covers the exact envelope.
- `--for <dur>` (2h/90m/1d) · `--count <n>` · `--cell <ids>` · `--allow "<glob>"` · `--deny "<glob>"` · `--max-risk low|medium|high` · `--child-grants` `[--max-depth N]` · `--deps` / `--deploy` (recorded, detector-gated) · `list` · `revoke [id]`.
- **Non-delegable areas** come from owner-signed policy (`{ "delegable": false }`, path/tag/module) — outside the AI-writable surface. A delegated approval that lands outside its envelope is a gate-blocking **grant violation** (the verifier backstop).

**`yay ratify [--sign]`** ✅ — List Cells delegated under a grant (not human-reviewed); `--sign` human-signs them for real. Shows grant scope + a **boundary/deviation report** + the verifier attestation. `--sign` is **TOCTOU-safe** (signs the exact reviewed bundle, refuses on drift). State vocabulary: Delegated / Awaiting / Ratified / Rejected / Superseded (never "auto-approved").
- `--reject --reason "<why>" [--category <…>] [--cell IDs]` ✅ — record a signed, append-only **Rejection** (kept as provenance; the code stays unsigned until fixed).

## Provenance & assurance

**`yay attest [list|verify]`** ✅ — Mint a **signed verifier attestation** over the current verdict (the verifier signs its own result — the third crypto identity). Run at commit / after a green verify. Refuses a blocked gate unless `--force`. Append-only, chained, capability-versioned. `list` shows the ledger; `verify` re-checks every attestation (`--strict` exits non-zero on any invalid). The verifier private key stays machine-side (gitignored); the public verifier of record is pinned in `config.verifier` (committed).

**`yay reverify`** ✅ — Re-run verification at the current verifier capability; if a capability bump, a verdict change (e.g. Yellow→Green), or code drift is found, **append** a new attestation chained to the prior one (never rewrites old Green). Prints an upgrade report. `--force` records a failing re-verification.

**`yay witness [--strict]`** ✅ — Integrity witness: cross-check the attestation chain, the spec archive, and whether the latest attestation still covers the code (git/tree vs ledger vs archive).

**`yay metrics`** ✅ — Earned-autonomy metrics from the delegation + ratification + rejection history (per-category rejection rates; suggests categories to stop delegating).

**`yay archive [enable|disable|--forget|--restore|--verify|install]`** ✅ — Durable mode. `enable`/`disable` the mode; (default) archive the covered signed files (encrypted AES-256-GCM, sha256-anchored); `--forget <hash> --reason "…"` writes a signed **tombstone** (honest erasure); `--restore <hash>` decrypts; `--verify` checks every blob decrypts + anchors; `install` adds a git post-commit hook. Key is project-held (`$YAY_ARCHIVE_KEY` or a passphrase), **never stored by YayLayer**; a pre-archive **secret scan** refuses to seal secrets.

## Dashboard & maps

**`yay dashboard [--port N]`** ✅ — Live control panel + phone relay: the map (auto-refreshes), on-demand buttons (Request a change, Preview, Changes, Run tests, Adversary, Regenerate System Plan), and Briefs / Tags / Policy tabs. Routes pair/sign/authorize to the phone you scanned once. `--open` · `--no-https`.

**`yay map [-o file.html]`** ✅ — Write the static HTML map.

**`yay gate`** ✅ — Write the CI gate workflow.

**`yay constitution --for <keys>`** ✅ — Write the Constitution into your AI-harness files (`CLAUDE.md`, `AGENTS.md`, …).

**`yay status`** ✅ — One-line summary.

## Vocabulary & policy

**`yay tags [--set id]`** ✅ — The project's Brief-tag pool. `--set <id>` (technical/responsibility/component/layer/area/product/custom) · `add "Tag"` · `remove "Tag"` · `rename "A" "B"` (blocked once used in a signed Brief) · `desc "Tag" "…"` · `sets`.

**`yay policy [--set]`** ✅ — View enforced + draft signing policy; `--set` owner-signs the draft into effect. Rules bind path/tag/module → required signer, inert-code level, or ignore authorization.

**`yay adopt`** ✅ — Scaffold spec blocks over existing code.

**`yay requests`** ✅ — Pick up queued change-requests (turned into Briefs + specs).

## Later versions

- **Behavioral proof for C# / Rust / Solidity** (compile/EVM harnesses), **class/instance-method proving** (Ruby/PHP → pure Rails service objects), and **framework-boot provers** — see [04 — Languages](04-languages.md#current-proving-limits-rubyphp--rails).
- **Hosted attestation service** — the verifier key is project/CI-scoped today; a hosted signing/verification service is a later option.
