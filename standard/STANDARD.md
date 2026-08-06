# YayLayer Standard v0.1

*A protocol for provable, signed AI code.*

> YayLayer is a building permit for AI-written code: approved blueprints first, an inspector who checks the build matches them, and you can't move in until it passes.

This document is the source of truth every tool derives from — the extractor, the verifier, the signer, the map, and the AI [Constitution](../CONSTITUTION.md). Status: **draft**. Where the reference implementation only partially covers a section, it is marked **MVP** / **roadmap**.

---

## 1. Core model

- **YayLayer** — the protocol/system as a whole.
- **Cell** — one sealed unit of meaning, at any order. Flat id, prefix `C-` (e.g. `C-040`). A "module" is *not* a separate type — it is simply a Cell that declares `contains`. (Convention: give container Cells a high range, e.g. `C-900+`.)
- **Policy** — a cross-cutting rule that ranges over many Cells (prefix `P-`).
- **Coverage is total; granularity is meaning-level.** Every line of code lives inside some Cell; a Cell is the smallest chunk with a purpose you can state in one `intent:` sentence. Private helpers are governed by their Cell's spec, not separately specced.

## 2. The marker grammar

A Cell's spec lives in comments between two unique markers, so a parser can find it and a human can read it:

```
//∷YAY⟨C-040⟩ v1
//  <field>: <value>
//  ...
//∷YAY-END⟨C-040⟩
<the code the spec governs>
```

- `∷YAY⟨id⟩` opens; `∷YAY-END⟨id⟩` closes. `YAY` means "this is YayLayer"; the id names the Cell.
- The comment lead may be `//` or `#` (language-dependent). Ids match `[A-Za-z0-9._-]+`.
- A continuation line (a comment line with no `key:`) appends to the previous field.

## 3. Spec fields

Two tracks. **Machine fields** are checkable and can earn Green. `intent:` is human prose, judged by an AI reviewer that is **downgrade-only** — it can lower a color but never lift a Cell to Green.

| Field | Track | Meaning |
|-------|-------|---------|
| `unit` | machine | the function/component/route this Cell governs |
| `lang` | machine | language (picks the adapter) |
| `intent` | human | one plain sentence; vague ⇒ capped at Yellow |
| `in` / `out` | machine | typed shape of inputs / result |
| `pure` | machine | `yes` ⇒ no side effects (verified) |
| `ensures` | machine | behavioural promise (property-tested — roadmap) |
| `throws` | machine | declared error paths |
| `effects` | machine | declared side effects (undeclared ⇒ Red/Yellow) |
| `contains` | machine | child Cell ids (makes this a module) |
| `feeds` | machine | consumer Cell ids (builds the flow graph) |

## 4. The seal

