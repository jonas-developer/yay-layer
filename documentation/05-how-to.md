# 05 — How-to guides

Task-oriented recipes. Commands are detailed in [06 — CLI reference](06-cli-reference.md). Install **git first, then yay-layer** — git is where the proof lives (the CI gate reads committed state; history features reconstruct from git in Standard mode).

## Set up a project

```bash
yay init
```
Guided setup: create files → choose a **signing key** (local / mobile-LAN / mobile-relay) → optional **adopt** existing code → pick a **Brief-tag** starter set → write the **Constitution** into your AI harness → optional System Plan. 🔜 v1 also asks **Standard vs Durable** provenance.

## Bring an existing codebase under YayLayer (adopt)

```bash
yay adopt
```
Scaffolds spec blocks over your existing units so they become Cells. The code already exists, so you'll be signing specs that describe present code (see [01 — the human's three acts](01-concepts.md#the-humans-three-acts)).

## The normal change loop (forward-signing)

The default discipline your AI follows (Constitution, Article 4):
1. Write/update the **spec** first — no implementation yet.
2. Draft the **Brief** and present the change-set; run `yay sign --title "…" --brief "…"`.
3. On a returned signature, implement code to match, run `yay verify`, report.
4. On Green, **commit code + `.yaylayer/` together in one commit**. Don't `git push` unless asked.

## Sign at your own pace (batch)

Batch mode is **on by default**: small changes get their spec + code immediately (so you can try them, Unsigned) and accumulate into a per-concern batch. At the barrier (default 5) — or before a commit/push — you're shown the batch and asked *close & sign / add one more / keep going*.

```bash
yay batch 8      # raise the barrier
yay batch off    # a Brief per change
```

## Let the AI work autonomously (Autopilot)

```bash
yay grant --for 2h --count 20            # bounded delegated authority
yay grant --for 2h --cell C-012,C-013    # scope to specific Cells
yay grant list                           # active grants
yay grant revoke [id]                     # stop delegating
```
You sign the grant once on your phone; the AI then produces within the envelope, marked **Delegated · Awaiting ratification**. 🔜 v1 expands the grant into a capability envelope (paths, deps, risk…); see [03](03-autopilot-delegated-execution.md).

## Ratify delegated work

```bash
yay ratify           # list delegated Cells awaiting review (read-only)
yay ratify --sign    # review, then human-sign them for real
```
Review the spec **and** the code it built (both are present) plus the boundary report, then Ratify or Send back. `--sign` signs the **exact bundle you reviewed** and refuses if it changed since (🔜 v1 TOCTOU fix). In the dashboard, the Briefs tab surfaces a **⚡ Ratify now** action.

**If you don't like it:** don't ratify — **Send back** with a note. The AI revises and presents a normal forward Brief you sign; that supersedes the delegated version (which becomes superseded history, never human-blessed). `yay grant revoke` halts further delegation meanwhile.

## Verify

```bash
yay verify              # colour every Cell against the working tree
yay verify --strict     # CI mode — exits non-zero on Red/Unsigned/Pink
yay verify --dir examples
```

## Run the dashboard

```bash
yay dashboard           # live map + phone relay; Briefs / Tags / Policy tabs
yay dashboard --open
```
HTTPS by default. Leave it running; it routes pair/sign/authorize to the phone you scanned once. The **Briefs** tab is a history lens — open a Cell *through* a Brief to see it **as that Brief signed it** (As signed / Current / What changed).

## Protect `main` (CI gate)

```bash
yay gate     # writes the CI workflow
```
Require a check running `yay verify --strict`. Anything Red / Unsigned / Pink fails and can't merge — enforcement lives in infrastructure the AI doesn't control.

## Manage Brief tags

```bash
yay tags                       # show the pool
yay tags --set responsibility  # switch starter set (before the first tagged Brief)
yay tags add "Billing"
yay tags rename "A" "B"        # blocked once used in a signed Brief
yay tags desc "Auth" "…"
yay tags sets                  # list the built-in sets and their tags
```

## Set signing policy

```bash
yay policy            # view enforced + draft rules
yay policy --set      # owner-sign the draft into effect
```
Rules bind path/tag/module → a required signer, an inert-code level, or an ignore authorization. Built-in security: **inert-code strictness** (off by default; turn on per path/tag). Owner-signed either way, so it can't be quietly weakened.

## Add a teammate

```bash
yay invite "Bob"                       # 30-min one-time link; approve on your phone
yay enroll --name Bob --pubkey <b64>   # or enroll directly via an owner-signed roster event
```

## Recover access

- Lost the phone but have your **24 words** → restore the key from the recovery phrase on a new phone.
- Lost the phone **and** the words → you're locked out of *signing as that identity*; an **owner** enrolls a new key for you (roster event). Committed proof is unaffected.

## Choose Standard vs Durable provenance

🔭 Later. At `yay init` / `yay adopt` (changeable later):
- **Standard** (default) — specs + attestations archived; code by git reference. Full audit while the repo survives.
- **Durable** — code also archived (encrypted) in the project store; survives git loss. For regulated/compliance environments. Ships with encryption + retention + tombstones. See [02 — Governance](02-provenance-architecture.md#governance--designed-in-not-bolted-on).
