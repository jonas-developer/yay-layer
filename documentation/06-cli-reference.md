# 06 — CLI reference

Every command and its main flags. ✅ = shipped today; 🔜 = flags/behavior changing for v1. Passphrases/keys come from `.env` or env vars. Run `yay help` for the terse version.

## Setup & identity

**`yay init [dir]`** ✅ — Guided setup: files → signing key → adopt → Brief tags → Constitution → optional System Plan.
- `--key local|mobile` · `--relay` / `--lan` (mobile transport) · `--name <you>` · `--tags <set>` · `--adopt` / `--no-adopt` · `--constitution <keys|all>` · `--plan` / `--no-plan` · `--provider anthropic|openai|custom`
- 🔜 v1: `--provenance standard|durable`.

**`yay keygen --name <you>`** ✅ — Create your ed25519 signing key (public → roster, private → encrypted keystore). `--passphrase <p>`.

**`yay pair [--name you]`** ✅ — Pair your phone as the signing device.

**`yay enroll --name X --pubkey <b64>`** ✅ — Enroll another signer via an owner-signed roster event. `--role owner|signer` · `--by <owner>` · `--phone`.

**`yay invite "Bob"`** ✅ — Mint a 30-min one-time join link; approve on your phone. `--role owner|signer`.

## The core loop

**`yay sign [--cell IDs]`** ✅ — Approve the current specs; append a signed seal. Uses the project's signing method automatically.
- `--brief "<text>"` (required by default) · `--title "<headline>"` · `--tags "A,B"` · `--name "<signer>"` (route to a teammate) · `--check [id]` · `--phone` / `--local` · `--no-brief` · `--relay` / `--lan` · `--cell <ids>`.

**`yay verify`** ✅ — Colour every Cell against the working tree. `--strict` (CI: non-zero on Red/Unsigned/Pink) · `--dir <path>`.
- 🔜 v1/later: mints a signed **verification attestation** at commit/verify-pass.

**`yay batch <n>` / `yay batch off`** ✅ — Set the batch barrier (group N small changes into one Brief) or disable batching.

## Autopilot (Delegated execution)

**`yay grant [--for 2h] [--count 20]`** ✅ — Issue bounded delegated authority (owner-signed). The AI then auto-produces in-scope, non-sensitive Cells until the grant expires or hits the count.
- `--for <dur>` (2h/90m/1d) · `--count <n>` · `--cell <ids>` · `list` · `revoke [id]`.
- 🔜 v1: capability-envelope flags (allowed/prohibited paths, `--no-deps`, `--max-cells`, `--risk`, `--no-deploy`, `--no-child-grants`); signature covers the exact envelope.

**`yay ratify [--sign]`** ✅ 🔜 — List Cells delegated under a grant (not human-reviewed); `--sign` human-signs them for real.
- 🔜 v1: shows the built code + boundary/deviation report; `--sign` is **TOCTOU-safe** (signs the exact reviewed bundle, refuses on drift); persists **Rejected** events; state vocabulary is Delegated/Awaiting/Ratified/Rejected (never "auto-approved").

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

## Planned commands

- **`yay archive --install`** 🔭 — install the commit-time git hook for Durable-mode code archival.
- **`yay reverify [--since <verifier-version>]`** 🔭 — re-evaluate historical attestations with the current verifier; append new results (never rewrite).
