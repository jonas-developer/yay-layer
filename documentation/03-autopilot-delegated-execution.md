# 03 — Autopilot (Delegated execution)

**Autopilot** is the friendly name; **Delegated execution** is the formal/enterprise term. It is bounded, revocable, ratified delegation with the human in control. The technical nouns: `yay grant`, **Delegated**, **Ratified**.

> **A grant is authorization to *act*. It is not approval of the resulting artifact.** Reserve "approved" for actual human signatures.

## Why it exists

A future with capable coding agents cannot require a human signature before every tiny action — that's approval fatigue. Autopilot is **controlled delegation**: the human pre-authorizes autonomous work within an envelope; the agent produces; the human ratifies afterward. It strengthens the thesis rather than weakening it, *because* the authority is bounded, attributable, and reversible.

## The lifecycle

```
Human ── signs ──▶ Grant G42  ("what the agent may do")
                      │ authorizes
                      ▼
                 Agent operation A81
                   ├─ creates Brief
                   ├─ creates Cells / specs
                   ├─ writes code
                   └─ produces verification evidence
                      │
                      ▼
              Awaiting ratification   ── human reviews ──▶  Ratified  (or Rejected)
```

## State vocabulary

✅ 1.0. Never say "auto-approved." The states on the **authority** axis (orthogonal to the Green/Yellow/Red verification axis — see [01](01-concepts.md#the-two-axes)):

| State | Meaning |
|-------|---------|
| **Delegated** | Produced under a valid human-signed grant |
| **Awaiting ratification** | Agent finished; no human has reviewed it yet |
| **Ratified** | A human reviewed the result and signed it for real |
| **Rejected** | A human reviewed and did not accept it |
| **Superseded** | Replaced by a later ratified state |

UI copy:

```
1 Cell across 1 Brief awaits ratification
Delegated execution · Autopilot · Grant G42 — not human-reviewed.
Review the specs, implementation, and evidence, then ratify with `yay ratify --sign`.
```

## The grant is a capability envelope

✅ 1.0 (scope constraints: allow/deny paths, cells, max-risk, child-grants) / 🔭 Later (detection-gated content constraints: deps/deployment/network — recorded now, enforced as detectors land). The envelope makes authority precise and signed:

```
Grant G42
  repository:    project-x
  starting tree: abc123
  expires:       14:00
  allowed:       src/ui/**, src/utils/**
  prohibited:    authentication, authorization, secrets, CI config,
                 signing config, YayLayer policy, database migrations
  dependencies:  no additions
  max cells:     8
  max risk:      medium
  deployment:    prohibited
  child grants:  prohibited
```

The grant **signature covers those exact constraints.**

### Enforceability gates the envelope

A constraint is only meaningful if the verifier can **detect a violation in the produced output** (YayLayer enforces by *detection at verify/ratify time*, not by sandboxing the agent's process):

- **Scope constraints** (allowed/prohibited *paths*, *cells*, max-cells) — enforceable **now** (we know where a change lands).
- **Content constraints** ("no new deps," "no network," "no external effects") — enforceable **when the detector exists** (dependency-manifest diffing, network-effect detection…). These arrive as **verifier capability bumps** (see [02 — Verifier versioning](02-provenance-architecture.md#verifier-versioning)).

So a grant only ever carries constraints the running verifier version can enforce, and the attestation records which verifier/capabilities vouched for it. **Never promise a constraint you can't verify** — an unenforceable boundary is theater.

### The agent must never broaden its own grant

The authorization boundary lives **outside** the authority being delegated. If the agent edits YayLayer policy/config, that must not grant it more scope. (Grants are owner-signed events; the agent holds no owner key. Audit item: confirm *everything* that determines grant scope — including sensitivity classification — sits outside the delegated surface.)

### Child grants — bounded sub-agents 🔭 Later

`child grants` in the envelope decides whether the delegated agent may issue a **sub-grant** under its own authority — a *subset* of its envelope handed to a helper sub-agent, with **no new human signature**. Off by default (`prohibited`); it's the highest-risk lever, so it ships later and only in a strictly-attenuating form.

**What it's for.** Fan-out. An orchestrator agent holding a grant over `src/**` spawns focused helpers, each under a thinner slice — all laddering back to the *one* human root grant:

```
Human ── signs ──▶ Grant G42   (allowed: src/**, max-cells: 12, expires 14:00)
                     ├─ child G42.1 → refactor-helper   (allowed: src/ui/**,    max-cells: 4)
                     ├─ child G42.2 → test-helper        (allowed: test/**,      max-cells: 4)
                     └─ child G42.3 → docs-helper        (allowed: docs/**,      max-cells: 2)
```

Each helper's work is **Delegated → awaiting ratification** like any grant output; child grants restructure the *delegation tree*, they don't reduce human oversight of the *result* — everything still lands in your ratification queue.

**What a child grant looks like** — it references its parent and can only *narrow*:

```
Grant G42.1
  parent:        G42                 (chained → verify validates back to the human root)
  issued-by:     grant key of G42    (not an owner — descends from G42's authority)
  allowed:       src/ui/**           ⊆ parent.allowed (src/**)
  prohibited:    (inherits parent's, may only ADD)
  max cells:     4                   ≤ parent.remaining
  expires:       13:30               ≤ parent.expires
  max risk:      low                 ≤ parent.risk
  child grants:  prohibited          (depth-bounded)
```

**Why it's safe (when it is).** A capability-security pattern (attenuated delegation, à la macaroons / OAuth down-scoping):

- **Monotonic narrowing** — a child's scope/expiry/count/risk is always ⊆ the parent's. The verifier **refuses** any child that exceeds its parent, whatever the agent claims — so no new authority is ever created below the human.
- **Non-delegable stays non-delegable** — a child can't re-enable a category the parent (or policy) forbids.
- **Cryptographically chained** — each child references the parent's hash and is signed by the parent's grant key; `yay verify` validates the whole chain back to a human-signed root.
- **Depth-bounded** — the parent carries `child grants: allowed, max-depth: N`; off by default.

So even though the *agent* mints the child, it can't cheat: the human root remains the sole source of authority, and children only ever divide it into smaller pieces. Pairs naturally with [earned autonomy](#rejected-ratifications-are-valuable-history) — categories that keep getting rejected get auto-excluded from what children may cover.

## Non-delegable by default

✅ 1.0 (owner-signed non-delegable policy + verifier backstop) / 🔭 Later (cooperative pre-execution pause). "Autopilot" ≠ "freedom everywhere." High-risk categories — authentication/authorization, signing infrastructure, secret access, payment logic, destructive DB operations, production deployment, CI security policy, YayLayer's own trust config, supply-chain/dependency changes — are marked non-delegable in owner-signed policy (`{ "delegable": false }`); a delegated approval that lands there is a gate-blocking grant violation. (The stronger *pre-execution* pause-and-ask is the later cooperative layer.)

> **"Won't auto-sign it" ≠ "won't let the agent do it."** Today a sensitive Cell is merely *excluded from auto-approval* — the agent still writes the code, which then sits Unsigned in your tree. The stronger stance: on entering a non-delegable area the agent **pauses and requests a forward signature** *before* writing it. Two layers make this real: (1) the cooperative path — the Constitution instructs the agent to pause-and-ask; (2) the backstop — the verifier **detects** that a grant touched a prohibited area and flags a grant violation regardless of whether the agent behaved (the agent is untrusted).

## Ratification

✅ 1.0. Ratification is the human catching up on authorization that never happened forward. It is a real **authorization-of-intent** act, done retrospectively with the code + verifier evidence in front of you.

### Design against ratification fatigue

Because the implementation already exists, humans tend to rubber-stamp ("all tests pass, everything's Green — approve?"). So `yay ratify` must be *meaningful review*, not ceremonial signing. The ratification screen shows:

- **What the agent was authorized to do** — the grant scope + limits.
- **What the agent actually did** — Brief, Cells (spec changed / new), implementation diff, new deps, external effects, permissions changed.
- **Boundary / deviation report** — "Grant allowed max 3 Cells; agent created 3 (100% consumed)." Humans review *exceptions* far better than they re-read everything.
- **Verification** — result + verifier version + evidence.
- **Decision** — Ratify / Reject / Inspect.

### The ratification object

The human signature covers the whole object, but the facts stay distinct:

```
Ratification R12
  human:                 Alice
  time:                  12:41
  ratifies operation:    A81
  approves intent:       Brief B17, Spec set S91
  reviewed implementation: tree T93
  verification observed:   V22 / GREEN  (hash 7d18b6…)
```

This means "I approve this intent/spec" and "this is the implementation snapshot that existed when I decided" — **not** "these code bytes may never change without another signature." A later refactor T93 → T94 can remain under the same ratified spec if it re-verifies; provenance shows "changed after ratification, machine reverified."

### Ratification must not rewrite history

If code was Delegated 10:04–12:41 and Ratified at 12:41, the record must say exactly that — never "human-approved since 10:04." The temporal truth *is* the audit value.

### TOCTOU safety — not-optional for the relaunch

✅ 1.0 (P0). Ratification's whole purpose is a human vouching for the exact thing they reviewed. So `yay ratify --sign` **signs the exact bundle the human inspected**:

1. At review time, compute a **reviewed-bundle hash** over `{grant, brief, spec-set, code-tree, evidence}`.
2. At `--sign`, recompute it; if anything material changed, **refuse**:
   `Cannot ratify — implementation changed since review (reviewed T93, current T94). Run yay ratify again.`

Without this, a human can read T93 and unknowingly sign T94 (the agent kept running, a background process fired, they stepped away) — turning "a human reviewed this" into a lie and poisoning the audit trail. It's worse in the current build because `--sign` signs **all** pending Cells at once, so the signed set can exceed the reviewed set. **Batch decision:** default to refuse-the-whole-batch on any drift; "ratify only the unchanged subset" is a later convenience.

## Rejected ratifications are valuable history

✅ 1.0. Don't erase a rejection — it's some of the most valuable provenance there is: a record of where agent autonomy failed human judgment. Persisting `REJECTED` events (with category + reason, `yay ratify --reject`) is the substrate for **earned autonomy** (`yay metrics`):

> Over time: "`refactor` delegated changes — 97% ratified unchanged; `dependency` changes — 31% rejected → exclude from grants by default." The agent *earns* broad delegation where it's reliably ratified and *loses* it where humans keep rejecting. None of this exists until rejections are recorded — so it's the payoff of the provenance work, not an early feature.

## Commands

See [06 — CLI reference](06-cli-reference.md): `yay grant` · `yay grant list` · `yay grant revoke [id]` · `yay ratify` · `yay ratify --sign`.
