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
- A CI **gate** blocks **Red, Unsigned, and Pink** from `main` (Yellow — signed but not machine-proven — is allowed) — enforcement lives in infrastructure the AI doesn't control, not in a local hook.
- For autonomous work, a human issues a bounded **grant** (**Autopilot**) so the AI can produce and provisionally act within limits, to be **ratified** by a human afterward.
- Every authorization, verification, and ratification is an **immutable, content-addressed, attributable record**.

> **What "Green" means — and doesn't.** Green = a human signed this Cell's spec **and** today's verifier, at its documented capability, found the code conforms by *executing it against spec-derived inputs* and mutation-grading the result. It is a **bounded, deterministic conformance check** — **not** a formal proof of correctness for all inputs, a security audit, or a guarantee the code is free of vulnerabilities. Languages without a behavioural prover cap at **Yellow** (signed, not machine-proven). A verdict is always "Green under *this* verifier + capability + exercised inputs, at this time" (see [Verifier versioning](02-provenance-architecture.md#verifier-versioning)).

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

## Maturity levels — start small, grow into it

YayLayer has a lot of surface, but you don't meet it all at once. Each level is optional depth on top of the last; newcomers live at Level 1.

| Level | What you add | Get it from |
|-------|--------------|-------------|
| **1 · Core loop** | A spec'd **Cell**, a signed **Brief**, `yay verify` (Green ↔ Red). | [Quickstart / How-to](05-how-to.md) |
| **2 · Enforce & collaborate** | The **CI gate** (`yay gate`), **teams** (signed roster), signing **policy**. | [How-to](05-how-to.md) · [Teams](08-teams-roles-and-recovery.md) |
| **3 · Delegate** | **Autopilot** grants + **ratification** + earned-autonomy from rejections. | [Autopilot](03-autopilot-delegated-execution.md) |
| **4 · Audit & regulate** | **Durable** mode, verifier **attestations** + keyless verify, **reverify**, the **foundation seal**, the integrity **witness**. | [Provenance](02-provenance-architecture.md) |

Everything above Level 1 is there when a project — or an auditor — needs it, and out of the way until then.

## Where to go next

- New to the model → [01 — Concepts](01-concepts.md).
- Want the durable-audit architecture → [02 — Provenance architecture](02-provenance-architecture.md).
- Agentic/autonomous workflows → [03 — Autopilot](03-autopilot-delegated-execution.md).
- Just want to use it → [05 — How-to](05-how-to.md).