`specHash = sha256(normalized spec block)`. **You sign the spec, not the code** — so refactors pass freely; only a changed *promise* re-prompts you. (Optional **code-pin**, off by default, makes a Cell's seal also cover a code hash so any edit re-prompts you — reserved for crown-jewel Cells; human-enabled only.)

Signatures are **ed25519**. A seal is a signature over the canonical bytes of an *approval*:

```json
{ "id":"A-0007", "project":"…", "prev":"A-0006", "nonce":"…",
  "at":"…", "signer":"alice", "items": { "C-040":"<specHash>", … } }
```

One signature covers a whole change-set (`items` may hold one Cell or a hundred). The lock (`.yaylayer/lock.json`) is an append-only chain (`prev`), and both it and the roster (`config.json`, holding **public** keys) are committed. Private keys never are.

## 5. Colors — two axes

State combines **VERIFY** (does code match spec?) and **TRUST** (who approved the spec?):

- **GREEN** — signed *and* code proven to match the spec.
- **YELLOW** — signed and matching, but flagged (prose-only spec, undeclared effect, unproven claim, broken edge).
- **RED** — signed but code ≠ spec (missing unit, purity violated, mismatch), or a tampered signature.
- **UNSIGNED** — no valid seal covers the current spec.
- **PINK** — code with **no formal specification at all** (untracked, never described or signed). Total coverage is mandatory, so PINK is the most dangerous state and **blocks the gate** like Red/Unsigned. Untagged code is never silently ignored. *(Detected via a real parser (`@babel/parser`) for **JS, TypeScript, JSX, TSX** — every named unit at any depth: functions, object/class methods, arrow-props — plus top-level imperative code. Unparseable files degrade to file-level grouping.)*
- **AUTO** (trust overlay) — approved under a freedom-mode grant, not personally reviewed; green-on-verify is possible but marked, and sits in the ratification queue.

A container Cell's color **rolls up** to the worst of its descendants.

## 6. Verification tiers

1. **Static** — spec well-formed; `unit` exists; declared `pure`/`effects` hold. *(A real AST parser (`@babel/parser`, covering JS/TS/JSX/TSX) discovers units and extracts exact bodies; effect analysis is still signal-based. Deeper analysis is roadmap.)*
2. **Dynamic** — property tests generated from `ensures`, run with fresh seeds; graded by **mutation testing** (low score caps at Yellow). *(Roadmap.)*
3. **Semantic** — AI judge of `intent`, downgrade-only.

**Test independence** comes from *isolation*, not a second model: tests are generated from the spec (deterministically or by a code-blind agent), never from the implementation.

## 7. Higher-order — flow & Policies

- **Flow:** at every `feeds` edge, `producer.out ⊨ consumer.in`. A Red Cell taints everything downstream. *(MVP checks edges resolve; contract-compat is roadmap.)*
- **Policies** *(roadmap)* — first-class signed rules: `intent` + selector (which Cells) + a checkable rule, verified as a **"for all matched Cells"** check. Flavors: **mandate / prohibit / grant** (grant carries an inherited effect declaration so minimality stays clean). The concern's mechanism stays a normal Cell the Policy points at.

## 8. Integrity & approval

- The private key lives only on the owner's phone (Face ID); pair once via QR, then an **encrypted push channel**. The rendezvous server is **untrusted** — relays hashes + timestamps, never sees code.
- **Nonce** per request kills replay; `prev` chains history (tamper-evident); verify **recomputes hashes from the real files**.
- **Enforcement:** a local git hook is fast feedback only. The real gate is **CI + branch protection** running `yay verify --strict` — Red/Unsigned fails the check and the merge is blocked. Build/deploy verify is the solo fallback. *(MVP: `yay verify --strict` exit code; local keystore stands in for the phone signer.)*
- **Key recovery:** back up as a 24-word mnemonic + passphrase, plus a second enrolled key. Lost phone → restore the same key → no re-seal. "Re-seal" (new trust root) is a rare one-signature fallback.

## 9. Freedom mode (auto-approve)

A **delegation grant** — signed once on the phone (Face ID), scoped and time/count-boxed. Within it the AI auto-approves in-scope Cells with **no further phone contact** (the grant is the authorization; verify checks it). Sensitive/code-pinned Cells are excluded. Everything auto-approved is stamped `AUTO` and queued for **ratification**. Stop early with a signed **revocation**, honored at the CI gate. *(Roadmap.)*

## 10. Teams

Each person holds their own key; a signed **roster** maps keys → names, so every seal attributes to a *named* human. Optional **role-based rights** and **M-of-N multi-sig** for sensitive Cells. Adding a signer is a privileged, signed (owner) action. Merges union per-Cell seals; the CI gate re-proves the merged whole and catches logical merge conflicts git can't. *(Roadmap; the reference impl records `signer` per approval today.)*

## 11. Language reach

Adapter order: **JS/TS first** (covers JS, TS, React, Node, Next) → **HTML/CSS** (structural Green) → **Python** → **Rust, then Solidity (deferred)**. A language without its full adapter runs "structural-lite" and caps at Yellow.

## 12. Adopt (retrofit)

`yay adopt` derives *descriptive* draft specs from existing code → the human **prunes** them prescriptive → signs → code that overreaches the pruned spec goes Red → the AI refactors to match. Coverage is reported honestly (uncovered = Pink, never faked). *(AST-based for JS: scaffolds a draft block over every named unit at any depth, with a purity guess. Deriving `intent` prose from behaviour needs an LLM — roadmap.)*

---

*Reference implementation: this repo. See [README](../README.md) for what's built vs planned.*
