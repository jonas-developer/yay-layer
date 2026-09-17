# YayLayer — Project Documentation

> **A human authorization and cryptographic provenance layer for AI-generated code.**
> Humans authorize *intent*; the machine verifier demonstrates that implementations *conform*; every step is an immutable, attributable record.

This is the **canonical manual** — the source of truth we build the engine against. It is committed with the code (unlike `/docs`, which holds local design scratch). When design and code disagree, we fix one of them here first.

## How to read these docs

Each section is numbered. Concepts (01) and Architecture (02–03) are the "what and why." How-to (05) and CLI (06) are the "how." Roadmap (09) and the Decision Log (10) tell you what's built, what's next, and *why we chose it*.

Everything is tagged with a **status** so the docs never claim unbuilt things exist:

- ✅ **Shipped** — in the current engine today.
- ✅ **1.0** — shipped in the fresh `1.0` relaunch.
- 🔭 **Later** — planned for a post-1.0 version.

## Index

| # | Section | What's in it |
|---|---------|--------------|
| 00 | [Overview](00-overview.md) | What YayLayer is, the pitch, the triad, the core promise |
| 01 | [Concepts](01-concepts.md) | Cells, specs, Briefs, the triad, the two chains, three identities, the two axes, "Green is an event" |
| 02 | [Provenance architecture](02-provenance-architecture.md) | Append-only content-addressed store, spec archive, verifier attestation, capture points, storage, Standard vs Durable, governance, verifier versioning |
| 03 | [Autopilot (Delegated execution)](03-autopilot-delegated-execution.md) | Grants & the capability envelope, delegated→ratified states, non-delegable defaults, ratification, boundary reporting, earned autonomy |
| 04 | [Languages](04-languages.md) | Support matrix by tier and verifier version |
| 05 | [How-to guides](05-how-to.md) | init · adopt · sign · batch · Autopilot · ratify · verify · dashboard · CI gate · recovery · tags · policy · Standard vs Durable |
| 06 | [CLI reference](06-cli-reference.md) | Every command + flags |
| 07 | [Security model](07-security-model.md) | Key separation, verifier-key rule, phone signing, TOCTOU, injection resistance, integrity witness |
| 08 | [Teams, roles & recovery](08-teams-roles-and-recovery.md) | Signers vs owners, the roster, enroll/invite/revoke/re-root, signer routing, signing methods, recovery |
| 09 | [Roadmap & build plan](09-roadmap-and-build-plan.md) | P0–P4, what's in 1.0, what's deferred |
| 10 | [Decision log](10-decision-log.md) | Locked decisions (3 advisor papers + our calls) with rationale |
| 11 | [Glossary](11-glossary.md) | Terms |
| — | [reference/](reference/) | Deeper reference (attestation schemas, object-store layout) — **to be finalized during implementation** |

## The one-paragraph version

You (or your AI) write a **Cell**: a small block of code with a signed *specification* above it. Before the code is trusted, a **human signs the spec + a plain-English Brief** — never the code bytes. A deterministic, non-AI **verifier** then re-derives, continuously, whether the code still satisfies the signed spec, and colors each Cell Green / Yellow / Red / Unsigned / Pink. A CI **gate** blocks anything not-Green from `main`. For agentic workflows, a human can issue a bounded **grant** (Autopilot) letting the AI produce and provisionally act within limits, to be **ratified** later. Every authorization, verification, and ratification is an immutable, content-addressed, attributable record — so years later you can prove *who authorized what, what the machine established, and what changed since*.
