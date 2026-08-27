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
  "at":"…", "signer":"alice",
  "brief": { "text":"Add pause/resume to the game loop and persist the high score between sessions.",
               "orderedBy":"human (AI-drafted, human-approved)" },
  "items": { "C-040":"<specHash>", … } }
```

One signature covers a whole change-set (`items` may hold one Cell or a hundred). When the change-set carries a **brief** (§5), its text is part of these signed bytes — so the human's intent is attributed and tamper-evident, cryptographically bound to the exact Cells and hashes approved. The lock (`.yaylayer/lock.json`) is an append-only chain (`prev`), and both it and the roster (`config.json`, holding **public** keys) are committed. Private keys never are.

## 5. Briefs

Cell `intent:` is bottom-up and local; it doesn't record **what the human actually ordered**. A **Brief** is that top-down layer: a short prose statement of the human's intent for a change-set, drafted by the AI, edited and approved by the human, and signed as part of the approval (§4).

- **Shape.** A brief has `text` (the human's intent, one short paragraph) and covers the exact Cell set + spec-hashes of its approval. It is date-stamped (`at`) and attributed (`signer`) by the seal it rides in. Briefs form an append-only log across approvals — the project's plain-English history of what was commissioned, when, by whom.
- **AI drafts, human owns.** The AI writes the brief as its best understanding of the request — *fine-tuned, not the human's verbatim words* — and the human refines it **in the loop with the AI before it is presented**, not on the phone. This is deliberate: the Brief drives its Cells, so a wording change may warrant a spec change, and only the AI can move the Cells with it. At signing the human's moves are **Accept** or **Send back** (with an optional note); a send-back returns the whole change-set to the AI to reconcile Brief + specs together. An unedited-but-accepted brief is still the human's, because they signed it.
- **Intent lane, never verification.** A brief is prose: like `intent:`, it is human/AI-judged and **can never earn or lift a color to Green**. It describes and attributes; it does not prove anything. Machine fields still do all verification. This keeps briefs clear of "false green."
- **Scope-bound, so it can't drift.** Because the brief is signed together with its `items` (Cell ids + spec-hashes), the ledger can always show "Brief M covered C-011, C-030 at these hashes." Editing a covered Cell later puts it visibly outside the brief's approved scope (Unsigned), rather than silently riding an old brief.
- **Tagged from a project pool.** A project may define a small tag vocabulary (`yay tags` — six starter sets, or your own). When present, every Brief is tagged with **1–3** tags from the pool, carried in `brief.tags` and signed with it (attributed + tamper-evident). Tags are a *view* for sorting the history by concern over time — never a gate, never a color. Keep a Brief single-concern; the AI advises splitting a request that mixes unrelated tags into separate Briefs.
- **Default, not optional.** A brief is **required by default** on every approval — the AI must draft one, and `yay sign` prompts a human for it if omitted. The only escape is an explicit `--no-brief` for a trivial re-sign (e.g. re-approving after a pure refactor). Briefs feed the System Plan and the decision log; they are a *view* and an *attribution record*, not a gate.

*(MVP: `yay sign --brief "…"` attaches the brief to the approval; the phone approve screen shows it read-only with **Accept & sign** / **Send back**; the seal in `lock.json` is tamper-evident via the signature. A send-back returns `{rejected, reason}` to the AI's `yay sign` output so it can reconcile and re-present. A dedicated Briefs view in the map is roadmap.)*

## 6. Colors — two axes

State combines **VERIFY** (does code match spec?) and **TRUST** (who approved the spec?):

- **GREEN** — signed *and* code proven to match the spec.
- **YELLOW** — signed and matching, but flagged (prose-only spec, undeclared effect, unproven claim, broken edge).
- **RED** — signed but code ≠ spec (missing unit, purity violated, mismatch), or a tampered signature.
- **UNSIGNED** — no valid seal covers the current spec.
- **PINK** — code with **no formal specification at all** (untracked, never described or signed). Total coverage is mandatory, so PINK is the most dangerous state and **blocks the gate** like Red/Unsigned. Untagged code is never silently ignored. *(Detected via a real parser (`@babel/parser`) for **JS, TypeScript, JSX, TSX** — every named unit at any depth: functions, object/class methods, arrow-props — plus top-level imperative code. Unparseable files degrade to file-level grouping.)*
- **AUTO** (trust overlay) — approved under a freedom-mode grant, not personally reviewed; green-on-verify is possible but marked, and sits in the ratification queue.

A container Cell's color **rolls up** to the worst of its descendants.

## 7. Verification tiers

1. **Static** — spec well-formed; `unit` exists; declared `pure`/`effects` hold. *(A real AST parser (`@babel/parser`, covering JS/TS/JSX/TSX) discovers units and extracts exact bodies; effect analysis is still signal-based. Deeper analysis is roadmap.)*
2. **Dynamic** — property tests generated from `ensures`, run with fresh seeds; graded by **mutation testing** (low score caps at Yellow). *(Roadmap.)*
3. **Semantic** — AI judge of `intent`, downgrade-only.

**Test independence** comes from *isolation*, not a second model: tests are generated from the spec (deterministically or by a code-blind agent), never from the implementation.

## 8. Higher-order — flow & Policies

- **Flow:** at every `feeds` edge, `producer.out ⊨ consumer.in`. A Red Cell taints everything downstream. *(MVP checks edges resolve; contract-compat is roadmap.)*
- **Policies** *(roadmap)* — first-class signed rules: `intent` + selector (which Cells) + a checkable rule, verified as a **"for all matched Cells"** check. Flavors: **mandate / prohibit / grant** (grant carries an inherited effect declaration so minimality stays clean). The concern's mechanism stays a normal Cell the Policy points at.

## 9. Integrity & approval

- The private key lives only on the owner's phone (Face ID); pair once via QR, then an **encrypted push channel**. The rendezvous server is **untrusted** — relays hashes + timestamps, never sees code.
- **Nonce** per request kills replay; `prev` chains history (tamper-evident); verify **recomputes hashes from the real files**.
- **Enforcement:** a local git hook is fast feedback only. The real gate is **CI + branch protection** running `yay verify --strict` — Red/Unsigned fails the check and the merge is blocked. Build/deploy verify is the solo fallback. *(MVP: `yay verify --strict` exit code; local keystore stands in for the phone signer.)*
- **Key recovery:** back up as a 24-word mnemonic + passphrase, plus a second enrolled key. Lost phone → restore the same key → no re-seal. "Re-seal" (new trust root) is a rare one-signature fallback.

## 10. Freedom mode (auto-approve)

A **delegation grant** — signed once on the phone (Face ID), scoped and time/count-boxed. Within it the AI auto-approves in-scope Cells with **no further phone contact** (the grant is the authorization; verify checks it). Sensitive/code-pinned Cells are excluded. Everything auto-approved is stamped `AUTO` and queued for **ratification**. Stop early with a signed **revocation**, honored at the CI gate. *(Roadmap.)*

## 11. Teams

Each person holds their own key; a signed **roster** maps keys → names, so every seal attributes to a *named* human. Optional **role-based rights** and **M-of-N multi-sig** for sensitive Cells. Adding a signer is a privileged, signed (owner) action. Merges union per-Cell seals; the CI gate re-proves the merged whole and catches logical merge conflicts git can't. *(Roadmap; the reference impl records `signer` per approval today.)*

**Signing policy.** A project may declare, in an owner-signed policy (derived from the roster, so it is tamper-evident), that Cells matched by path glob, spec tag / `sensitive`, or module **must** be signed by a named person. The gate holds any matching Cell Red until that specific signer seals it. Neutral by default — with no policy every signer is equal.

**Routing (signer inbox).** Each signer has a deterministic **inbox channel** — a public hash of their public key. A request can be *addressed* to one person by sealing it (an anonymous X25519 sealed box, from their existing ed25519 key — no extra key) to that inbox; only they can open it, and it appears only on their on-duty phone (`yay inbox`), never anyone else's. Addressing is **fire-and-return**: `yay sign --name "<Name>"` seals the request, returns a request id, and leaves the Cells Unsigned (gate-blocked) until that person approves asynchronously; `yay sign --check` collects the sealed reply (the reply rides back under a per-request symmetric key the requester keeps). The relay only ever stores opaque ciphertext.

## 12. Language reach

Adapter order: **JS/TS first** (covers JS, TS, React, Node, Next) → **HTML/CSS** (structural Green) → **Python** → **Rust, then Solidity (deferred)**. A language without its full adapter runs "structural-lite" and caps at Yellow.

## 13. Adopt (retrofit)

`yay adopt` derives *descriptive* draft specs from existing code → the human **prunes** them prescriptive → signs → code that overreaches the pruned spec goes Red → the AI refactors to match. Coverage is reported honestly (uncovered = Pink, never faked). *(AST-based for JS: scaffolds a draft block over every named unit at any depth, with a purity guess. Deriving `intent` prose from behaviour needs an LLM — roadmap.)*

---

*Reference implementation: this repo. See [README](../README.md) for what's built vs planned.*
