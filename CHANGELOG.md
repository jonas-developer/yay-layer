# Changelog

All notable changes to YayLayer. Format loosely based on [Keep a Changelog](https://keepachangelog.com/).

Two version numbers matter here: the **package** version (npm) and the verifier's **capability version** — what "Green" means, recorded in every attestation and cross-checkable at [yaylayer.com/capabilities.json](https://yaylayer.com/capabilities.json). They move independently.

## [Unreleased] — 1.0.0 (relaunch)

The clean relaunch: the whole architecture ships in 1.0. (`0.1.0` was withdrawn — see below.) Verifier **capability 1.2.0**.

### Provenance & verification
- Spec-mirrored **Cells**, human-signed **Briefs**, a deterministic non-AI verifier, and the Green / Yellow / Red / Unsigned / Pink gate.
- **Verifier attestation** (`yay attest`) — the machine signs its own verdict with a project/CI-scoped key (never shipped in the package); append-only, chained, capability-versioned. Keyless in-browser check at `yaylayer.com/verify`.
- **Reverify engine** — `yay reverify --all` (historical sweep → keyless upgrade report), `--attest` (signed, append-only reverification records), and `yay reverify posture off|guarded|strict` (grandfathering).
- Behavioural proving for **JS/TS/JSX** + **Python/Ruby/PHP** (top-level/module functions); first-class effect nets for **Solidity/Rust/C#**.
- Anti-payload pincer (all deterministic): **inertness**, **literal-seeding**, and **undeclared-input predicate provenance** (◈).

### Governance
- Autopilot **grants** as signed capability envelopes (+ child grants), **ratification** with first-class **rejections**, and earned-autonomy metrics.
- Owner-signed **roster**, signing **policy**, the **foundation seal**, and the integrity **witness**.
- **Durable mode** — an encrypted, sha256-anchored archive of the signed source.

### Signing & teams
- Phone signing with **WYSIWYS** over LAN or the end-to-end-encrypted relay; local encrypted-keystore option; **24-word** recovery; enroll / revoke / reroot.

### Verifier capability history
- `1.0.0` (baseline) → `1.1.0` (undeclared-input predicate provenance) → **`1.2.0`** (the `reverify-latest` policy kind for grandfathering).

## [0.1.0] — withdrawn
Early preview, **unpublished** from npm (its verification story overclaimed). Superseded by the 1.0 relaunch, which states exactly what is signed, what is checked, and what is not.
