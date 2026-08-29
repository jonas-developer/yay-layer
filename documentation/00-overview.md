# 00 — Overview

## The problem

AI agents now write large amounts of code, fast. The bottleneck is no longer *producing* code — it's **trusting** it. "A human clicked approve" is a weak claim: approve *what*, exactly? The code the AI happened to show them? The code that shipped? Under what standard of "correct"? Most tooling stops here.

## What YayLayer is

YayLayer is a **human authorization and cryptographic provenance layer** that sits between an AI (or a human) producing code and that code being trusted. It rests on one discipline:

> **Humans authorize *intent*. Machines demonstrate *conformance*. Neither grades itself.**

Concretely:

- Code is organized into **Cells** — a unit of code with a **specification** block above it (behavioral promises, in a tiny structured grammar).
- A **human signs the spec + a plain-English Brief** with a key that lives on their **phone**. The signature covers the *intent*, **never the code bytes**.
- A deterministic, **non-AI verifier** re-derives whether the code satisfies the signed spec and assigns a state: **Green / Yellow / Red / Unsigned / Pink**.
- A CI **gate** blocks anything not-Green from `main` — enforcement lives in infrastructure the AI doesn't control, not in a local hook.
- For autonomous work, a human issues a bounded **grant** (**Autopilot**) so the AI can produce and provisionally act within limits, to be **ratified** by a human afterward.
- Every authorization, verification, and ratification is an **immutable, content-addressed, attributable record**.

## The triad

Three actors, three different kinds of claim, so no actor grades its own work:

| Actor | Role | What it is allowed to assert |
|-------|------|------------------------------|
| **Human** | Authority / judgment | "I authorize this intent/scope" / "I ratify this result." |
| **Agent** (AI) | Production | "I created these Briefs, specs, and code." *(the least-trusted party)* |
| **Machine verifier** | Deterministic assessment | "Under verifier X + ruleset Y, this exact code satisfies this exact spec → Z." |

The agent can *propose*; the verifier can *measure*; the human can *authorize*. The agent — however capable — is treated as the **untrusted producer**: it may say *what* it made, never that its work is correct or that a human approved it.

## The core promise

> **Every statement material to an approval should remain reconstructable forever, unless an explicit retention policy says otherwise — and no historical record is ever silently rewritten.**

That promise is what separates YayLayer from a signing convenience. It turns the question from *"did a human approve this code?"* into a much richer set an auditor actually needs:

- Who had authority to cause this change, and where did that authority come from?
- What limits were placed on it?
- What exactly did the agent do with it?
- What did the verifier establish, and under which version of its own semantics?
- When did a human actually inspect and ratify the result?
- What changed afterward?

## What it is *not*

- **Not** a code-approval system. You never sign "these exact bytes are correct." A refactor that preserves the spec needs no new signature.
- **Not** a blockchain. Tamper-evidence is an append-only hash chain; no consensus, no tokens, no network.
- **Not** an AI grading itself. The verifier is deliberately **non-AI** — bounded, reproducible, versioned, and cryptographically identifiable.

## Where to go next

- New to the model → [01 — Concepts](01-concepts.md).
- Want the durable-audit architecture → [02 — Provenance architecture](02-provenance-architecture.md).
- Agentic/autonomous workflows → [03 — Autopilot](03-autopilot-delegated-execution.md).
- Just want to use it → [05 — How-to](05-how-to.md).
