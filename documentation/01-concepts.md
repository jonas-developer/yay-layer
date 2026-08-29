# 01 — Concepts

## Cell

A **Cell** is the atomic unit YayLayer governs: a block of code plus a **spec** describing what it must do. Cells are delimited inline in the source with markers:

```
//∷YAY⟨C-050⟩
// unit: memoKey
// intent: Build a stable cache key by joining arguments with a separator.
// in: parts: Array<string|number>
// out: key: string
// pure: yes
//∷YAY-END⟨C-050⟩
function memoKey(){ return Array.prototype.slice.call(arguments).join('|'); }
```

- The lines between the markers are the **spec block**.
- The code immediately below is the Cell's **unit body**.
- Every Cell has a stable **id** (`C-050`) and a **specHash** = `sha256(normalized spec block)`.

Because the spec lives *inline in the source*, it is committed together with the code — the spec and the code it constrains never drift apart in version control.

## Spec

The spec is a small structured grammar of **behavioral promises**, comment-style so it's language-agnostic. Common fields: `unit`, `intent`, `in`, `out`, `pure`, `ensures`, `throws`, `renders`, `feeds`, `contains`. The spec is what the human authorizes and what the verifier checks the code against. ✅ Shipped.

## Brief

A **Brief** is the human-readable headline over a change-set: a short **title** plus one to three sentences stating, in the AI's own fine-tuned words, *what was ordered* — plus the list of Cells it covers. The Brief is signed **together with** the specs, so it becomes the attributed, tamper-evident record of what was commissioned. A Brief is prose — it attributes intent; **it never earns Green** (only Cells do). ✅ Shipped.

## The two chains

YayLayer keeps two authorities strictly separate (this is the spine of the whole design):

```
HUMAN AUTHORIZATION CHAIN          IMPLEMENTATION VERIFICATION CHAIN
Brief + exact Cell specs           authorized spec-set + exact code snapshot
        → human signature                  → verifier evidence + status
```

- The **human** attests: *"I authorize this intent/specification."*
- The **verifier** attests: *"I evaluated implementation X against approved spec Y → result Z."*

Because the human never signs code bytes, refactoring `const r = x + y` → `return x + y` needs **no new human signature** — the same signed intent still holds if the new code verifies against it. That's what keeps YayLayer *approving intent*, not *approving implementations*.

## The human's three acts

All three are the **human** side of the triad (phone key); they differ only in *what object* is signed and *whether code exists yet*:

| Act | What's signed | Code exists at signing? |
|-----|---------------|-------------------------|
| **Forward spec-sign** *(default)* | Brief + spec-set | No — you authorize intent before implementation |
| **Grant** (Autopilot) | a scope/capability envelope | n/a — authorizes future autonomous production |
| **Ratification** | operation + Brief + spec-set + observed code-tree + observed verification | Yes — you review the delegated result, then sign |

Forward spec-signing is the trunk. Grant and ratification are the two branches the agentic path adds. See [03 — Autopilot](03-autopilot-delegated-execution.md).

> Note: code *existing* at signing time is common even outside Autopilot — in **batch mode** (the AI writes spec+code so you can try it, then you sign) and in **adoption** (specs retrofitted over existing code). But in every case your signature covers the **intent/spec**, not the code; the verifier owns the code claim.

## Signers & owners

The "Human" in the triad is really a **roster** of trusted identities, each with a role:

- A **signer** can approve intent — sign specs + Briefs, ratify delegated work.
- An **owner** can do all that **plus govern the project**: enroll/revoke other signers, issue [Autopilot](03-autopilot-delegated-execution.md) grants, sign [policy](05-how-to.md#set-signing-policy) into effect, and recover the trust root.

The first identity is the **genesis owner**. Who-may-sign lives in an **append-only, owner-signed roster** (trust root pinned in CI), so only a human owner can change who is trusted — never the AI. Full treatment — enroll vs invite, revoke, re-root, signer routing across a team, signing methods, and recovery — is in [08 — Teams, roles & recovery](08-teams-roles-and-recovery.md).

## The three cryptographic identities

Not "everything gets signed" — three distinct things, each proving a different fact:

1. **Artifact hashes** — *what exact thing are we talking about?* (specHash, code-tree hash, evidence hash).
2. **Verifier attestation** — *what did the trusted machine verifier conclude?* Signed by the **verifier's own key**. 
3. **Human signature** — *what did the human authorize/ratify?* Signed by the **phone key**. ✅ Shipped.

A human ratification references the **verifier attestation hash**, so the human is tied not merely to the word "Green" but to the exact verification result that existed when they signed.

## The two axes

Authority and verification are **orthogonal** and should never be collapsed into one traffic light: 

```
AUTHORITY (human)          VERIFICATION (machine)
Unapproved                 Red
Delegated                  Yellow
Ratified                   Green
```

So a Cell can legitimately be:
- **Delegated + Green** — the verifier believes the code satisfies the spec, but no human has ratified it yet.
- **Ratified + Red** — a human approved the intent, but the current code no longer verifies against it.

The UI shows one calm state in the common case (Ratified + Green = "done") and surfaces both axes only when they **diverge** (progressive disclosure).

## "Green is an event," not a property

Code is not *inherently* Green. It is Green **relative to** a spec + a verifier + verifier semantics + evidence + a point in time. Internally:

```
GREEN(artifact = <code hash>, spec = <spec hash>, verifier_semantics = <verifier+ruleset+config>)
```

Change any input and you may legitimately get a different answer. A better verifier in 2029 does not make a 2026 "Green" fraudulent — it makes the historical claim more precise ("Green under verifier 1.8.4") and can add a new assessment ("Yellow under verifier 4.2.0") **without rewriting the old one**. See [02 — Provenance architecture](02-provenance-architecture.md#verifier-versioning) and [04 — Languages](04-languages.md).

## States (the colors)

✅ Shipped.

| State | Meaning |
|-------|---------|
| **Green** | Code satisfies the signed spec (machine-proven where the language supports it; signed-but-unproven otherwise). |
| **Yellow** | Signed, but not fully proven — mutation-weak, inert, needs re-sign, or an honest cap for languages without a behavioral prover. |
| **Red** | Code contradicts the spec, or a spec-derived test fails. |
| **Unsigned** | No valid human signature covers the current spec. |
| **Pink** | Code with **no** Cell governing it — un-specced units, or loose top-level imperative code. Blocks the gate. |

See [07 — Security model](07-security-model.md) for how Pink and Red make injection and silent-drift visible, and [03](03-autopilot-delegated-execution.md) for how the **authority** axis (Delegated/Ratified) layers on top of these.
