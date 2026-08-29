# 04 — Languages

YayLayer handles languages at **three tiers**. Which tier a language reaches is part of the **verifier's capability version** — so a language moving from static to proven is a capability bump that can [re-verify history](02-provenance-architecture.md#verifier-versioning).

## The tiers

| Tier | What the verifier does | Best state reachable |
|------|------------------------|----------------------|
| **Proven** | Executes the code against its `ensures` / spec (behavioral prover) + per-language effect/purity nets + coverage + rename detection | **Green** (machine-proven) |
| **Static** | Extracts Cells, grabs unit bodies, flags un-specced code **Pink**, checks coverage, per-language effect/purity nets, rename detection — but does **not** execute | **Yellow** (honest cap) |
| **Scanned** | Recognized and marker-parsed only (no per-language effect net) | Yellow, weaker checks |

Enforcement is by **detection**: even at the Static tier, a language is first-class on the gate — un-specced code goes Pink, declared-pure-but-effectful goes Red — it just can't reach *machine-proven* Green until an executing adapter exists.

## Support matrix

Legend: ✅ shipped · 🔜 v1 (building) · 🔭 later.

| Language | Extensions | Tier target for 1.0 | Notes |
|----------|-----------|---------------------|-------|
| **JavaScript / TypeScript** (incl. JSX/TSX) | `.js .ts .jsx .tsx .mjs .cjs` | **Proven** ✅ | Full: AST via `@babel/parser`, behavioral prover + mutation grading + inertness; JSX render prover (`renders: yes`). Node.js = this. |
| **Python** | `.py .pyw` | **Proven** ✅ | Out-of-process `python3` subprocess; pure functions with `ensures` reach proven Green. |
| **Ruby** | `.rb` | **Proven** 🔜 | v1: `ruby` subprocess adapter (Python pattern) + Ruby effect/purity net. |
| **PHP** | `.php` | **Proven** 🔜 | v1: `php` subprocess adapter (Python pattern) + PHP effect/purity net. |
| **Solidity** | `.sol` | **Static** 🔜 (proven 🔭) | v1: Solidity effect/purity net (static, first-class gate). Behavioral proof needs an EVM harness (Foundry/Hardhat) — its own later release. |
| **Rust** | `.rs` | **Static** 🔜 (proven 🔭) | v1: Rust effect/purity net. Behavioral proof needs a compile-harness (`rustc`/`cargo`) — a `1.x` capability bump. |
| **C#** | `.cs` | **Static** 🔜 (proven 🔭) | v1: C# effect/purity net. Behavioral proof needs a compile-harness (`dotnet`) — a `1.x` capability bump. |
| Others (Go, Java, C/C++, Kotlin, Swift, Scala, Dart, Perl, shell, Elixir…) | various | **Scanned/Static** ✅ | Marker-parsed, capped at Yellow; per-language effect nets added opportunistically. |

## What "v1 language work" actually is

1. **Per-language effect/purity nets for all five** (Ruby, PHP, Solidity, Rust, C#). Today non-JS/non-Python languages fall back to the *JavaScript* effect regexes, which don't match e.g. Ruby's `File.write` or PHP's `curl_exec` — so a declared-pure-but-effectful unit isn't caught (a **missed Red**). Real per-language nets fix this and make all five first-class on the gate. 🔜 v1.
2. **Behavioral proof adapters for Ruby + PHP** — the same out-of-process subprocess pattern as Python (detect the runtime, evaluate `ensures`, pure functions reach Green). 🔜 v1.
3. **Deferred:** C# → Rust → Solidity behavioral proof, each a `1.x` capability bump. Solidity is the hardest (EVM harness) and gets its own release. 🔭 Later.

## Graceful toolchain degradation

Behavioral proof needs the language runtime on the machine/CI. This is never a hard dependency: the adapter **detects** the toolchain (`ruby`, `php`, `python3`, later `dotnet`/`cargo`/`forge`) — if present it proves; if absent it **honestly caps at Yellow**, never errors. (This is how the Python adapter already behaves.)

## Architecture: the pluggable adapter

✅ Shipped. Proving is pluggable behind one contract. Today: `ADAPTERS = [renderAdapter, pythonAdapter, pureCallAdapter]` in `src/prove.js`, with a shared driver (`proveManifest` + `runCases` / `runMutation` / `runInertness` / `runSeeded`). Adding Ruby/PHP/etc. means new adapters implementing the same contract — it's an *effort* question, not a redesign.

## Determinism (why this matters for attestations)

The prover is **logically deterministic** — no RNG; inputs are enumerated, mutants are a fixed set, execution is synchronous. Same code + spec + verifier version + machine ⇒ identical verdict every run. The only nondeterminism is **environmental**: wall-clock timeouts (a `2s` VM limit; `4–8s` subprocess limits) can flip a verdict for code running *near* the limit under heavy load, and cross-environment differences (Node/OS/float/Python version). So an attestation records the environment and claims *"Green under this verifier + this environment at this time,"* not "Green everywhere forever." A later hardening replaces the wall-clock timeout with a deterministic step/fuel budget (or at least flags "timing-sensitive" cases in the evidence). See [02](02-provenance-architecture.md#verifier-versioning) and [10 — Decision log](10-decision-log.md).
