# 04 — Languages

YayLayer handles languages at **three tiers**. Which tier a language reaches is part of the **verifier's capability version** — so a language moving from static to proven is a capability bump that can [re-verify history](02-provenance-architecture.md#verifier-versioning).

## The tiers

The **"Ceiling"** column is the *best* state a **well-formed, signed Cell** can reach at that tier — not the only possible state. **Pink** (a unit with no Cell) and **Red** (code that contradicts its spec, e.g. `pure: yes` but does I/O) are outcomes for *problem* code and can happen at **every** tier; they're failures, not ceilings. So the tiers differ only in how high *good* code can climb: **Green** (proven) vs **Yellow** (statically checked but not executed).

| Tier | What the verifier does | Ceiling for a good, signed Cell |
|------|------------------------|----------------------|
| **Proven** | Extracts Cells · flags un-specced code Pink · per-language effect/purity nets · coverage · rename detection · **executes** the code against its `ensures` (behavioral prover) | **Green** (machine-proven) |
| **Static** | Same checks — Cells · Pink for un-specced code · effect/purity nets · coverage · rename detection — but **does not execute** | **Yellow** (honest cap; can't reach Green without a prover) |
| **Scanned** | Recognized and marker-parsed only (no per-language effect net) | **Yellow** (weaker — no effect net) |

Enforcement is by **detection**: even at the Static tier a language is first-class on the gate — un-specced code goes Pink, declared-pure-but-effectful goes Red — it just can't reach *machine-proven* Green until an executing adapter exists.

## Support matrix

Legend: ✅ shipped in 1.0 · 🔭 later.

| Language | Extensions | Tier in 1.0 | Notes |
|----------|-----------|---------------------|-------|
| **JavaScript / TypeScript** (incl. JSX/TSX) | `.js .ts .jsx .tsx .mjs .cjs` | **Proven** ✅ | Full: AST via `@babel/parser`, behavioral prover + mutation grading + inertness; JSX render prover (`renders: yes`). Node.js = this. |
| **Python** | `.py .pyw` | **Proven** ✅ | Out-of-process `python3` subprocess; pure functions with `ensures` reach proven Green. |
| **Ruby** | `.rb` | **Proven** ✅ | `ruby` subprocess adapter (Python pattern) + Ruby effect/purity net. Proof covers **top-level/module functions** only; class/instance methods & framework-coupled code (Rails) → Yellow ([limits](#current-proving-limits-rubyphp--rails)). |
| **PHP** | `.php` | **Proven** ✅ | `php` subprocess adapter (Python pattern) + PHP effect/purity net. Same **top-level-only** proof scope; class/instance methods → Yellow ([limits](#current-proving-limits-rubyphp--rails)). |
| **Solidity** | `.sol` | **Static** ✅ (proven 🔭) | Solidity effect/purity net (static, first-class gate). Behavioral proof needs an EVM harness (Foundry/Hardhat) — its own later release. |
| **Rust** | `.rs` | **Static** ✅ (proven 🔭) | Rust effect/purity net. Behavioral proof needs a compile-harness (`rustc`/`cargo`) — a `1.x` capability bump. |
| **C#** | `.cs` | **Static** ✅ (proven 🔭) | C# effect/purity net. Behavioral proof needs a compile-harness (`dotnet`) — a `1.x` capability bump. |
| Others (Go, Java, C/C++, Kotlin, Swift, Scala, Dart, Perl, shell, Elixir…) | various | **Scanned/Static** ✅ | Marker-parsed, capped at Yellow; per-language effect nets added opportunistically. |

## What "v1 language work" actually is

1. **Per-language effect/purity nets for all five** (Ruby, PHP, Solidity, Rust, C#) — before this, non-JS/non-Python languages fell back to the *JavaScript* effect regexes, which don't match e.g. Ruby's `File.write` or PHP's `curl_exec` (a **missed Red**). Real per-language nets make all five first-class on the gate. ✅ 1.0.
2. **Behavioral proof adapters for Ruby + PHP** — the same out-of-process subprocess pattern as Python (detect the runtime, evaluate `ensures`, pure functions reach Green). ✅ 1.0.
3. **Deferred:** C# → Rust → Solidity behavioral proof, each a `1.x` capability bump. Solidity is the hardest (EVM harness) and gets its own release. 🔭 Later.

## Current proving limits (Ruby/PHP) & Rails

The subprocess provers today resolve only **top-level / module functions** — they run the file and call `method(:name)` / `function_exists`. So:

- **Class and instance methods aren't proven yet** — a `class PriceCalc; def self.total …` or an instance method skips to **Yellow** (signed + statically checked, not machine-Green). Extending the harness to call `Klass.method` / instance methods (receiver + args from the spec) is the [top language follow-up](09-roadmap-and-build-plan.md#explicitly-deferred-post-10) — it's what unlocks proven-Green for pure **Rails service objects / value objects**.
- **Framework-coupled code isn't proven** — the prover doesn't boot Rails, so anything touching `ActiveRecord`, `params`, associations, or Rails constants skips to Yellow (honestly). A "boot the framework" harness is a separate, much larger effort.

So **Rails can adopt YayLayer now** for governance + the gate + provenance across the whole app; **machine-proof** currently lands on the pure, top-level slice (e.g. helpers in `lib/`). The effect net still correctly turns a `pure: yes` method that hits the DB/IO **Red** anywhere.

> `.ex/.exs` (Elixir) share Ruby's `def…end` body-grabbing but are classified `elixir` — **scanned only**, no Ruby effect net or prover. Pure Ruby is the supported target.

## Graceful toolchain degradation

Behavioral proof needs the language runtime on the machine/CI. This is never a hard dependency: the adapter **detects** the toolchain (`ruby`, `php`, `python3`, later `dotnet`/`cargo`/`forge`) — if present it proves; if absent it **honestly caps at Yellow**, never errors. (This is how the Python adapter already behaves.)

## Architecture: the pluggable adapter

✅ Shipped. Proving is pluggable behind one contract. Today: `ADAPTERS = [renderAdapter, pythonAdapter, pureCallAdapter]` in `src/prove.js`, with a shared driver (`proveManifest` + `runCases` / `runMutation` / `runInertness` / `runSeeded`). Adding Ruby/PHP/etc. means new adapters implementing the same contract — it's an *effort* question, not a redesign.

## Determinism (why this matters for attestations)

The prover is **logically deterministic** — no RNG; inputs are enumerated, mutants are a fixed set, execution is synchronous. Same code + spec + verifier version + machine ⇒ identical verdict every run. The only nondeterminism is **environmental**: wall-clock timeouts (a `2s` VM limit; `4–8s` subprocess limits) can flip a verdict for code running *near* the limit under heavy load, and cross-environment differences (Node/OS/float/Python version). So an attestation records the environment and claims *"Green under this verifier + this environment at this time,"* not "Green everywhere forever." A later hardening replaces the wall-clock timeout with a deterministic step/fuel budget (or at least flags "timing-sensitive" cases in the evidence). See [02](02-provenance-architecture.md#verifier-versioning) and [10 — Decision log](10-decision-log.md).
