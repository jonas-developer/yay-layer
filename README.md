<div align="center">

<img src="https://yaylayer.com/logo.svg" width="76" height="76" alt="YayLayer" />

# YayLayer

**A protocol for provable, signed AI code.**

<sub>Approved blueprints first · an inspector that checks the build matches · it can't ship until it passes.</sub>

[![AI code: provable & signed](https://img.shields.io/badge/AI%20code-provable%20%26%20signed-177f52.svg)](#)
[![license: MIT](https://img.shields.io/badge/license-MIT-177f52.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A518-177f52.svg)](package.json)
[![gate: no false green](https://img.shields.io/badge/gate-no%20false%20green-1f9d57.svg)](#colors)

</div>

---

> YayLayer is a **building permit for AI-written code**: approved blueprints first, an inspector who checks the build matches them, and you can't move in until it passes.

You describe what you want; the AI writes a tiny, human-readable **spec** above each unit of code; you **sign it** from your phone; and a checker **proves** the code matches — painting the whole project **green / yellow / red**. Green means proven. It's how you *own* code you didn't hand-write — and prove a human stood behind it.

- **Review intent, not diffs** — approve a one-sentence contract per unit.
- **Kills AI bloat** — code that does *more* than its spec turns Red, forcing the AI to simplify.
- **Attributable authorship** — every approval is cryptographically signed by a *named* human.
- **CI-enforced** — unsigned or mismatched code can't reach `main`.
- **Provenance you can hand off** — the machine verifier signs its *own* verdict (`yay attest`) onto a tamper-evident chain, and optional **Durable mode** keeps an encrypted, hash-anchored archive of the signed source. Audit-grade, and checkable by anyone at [yaylayer.com/verify](https://yaylayer.com/verify).

> **In one line:** a **human authorization protocol for agents**. As AI produces changes faster than anyone can review them, YayLayer moves the review point *one level up* — you attest to the **intended behaviour**, not the implementation, and a machine continuously verifies the code against that intent. The agent can propose and implement anything; only a human can grant authority, and that authority is **machine-verifiable**. Every approval leaves a cryptographically attributable record — *"Anna approved this exact behavioural requirement as part of Brief X"* — so six months later "why did the AI change this?" has an answer.

**Learn more:** [yaylayer.com](https://yaylayer.com) · [Manual](https://yaylayer.com/docs/manual.html) · [Live demo dashboard](https://yaylayer.com/demo/dashboard.html) · [Verify an attestation](https://yaylayer.com/verify) · the spec in [`standard/STANDARD.md`](standard/STANDARD.md) · the AI rules in [`CONSTITUTION.md`](CONSTITUTION.md).

---

## The core idea: teach your AI to build spec-first

YayLayer only works if the AI you build with follows the ritual — **write the spec, get it signed, then write code to match.** You teach it that *once* by handing it the **Constitution**, a short rule-prompt in **[`CONSTITUTION.md`](CONSTITUTION.md)**.

**Set it up** — paste `CONSTITUTION.md` into wherever your AI reads standing instructions:

| Tool | Where it goes |
|---|---|
| Claude Code / Claude | `CLAUDE.md` at your repo root |
| ChatGPT | a Project's instructions, or a Custom GPT's system prompt |
| Cursor | save it as `.cursorrules` |
| OpenClaw | `AGENTS.md` in the agent workspace |
| Hermes | `AGENTS.md` at the repo root (loaded at session start) |
| Most other agents | `AGENTS.md` — an emerging cross-tool convention many agents read |

**Then the loop repeats for every feature:**

1. **You** ask in plain English — *"add a checkout form with validation."*
2. **The AI** writes YayLayer **spec blocks first — not code** — and presents them for review.
3. **You** read the intent and run `yay sign` to approve (your signature).
4. **The AI** writes code to satisfy the signed spec.
5. **`yay verify`** → green ships; red the AI must fix. It can't add behaviour that isn't in an approved spec without coming back to ask you.

The Constitution's rules, in one breath: *spec before code; use the marker grammar; fill the machine fields + one `intent` sentence; add nothing unrequested (minimality); stop and wait for the signature; never alter a sealed spec without re-approval; report colors honestly, never fake green.* The full text is in [`CONSTITUTION.md`](CONSTITUTION.md), and it's model-agnostic — the same prompt works for **any** AI agent (Claude, ChatGPT, Cursor, OpenClaw, Hermes, …). If your agent reads standing instructions from somewhere, that's where the Constitution goes.

> Without the Constitution, the AI just writes code as usual and everything shows **Unsigned / Red**. With it, the AI produces the specs, you sign, and the gate keeps you both honest.

---

## Try it in under a minute

You need **Node ≥ 18**, and you'll want **git installed first** — YayLayer works without it, but git is where the proof lives: the CI gate reads committed state, and the dashboard's history features (spec diffs on the phone, and the Briefs tab's *"as this Brief signed it"* view) reconstruct past versions straight from your git history. **Install git, then yay-layer.** Clone, install its two small dependencies ([`@babel/parser`](https://babeljs.io/docs/babel-parser) for JS/TS/JSX/TSX parsing, and `qrcode-terminal` for phone pairing), and run:

```bash
git clone https://github.com/jonas-developer/yay-layer.git
cd yay-layer
npm install
node bin/yay.js verify --dir examples
```

You'll see the gate paint the example:

```
● GREEN    C-040   examples/coinwatch/calcPortfolioValue.js:1   · jonas
● RED      C-041   examples/coinwatch/calcGainLoss.js:1         · jonas
    – purity violated: declared pure but uses localStorage
```

`C-040` is clean; `C-041` is **deliberately broken** — it declares `pure: yes` but writes `localStorage`, so verify catches the undeclared side effect (the anti-bloat check). No signing or setup is needed to try this: the example is **already signed** — its seal ships in `.yaylayer/lock.json` and the signer's public key in `.yaylayer/config.json`, and `verify` only needs the *public* key. See the visual version:

```bash
node bin/yay.js map --dir examples   # writes yay-layer-map.html — open it in a browser
```

Prefer the terminal? Add `-d` to drill into each Cell's spec, code, and checks inline:

```bash
node bin/yay.js verify --dir examples -d
```

## Optional: put `yay` on your PATH

So you can type `yay …` instead of `node bin/yay.js …`:

```bash
npm link                    # from the repo root
yay verify --dir examples   # now this works
```

Everything below uses `yay`; if you skipped `npm link`, just prefix commands with `node bin/yay.js` (e.g. `node bin/yay.js verify`).

## Use it in your own project

Run these **from inside your project** (`cd` there first) — `init` sets up whatever folder you're in. Or point it at a path from anywhere: `yay init path/to/project`.

**`yay init` is a guided setup.** After creating the files it walks you through, step by step:
1. **Signing mode** — **Local** (encrypted key on this machine), **Mobile · LAN** (key stays on your phone, phone ↔ laptop over your Wi-Fi), or **Mobile · relay** (phone via the end-to-end-encrypted `relay.yaylayer.com`, works from any network). All three are built.
2. If Local, it asks for your **name** and a **passphrase**, and creates the key; Mobile modes print a QR to pair your phone once (key created there, 24-word backup, PIN).
3. **Adopt** — asks whether the project already has code; if yes, it runs `adopt` to scaffold draft specs over it.
4. **Brief tags**, the **Constitution** (written into your AI harness), and **Standard vs Durable** provenance (`--durable` to archive signed source encrypted).

Prefer to script it (or skip the prompts)? Pass flags: `yay init --key local --name you --adopt` (or `--no-adopt`, `--relay`/`--lan`, `--durable`). The manual equivalents of each step:

> **About `--project`:** it's just a **free-form display name** — call it anything you like (e.g. `--project "My Fancy App"`). It defaults to the folder name, and only shows up as a label in `yay status` and the map header. It does **not** affect behaviour and it is **not** a path (avoid slashes, or `yay` will think you meant a directory).

```bash
yay init                      # set up .yaylayer/ here; name defaults to the folder name
yay init --project "My App"   # …or give it any display name you want
yay keygen --name you         # create your signing key — prompts you to SET a passphrase (hidden)
yay adopt src                 # optional: scaffold draft specs over existing code
#   … you + your AI write/prune spec blocks above each unit …
yay sign --all                # approve the current specs (asks for your passphrase)
yay verify                    # the gate: paint every Cell
yay map                       # write the flowchart → yay-layer-map.html (override with -o file.html)
```

**About the passphrase:** `yay keygen` prompts you to **set a passphrase** (typing is hidden — type it, then press Enter). It encrypts your local private key, and you re-enter it each time you `yay sign`. If the terminal seems to "hang" on `passphrase:`, it's just waiting for you to type it. To skip the prompt (scripts/CI, or if you prefer), pass it directly:

```bash
YAY_PASSPHRASE="your-passphrase" yay keygen --name you
#   or:  yay keygen --name you --passphrase "your-passphrase"
```

Each `yay keygen` adds you to the **roster** in `.yaylayer/config.json`. A name can be a simple handle **or** a full name — just quote names with spaces (`--name "Alice Carlsen"`). Two examples of how they land in the JSON:

```json
{
  "project": "My App",
  "signers": {
    "alice": "MCowBQYDK2VwAyEAyQptzSJTyB2Nh+MKQA6SVhiZ74M5Kk5qM83O2MGU9Q=",
    "Alice Carlsen": "MCowBQYDK2VwAyEA0f3b9c1d2e4a6b8c0d2e4f6a8b0c2d4e6f8a0b2c4d6e8f0a1="
  },
  "owners": ["alice", "Alice Carlsen"]
}
```

The name you pick is what shows up as the signer on every seal (`signed by alice` / `signed by Alice Carlsen`) — so it's who gets the credit/blame for each approval. `signers` holds public keys only; private keys stay in `.yaylayer/keys/` (gitignored).

> **`yay init` is once per project — tool upgrades just work.** The `.yaylayer/` data (roster + seals) is forward-compatible, so when `yay` itself is updated your projects pick up the new behaviour **automatically — you never re-init**, and existing signatures stay valid. For example, the AST-coverage upgrade instantly makes previously-invisible code show up **Pink** on an already-initialized project; just run `yay verify` again. You only `init` a brand-new project.

## A Cell looks like this

```js
//∷YAY⟨C-040⟩ v1
//  unit:    calcPortfolioValue
//  lang:    js
//  intent:  Sum each holding's quantity times its price into one USD total.
//  in:      holdings: Array<{qty:number, priceUsd:number}>
//  out:     totalUsd: number
//  pure:    yes
//  feeds:   C-041
//∷YAY-END⟨C-040⟩
function calcPortfolioValue(holdings) {
  return holdings.reduce((t, h) => t + h.qty * h.priceUsd, 0);
}
```

**Machine fields** (fill precisely, plus one plain `intent:` sentence): `unit · lang · in · out · pure · ensures · throws · effects · feeds`. A few unlock deeper checking: **`ensures`** (a boolean expression → machine-**proven** Green + mutation grading + inertness), **`renders: yes`** (a React/JSX component → proven against its rendered tree with `text/find/attr/hasClass`), **`records: <param>`** (an effectful unit → asserted against a recorded call/set trace), and two *declarations* that keep a Cell honest under the inertness check — **`throws: <condition>`** (a declared guard) and **`perf: <reason>`** (intentional semantically-invisible code like a cache). A governance hint, **`risk: low|medium|high`** (default `medium`), feeds Autopilot's `--max-risk` ceiling — high for money/auth/secrets/deploy/CI/irreversible, low for cosmetic or pure helpers. It's declared, not proven, and never overrides the security guard or owner-signed policy.

## What a signature attests to

**A signature covers the *specification* — the spec block's hash plus the Brief — and *never the implementation*.** The signed bytes are `canonical(approval)`, whose `items` map is `{ Cell-id → sha256(normalized spec block) }`, together with the Brief (title, prose, tags). **No code hash is ever part of the signed object.**

That single choice *is* the architecture — call it **A**: the human attests only to the spec, and the verifier continually re-establishes implementation → specification.

- **`yay verify` re-derives code → spec on every run** from the real files — static checks (the unit exists, declared `pure`/`effects` hold, no undeclared effects — per language) plus a **behavioural prover** with **mutation grading** and an **inertness check** for JS/TS, a **render prover** for React/JSX components (`renders: yes` → checked against the rendered tree), and an out-of-process **prover for pure Python functions**. This link is **never signed; it is re-checked, always,** against whatever the code currently is.
- **Edit the code, not the spec:** the seal still verifies (it's over the spec), and `verify` decides the colour — a faithful refactor stays **Green**, a drift from the promise flips **Red**. You refactor freely, no re-approval needed.
- **Edit the spec or the Brief:** the hash changes, the seal no longer matches, and the Cell drops to **Unsigned** — the promise itself changed, so it needs a fresh human signature.

So a **Green** Cell asserts two independent facts at once: *a human signed this exact promise* (the seal — cryptographic, offline-verifiable) **and** *the code provably keeps that promise right now* (verify — continuously re-derived). It is emphatically **not** option B (an implementation hash baked into the seal); the seal deliberately says nothing about the code, which is what lets refactors stay Green while genuine drift goes Red. Tampering with either half is caught: the lock is an append-only `prev`-chain, and verify never trusts a stored say-so — it recomputes from source every time.

## Signing that fits your pace — batching

The failure mode for any approval tool is fatigue: *"pull out the phone → approve → repeat"* until people rubber-stamp. YayLayer avoids it two ways.

**You sign intent, not edits.** A refactor or tweak that keeps the same spec needs **no new signature** (see above) — so a lot of small work never touches the phone at all.

**Batch mode (on by default) groups the small stuff.** The typical flow:

- Ask for a **big change** → the AI writes its specs + a Brief and you **sign it right away** (one Brief, one signature).
- Ask for a **small change** → the AI still writes its spec + code immediately (so nothing is untracked and you can **try it in action** right away, Unsigned), and quietly adds it to a **pending batch** — grouped **per concern** (by tag). When a batch reaches the **barrier** (default **5**) — or you're about to commit/push — it shows you the batch with a proposed title and asks: **close & sign, add one more, or keep going?** So a run of ten small tweaks becomes **one** signature, at a boundary you choose.
- Anything **sensitive, behaviour-changing, or policy-required** is never batched — it gets its own Brief immediately.
- Under **Autopilot**, batches form the same way but each is approved under your grant (delegated, awaiting ratification) (one Brief per batch, never per tiny change).

Tune it with **`yay batch <n>`** (raise/lower the barrier), `yay batch off` (a Brief per change), or the batch control in the dashboard's Briefs tab. Committing/pushing always flushes pending batches, so nothing rots unsigned.

## Commands

| Command | What it does |
|---|---|
| `yay init [dir] [--project <name>]` | guided setup — signing method, adopt, Brief tags, Constitution, optional plan |
| `yay keygen --name <you>` | create a local signing key (public → roster, private → encrypted keystore) |
| `yay pair [--name you]` | pair your **phone** as the signer (key stays on the phone); first pairing roots trust |
| `yay adopt [path] [--dry]` | insert draft (unsigned) spec blocks above un-tagged units |
| `yay sign [--cell IDs] [--brief "…"] [--title "…"] [--tags "…"]` | ask for approval — routes to your phone; `--name "<other>"` routes to a teammate's inbox, `--check` collects it |
| `yay verify [--strict] [-d]` | the gate — paint every Cell + run the prover; `--strict` exits non-zero if blocked (CI) |
| `yay dashboard [--port N]` | live control panel + phone relay — map, Preview (run scripts), tests, sign requests |
| `yay briefs [--by-tag] [--tag X]` | the Brief ledger (newest-first, or grouped/filtered by tag) |
| `yay tags [--set id\|add\|remove\|rename\|sets]` | the project's Brief-tag vocabulary (six sets or custom) |
| `yay inbox` / `yay requests` | your on-duty relay link · plain requests queued from the dashboard |
| `yay invite "Name"` · `yay enroll` · `yay revoke` · `yay reroot` | team roster — one-tap join, enroll/revoke a key, re-root trust |
| `yay policy [--init\|--set]` · `yay grant [--allow\|--deny\|--max-risk\|--child-grants]` · `yay ratify [--sign\|--reject]` | signing policy (who must sign) · Autopilot capability-envelope grants (+ child grants for helper-agent swarms) · ratify or reject delegated approvals |
| `yay attest [list\|verify]` · `yay reverify` · `yay witness` · `yay metrics` · `yay capability` | the machine verifier signs its own verdict (chained, capability-versioned) · re-verify history without rewriting it · integrity witness · earned-autonomy metrics · the verifier's derived capability + drift check |
| `yay archive [install\|--restore\|--verify\|--forget]` | Durable mode — encrypted, sha256-anchored archive of signed source (secret scan + signed tombstones) |
| `yay protect [--mode guarded\|strict] [--add\|--remove\|--ignore] [--off]` _(upcoming)_ | owner-signed **foundation seal** — reveal any change to the fixed core files (rules, CI, gitignore) |
| `yay test` · `yay adversary` · `yay plan` | run the project's own test suite · spec-only adversarial probing (LLM sees only the spec) · AI-synthesized System Plan |
| `yay map [-o file.html]` · `yay gate` · `yay constitution --for <keys>` · `yay status` | write the HTML map · write the CI gate · write the Constitution into your AI harness · one-line summary |

## Colors

🟢 **GREEN** code proven to match a signed spec · 🟡 **YELLOW** matches but flagged (prose-only, undeclared effect, unproven) · 🔴 **RED** code ≠ spec (or tampered signature) · ⚪ **UNSIGNED** awaiting a signature · 🩷 **PINK** code with **no formal specification at all** — untracked, never described or signed.

**Total coverage is the whole point.** PINK is the most dangerous state — unknown territory where silent bugs hide — so it **blocks the gate just like Red and Unsigned.** YayLayer never silently ignores code it doesn't understand: **any named unit** with no spec block — a function, object method, class method, or arrow-prop, *even nested inside an IIFE, object, or class* — shows up **Pink** (`«unitName»`) until you `yay adopt` it and sign it. Top-level imperative code that runs at load is flagged too. That way "green gate" honestly means *the whole project is covered*, not just the parts someone happened to tag. (The signature covers the **spec**, so you can still refactor freely; only a changed promise re-prompts you. Coverage uses a real parser — [`@babel/parser`](https://babeljs.io/docs/babel-parser) — so **JS, TypeScript, JSX and TSX** are all handled; genuinely unparseable files degrade gracefully to file-level grouping.)

### What happens if an AI injects code that wasn't there before?

In the common cases it lands in a **gate-blocking state**, and the AI has no key to turn any of them Green. Three ways it surfaces:

1. **A new function or unit with no spec → 🩷 Pink.** `verify` enumerates *every* named unit; anything untracked is Pink, and Pink blocks the gate like Red. This is where an exfiltration payload usually lives — a new helper or a top-level call.
2. **Behaviour that needs a new or changed promise → ⚪ Unsigned.** Editing a spec makes its Cell Unsigned — and the AI can't sign it back.
3. **Lines added to an existing signed function whose behaviour now contradicts its spec → 🔴 Red.** `verify` re-derives code⇔spec on every run: an undeclared side effect (network, filesystem, `localStorage`) in a `pure` Cell, or an output that breaks the `ensures`, turns it Red — and the mutation grader and spec-only adversary hunt for behaviour the `ensures` doesn't pin down.

**The honest boundary:** a payload that is *pure*, fully consistent with the signed `ensures`, and dormant until a trigger the generated inputs never hit could stay Green — `verify` proves the spec's *claims*, not the absence of all hidden behaviour. Effect-recording, mutation testing, the adversary, and reviewing the diff raise that bar without eliminating it. The guarantee is strongest on **JS/TS/JSX** (full parser + the Pink net + adversary). Note the signal is the **state** (Pink/Unsigned/Red), not a line-level diff — there's no code snapshot in the seal, by design (the signature attests to the *spec*).

## Higher-order: modules, flow & policies

YayLayer isn't only per-Cell — it models how Cells combine.

**Modules (`contains`).** A "module" is simply a Cell that declares `contains` instead of governing its own code. Its color **rolls up** to the worst of everything inside it, so a deep Red bubbles to the top and you can trace it down. By convention, container Cells use a high id range (`C-900+`):

```js
//∷YAY⟨C-900⟩ v1
//  unit:     Portfolio
//  intent:   The portfolio feature, composed of its calc Cells.
//  contains: C-040, C-041
//∷YAY-END⟨C-900⟩
```

Run `node bin/yay.js verify --dir examples` and `C-900` shows **Red** — *"rolled up from contained Cells"* — because `C-041` inside it is Red. In the map it's tagged `· module`, and its popup lists what it **Contains**.

**Flow (`feeds`).** A Cell lists the Cells it hands output to with `feeds`. That builds the graph the map draws, and verify flags a **broken edge** — a `feeds →` pointing at a Cell that doesn't exist.

**Policies (`P-…`) — roadmap.** Cross-cutting concerns that span many Cells and live in no single one (auth, logging, error handling) are modeled as first-class **Policies**: a selector (which Cells) + a checkable rule, verified as a **"for all matched Cells"** check — e.g. *"every route is behind auth."* Flavors: mandate / prohibit / grant. Designed in [`standard/STANDARD.md`](standard/STANDARD.md) §7 and `docs/`; not yet in the reference implementation.

**Implemented today:** `contains` roll-up, the `feeds` graph, and broken-edge detection — plus a **signing policy** (a different, shipped thing: owner-signed "who must sign what" rules, matched by path / tag / module, enforced at the gate — see the Standard §11). Full flow-contract checking (`producer.out ⊨ consumer.in`) and the richer checkable **Policy** engine (mandate / prohibit / grant) are on the roadmap.

## CI gate

`main` should be protected with a required check running:

```bash
yay verify --strict
```

Anything Red or Unsigned fails the check, so it can't be merged. The real enforcement lives here, in infrastructure the AI doesn't control — not in a local hook.

## Briefs & Git — two ledgers that move together

A **git commit** snapshots *code*; a **Brief** is the human-signed record of *intent* (you sign the **spec + Brief, never the code**). They live in different places a single commit unites: the **spec Cells live inline in your source** (so they commit with the code), while the **Brief and its seal live in `.yaylayer/`** (also git-tracked). `yay verify` never trusts a stored verdict — it **re-derives** each Cell from the tree, and the CI gate runs that on the **pushed commit**. So the seal and the code it authorizes must ride the **same commit**: commit code without its seal → that commit is **Unsigned** (blocked); edit a signed Cell's spec afterwards → its `specHash` changes and the seal no longer matches (back to needs-signing).

**Your AI is instructed to keep them in lockstep.** The Constitution written into your AI-harness files (`yay init --constitution`, Article 4) tells it: *when `yay verify` passes, **commit the code and `.yaylayer/` together in ONE commit**, and do **not** `git push` unless the human asks.* So each signed Brief lands as its own self-contained, human-authorized commit — pushing stays your call. It isn't strictly one-Brief-per-commit (batch mode groups small changes into one Brief), but the invariant holds: **never a commit with authorized code but no seal, or a seal with no code.** git records *what the code is*; the Brief records *that a human approved what it should be* — committed together so `yay verify` can prove the two still agree.

## What's built vs planned

A **working reference implementation** of the protocol — honest about scope.

**Verification & the gate:** marker extraction · manifest + `sha256` spec hashing · **ed25519** sign & verify over an append-only, `prev`-chained lock · the green/yellow/red/unsigned/**pink** gate with static, **per-language** code⇔spec checks (unit exists, declared purity holds, undeclared-effect flags with the offending line pinpointed — JS *and* Python effect nets) · a **pluggable prover** behind one adapter interface: a **behavioural prover + mutation grading + inertness check** for JS/TS, a **render prover** for **React/JSX** components (`renders: yes` → checked against the rendered tree, so components reach machine-**proven** Green), and an out-of-process **Python prover** so **pure Python functions with an `ensures` also reach proven Green** · **AST coverage** (`@babel/parser` — JS/TS/JSX/TSX) plus a **comment-agnostic + regex net for Python/Ruby** so every un-specced unit — *and top-level imperative code, in every scanned language* — shows **Pink** and blocks the gate · the remaining languages (C#, Rust, Go, Solidity, …) parse comment-agnostically and are capped honestly at **Yellow** · **`adopt`** · the interactive map (hierarchy, zoom, roll-up, module-flow, plus **Briefs / Tags / Policy / Signers** tabs) · guided `yay init` · `--strict` CI gate.

**Built-in security features:** the **inertness check** — flags code removable with every spec-derived test still passing (dead weight, ahead-of-spec scaffolding, or a **dormant payload** riding under a signature); Yellow by default, escalate to gate-blocking per path/tag with an **owner-signed** policy rule (`inert: block`), or relax to a note (`inert: note`) · **tamper-evident `.yaylayerignore`** — hiding *source* from the gate is Pink-blocking unless whitelisted by an owner-signed `ignore: source` policy rule (so the AI can't hide code by ignoring it).

**Phone signing is built** (not a stand-in): pair your phone over the **LAN** or via the end-to-end-encrypted **`relay.yaylayer.com`** — the key is generated on the phone and never touches the AI's machine · **24-word mnemonic** recovery · a live **dashboard** (`yay dashboard` — run tests, run `package.json` scripts, request changes, sign) · **teams** — a signed, hash-chained roster with owner/signer roles and `yay invite` / `enroll` / `revoke` / `reroot` · **signer routing** (`yay sign --name` → a teammate's inbox; fire-and-return) · **Autopilot** grants + ratification (`yay grant` / `yay ratify`) · a **signing policy** (who-must-sign, owner-signed into the roster) · **Briefs** with a short title + the prose, browsable as a list or a **Cloud view** (a card per tag) and in the terminal (`yay briefs`) · **Brief tags** (six starter sets or custom; the signer can correct the AI's tags on the phone at signing).

**Provenance & assurance is built** — the third cryptographic identity and the long-lived audit layer: **verifier attestation** (`yay attest` — the machine verifier signs its *own* verdict with a project/CI-scoped key that never ships in the package; append-only, chained, **capability-versioned**, and the version is **derived + self-asserting** so an attestation can never over-claim — `yay capability`) · **`yay reverify`** appends a fresh assessment when the verifier improves, never rewriting old Green · **`yay witness`** cross-checks the attestation chain, spec archive, and git-vs-ledger coverage · **`yay metrics`** turns your rejection history into earned-autonomy signals · **Autopilot** grants are signed **capability envelopes** (allow/deny paths, cells, `--max-risk`, and opt-in **child grants** for helper-agent swarms that can only attenuate) with **non-delegable** owner-signed backstops and first-class **rejections** · **Durable mode** (`yay archive`) — an encrypted (AES-256-GCM), sha256-anchored archive of the signed source with a pre-archive **secret scan** and honest signed **tombstones** · and a **keyless verifier + capability registry** so anyone can confirm an attestation in-browser at [yaylayer.com/verify](https://yaylayer.com/verify).

**Roadmap:** more prover **adapters** so the remaining signed-only languages (C#, Rust, Go, Solidity, …) also earn machine-**proven** Green — the interface is built (React and Python are the first two adapters); mutation grading + inertness for the out-of-VM (Python) adapter · **M-of-N multi-sig** · richer **Policy** flavors (mandate / prohibit / grant as checkable "for all matched Cells" rules) · scope-aware flow-contract checking · automated merge re-proving · LLM-driven `adopt` intent derivation.

## Mobile signing — the safety model

Every color in YayLayer ultimately rests on one thing: a **human signature** over the spec. That makes the signing key the crown jewel — whoever holds it can approve code *as you*. If that key ever sat on the machine the AI runs on, the AI (or any malware there) could forge your approval and paint its own code Green. **Mobile signing removes the key from the AI's reach entirely** — and it's built: pick it at `yay init` (Mobile-LAN or Mobile-relay), then `yay pair` your phone. *(A local passphrase-encrypted keystore is still available for solo work and CI, chosen with the Local option.)*

**Where the key lives.** Your private key is generated on your **phone** and never leaves it — held in the phone's secure hardware (Secure Enclave / Android Keystore) and released only by **Face ID / biometric**, per signature. The AI's machine only ever sees your **public** key (in the committed roster).

**How you approve — the flow:**

1. **Pair once.** Scan a QR code to enroll your phone's public key into the project roster. After that the phone and `yay` talk over an encrypted push channel.
2. **Request.** When specs are ready, `yay` sends an **approval request** — the spec **hashes**, the plain-English `intent` of each Cell, and a per-request **nonce** — up to a **rendezvous server**.
3. **Review on-device.** Your phone shows *exactly what you're signing* — the intents and hashes. You read them and confirm with Face ID.
4. **Sign.** The phone signs the canonical approval bytes and returns only the **signature**; `yay` appends it to `.yaylayer/lock.json`.

**Why it's safe — what each party can and can't do:**

- **The rendezvous server is untrusted.** It relays hashes and timestamps only — it never sees your code and never holds your key. With no key it **cannot forge** a seal, and because you verify the hashes on-device and the signature covers them, it **cannot alter what you approved**. The worst it can do is drop or delay a request (annoying, not dangerous).
- **The AI can't self-approve.** It never touches the private key, so it can produce specs and code but **never a valid signature** — its work stays Unsigned until *you* sign.
- **Replays are dead on arrival.** The per-request **nonce** means a captured approval can't be re-submitted to bless different code.
- **Tampering is caught.** The lock is an append-only **`prev`-chain** (tamper-evident history), and `verify` always **recomputes hashes from the real files** — so editing code after it was signed flips it Red even though the old seal still verifies.

So *"can someone with a private key fake-sign?"* — only the holder of **your phone plus your face** can, which is the whole point: a green gate provably means **you** stood behind it.

**If you lose the phone.** Your key backs up as a **24-word mnemonic + passphrase** — so a lost phone **restores the *same* key** with nothing to re-sign. Pick the right path by *why* you lost access: **have your 24 words** → restore (no discontinuity); **lost the words, solo** → `yay reroot` (new trust root); **lost the words / compromised, on a team** → another owner **revokes** the old key and **enrolls** a new one (root untouched). For a *compromised* key, restore is useless — the attacker has the same key — so you **retire** it (reroot) or **revoke** it, not restore. `yay reroot` is the deliberate last resort.

**Is `yay reroot` a backdoor?** No — it only *proposes* a new root; the **CI root-pin blesses it**. A reroot changes the root fingerprint, so `yay verify` reports **TRUST-ROOT MISMATCH** and the **gate blocks** — a loud alarm, not a silent takeover. Making a new root real means a human repoints the pin via `yay gate` in GitHub's **branch-protected settings** (outside the repo and the AI's reach). So repo-write alone can *trip the alarm* but can't take over without also compromising your GitHub settings, and reroot can't rewrite past signatures. The one caveat: with no CI gate/pin (local-only) a reroot has no backstop — but then nothing is truly enforced anyway.

## Who runs `yay sign`: the AI asks, you approve

Signing has **two roles**, and keeping them straight avoids a lot of confusion:

- **The AI runs `yay sign`** — this is *asking for approval*. The command builds the change-set and sends the request to your phone; it then **blocks until you answer**.
- **You approve on the phone** — this is *giving the signature*. Your phone is the only place the key exists; you review the Brief + specs and tap **Accept** (or **Send back**).

So **let your AI run `yay sign` as its own tool call** and wait for your tap. If *you* run `yay sign` yourself in a separate terminal, the AI that's building for you didn't launch it — it can't see the result and won't automatically continue once you've approved. (Running it yourself is fine when *you're* the one driving; just don't do it in parallel with an AI that's waiting on its own request.) The phone shows the requested signer's name and blocks the wrong person from approving; on a team, use `yay sign --name "<Teammate>"` to route the request to *their* inbox instead (see **signer routing** in the Standard).

## HTTPS & trusting the certificate on your phone

Phone signing is served over **HTTPS by default** (`--no-https` opts out). This is about *server identity*, **not** signature security: your ed25519 signatures are safe over any transport — the seal covers the spec hash and is verified offline — so a certificate warning never weakens what you're signing. HTTPS just stops a same-network attacker from impersonating the signing page.

A self-signed cert works but the phone will warn once. To make it **warning-free**:

**1. Trust the CA on your laptop (mkcert).**
```bash
brew install mkcert && mkcert -install
```
Chrome/Safari read the macOS **system keychain**; **Firefox** keeps its own store, so also `brew install nss`. **After installing mkcert you must restart `yay dashboard`** — a running server keeps serving the *old* self-signed cert until restarted. Chrome caches its "not secure" verdict, so fully quit (⌘Q) and reopen. (Safari shows no padlock detail for local certs — "no warning" *is* the pass.)

**2. Get the CA onto the phone.** The root is at `~/Library/Application Support/mkcert/rootCA.pem` — copy it to your Desktop and **AirDrop** it to the phone (or open `<dashboard-url>/trust` on the phone for a guided flow).

**3a. iOS — the two-screen gotcha.** Installing the profile is only step 1: **Settings → General → VPN & Device Management** → install the profile (there's *no* trust toggle here). The trust toggle is somewhere else: **Settings → General → About → (scroll to the very bottom) → Certificate Trust Settings → Enable Full Trust For Root Certificates → toggle the mkcert entry ON.** If that row is missing, the file was opened as a preview rather than installed — re-transfer it.

**3b. Android.** **Settings → Security (or Security & privacy) → Encryption & credentials / More security → Install a certificate → CA certificate** → pick the file → accept the warning. (Android 7+ apps don't trust user-added CAs by default, but **browser** traffic does, so the signing page works. Menu names vary by manufacturer.)

**Note:** the cert is bound to your machine's **LAN IP** (in the SAN), so it regenerates when that IP changes; the phone key is per-origin, so a new IP just means restoring the key from your 24 words. A future hosted domain with a real CA cert removes this whole dance.

## Foundation seal — tamper & corruption evidence for the core *(upcoming)*

Ordinary code changes freely — that's the job, and it's governed by the normal spec→sign→verify gate. But a few files define **how the AI and the rules operate** and should stay fixed in ~99% of cases: the **Constitution** (`CLAUDE.md`/`AGENTS.md`…), the **CI gate workflow**, `.gitignore`/`.yaylayerignore`, the protocol files. The **foundation seal** is an **owner-signed baseline** of that fixed core, so any change to it is **revealed** at `yay verify` — whether from a hijacked AI, disk/bit-rot corruption, a bad merge, or an accident. It's **detection, not prevention**, and **cause-agnostic**: the current bytes simply no longer match what the Owner last vouched for. The baseline is signed by the **Owner's phone key** (never on the AI's machine), so it's math a rogue agent can't forge — you're never left blind to a change in the crown jewels.

It watches **content drift** (the hash of each sealed file — for rule files, only the managed `YAYLAYER:BEGIN…END` block, so your own notes around it stay free) and **structural drift** (a new or removed *tracked* file in a watched zone — repo root, `.github/`, `.yaylayer/`). That complements the Pink net: **Pink catches rogue *code*; the seal catches rogue *files*** of any type (a workflow, a shell script). `.gitignore` is itself sealed, because it controls the blind spot.

- **Postures, picked at `yay init`/`adopt` (default Guarded):** **Off** (no seal) · **Guarded** (drift raises a loud warning, gate still passes) · **Strict** (drift blocks the gate until you re-seal). The only difference between Guarded and Strict is warn-vs-block; nothing else changes. *Secure by default, yours to tune.*
- **Un-removable:** the seal is an owner-signed, append-only, trust-root-pinned event — deleting or disabling it breaks the pinned chain and is itself flagged. Only a human Owner can create, re-seal, or turn it off.
- **Signed ignore list:** a tracked file that legitimately churns (a committed CHANGELOG) can be excluded — but the exclusion lives *inside the owner-signed seal*, so the AI can't add `ignore: payload.js` without the phone key. (Gitignored files like `.env` are already outside the watch.)
- **Re-seal** on a legitimate change with `yay protect` (one phone tap) — the AI can't clear the alarm; only a human with the Owner key can. Each seal is an append-only signed event, so the foundation has its own audit trail.

## Security notes

- **Never commit private keys or secrets.** `.yaylayer/keys/`, `*.keystore`, and `.env*` are gitignored. `config.json` (public keys) and `lock.json` (seals) *are* committed — that's the shared proof state.
- **Phone signing** keeps the private key **only on your phone**, so it never touches the AI's machine — choose Mobile-LAN or Mobile-relay at `yay init`. The **Local** option (a passphrase-encrypted keystore on disk) is available for solo work and CI; treat that keystore as sensitive since the key lives on the machine.
- **The verifier isn't in your repo.** `yay verify` (the code that assigns Green/Yellow/Red) is the installed `yay-layer` package; CI installs it **fresh** on a clean checkout and pins the trust root — so the AI can't edit the colour rules to reach the gate, and self-enrolling in `config.json` is rejected (trust comes only from the owner-signed roster).
- **You can't hide code from the gate.** A `.yaylayerignore` line that excludes *source* turns the gate **Pink** unless an owner-signed policy `ignore: source` rule authorises it (for vendored/generated code). Build artifacts and non-code stay free to ignore.
- Verification always **recomputes hashes from the real files** and checks signatures against public keys — nothing is trusted on a stored say-so.

## Contributing

YayLayer is early, MIT-licensed, and built in the open — a great time to help shape the protocol. High-leverage areas:

- **Language adapters** — per-language AST + behavioural proving so the *signed-only* tier (Python, C#, Rust, Go, Solidity, …) can also earn machine-**proven** Green.
- **Teams & policy** — M-of-N multi-sig for crown-jewel Cells, safe merge re-proving, and the richer Policy engine (mandate / prohibit / grant).
- **Real-world use** — try it on a project and open issues: rough edges, confusing docs, missing comment syntaxes. Field feedback shapes the roadmap most.
- **Docs & examples** — walkthroughs, example projects, integrations.

How to start: read [`CONSTITUTION.md`](CONSTITUTION.md) and [`standard/STANDARD.md`](standard/STANDARD.md) (the protocol's source of truth), run `node test/smoke.js` before a PR, and **open an issue to discuss anything non-trivial first**. Keep changes spec-first — YayLayer is built with YayLayer, so `yay verify` should stay green. Issues and PRs: [github.com/jonas-developer/yay-layer](https://github.com/jonas-developer/yay-layer).

## License

MIT © L.J Bergman. See [`LICENSE`](LICENSE).
