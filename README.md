# YayLayer

**A protocol for provable, signed AI code.**

> YayLayer is a **building permit for AI-written code**: approved blueprints first, an inspector who checks the build matches them, and you can't move in until it passes.

You describe what you want; the AI writes a tiny, human-readable **spec** above each unit of code; you **sign it** from your phone; and a checker **proves** the code matches — painting the whole project **green / yellow / red**. Green means proven. It's how you *own* code you didn't hand-write — and prove a human stood behind it.

- **Review intent, not diffs** — approve a one-sentence contract per unit.
- **Kills AI bloat** — code that does *more* than its spec turns Red, forcing the AI to simplify.
- **Attributable authorship** — every approval is cryptographically signed by a *named* human.
- **CI-enforced** — unsigned or mismatched code can't reach `main`.

See the design in [`docs/`](docs/) · the spec in [`standard/STANDARD.md`](standard/STANDARD.md) · the AI rules in [`CONSTITUTION.md`](CONSTITUTION.md).

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

## Try it in 30 seconds (no install)

Zero runtime dependencies — you only need **Node ≥ 18**. Clone the repo and run one command from inside it:

```bash
git clone https://github.com/jonas-developer/yay-layer.git
cd yay-layer
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
node bin/yay.js map --dir examples -o map.html   # then open map.html in a browser
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

> **About `--project`:** it's just a **free-form display name** — call it anything you like (e.g. `--project "My Fancy App"`). It defaults to the folder name, and only shows up as a label in `yay status` and the map header. It does **not** affect behaviour and it is **not** a path (avoid slashes, or `yay` will think you meant a directory).

```bash
yay init                      # set up .yaylayer/ here; name defaults to the folder name
yay init --project "My App"   # …or give it any display name you want
yay keygen --name you         # create your signing key (encrypted keystore)
yay adopt src                 # optional: scaffold draft specs over existing code
#   … you + your AI write/prune spec blocks above each unit …
yay sign --all                # approve the current specs (asks for your passphrase)
yay verify                    # the gate: paint every Cell
yay map -o map.html           # write the visual flowchart
```

Pass the passphrase non-interactively with `YAY_PASSPHRASE=…` for scripts/CI.

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

## Commands

| Command | What it does |
|---|---|
| `yay init [dir] [--project <name>]` | set up YayLayer in `[dir]` (or the current folder); `--project` is a free-form display name (defaults to the folder name) |
| `yay keygen --name <you>` | create your signing key; public key → roster, private key → encrypted keystore |
| `yay adopt [path] [--dry]` | insert draft (unsigned) spec blocks above un-tagged functions |
| `yay sign [--all \| --cell C-040,C-041] [--name <you>]` | sign a change-set (append a seal to the lock) |
| `yay verify [--strict] [-d] [--dir <path>]` | the gate; `--strict` exits non-zero if blocked (for CI); `-d`/`--details` prints each Cell's spec, code & checks |
| `yay map [-o file.html]` | write the colored flowchart |
| `yay status` | one-line summary |

## Colors

**GREEN** code proven to match a signed spec · **YELLOW** matches but flagged (prose-only, undeclared effect, unproven) · **RED** code ≠ spec (or tampered signature) · **UNSIGNED** awaiting a signature. The signature covers the **spec**, so you can refactor freely; only a changed promise re-prompts you.

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

**Implemented today:** `contains` roll-up, the `feeds` graph, and broken-edge detection. Full flow-contract checking (`producer.out ⊨ consumer.in`) and the Policy engine are on the roadmap.

## CI gate

`main` should be protected with a required check running:

```bash
yay verify --strict
```

Anything Red or Unsigned fails the check, so it can't be merged. The real enforcement lives here, in infrastructure the AI doesn't control — not in a local hook.

## What's built vs planned

This is a **v0.1 reference implementation of the protocol's spine**, deliberately zero-dependency and honest about scope.

**Working today:** marker extraction · manifest + `sha256` spec hashing · **ed25519** keygen, encrypted keystore, sign & verify · the green/yellow/red/unsigned gate with static-lite code⇔spec checks (unit exists, declared purity holds, undeclared-effect flags) · roll-up for container Cells · broken-edge detection · the HTML map · the `adopt` scaffolder · `--strict` CI exit code.

**Roadmap** (designed in `docs/`, not yet built): the **phone signer + encrypted rendezvous channel** (the local keystore is today's stand-in) · 24-word **mnemonic** backup · full per-language **AST adapters** (property tests from `ensures`, real effect analysis, mutation scoring) · the **Policy** engine · **freedom-mode** grants + ratification queue · **multi-sig / roles** · LLM-driven `adopt` intent derivation.

## Security notes

- **Never commit private keys or secrets.** `.yaylayer/keys/`, `*.keystore`, and `.env*` are gitignored. `config.json` (public keys) and `lock.json` (seals) *are* committed — that's the shared proof state.
- The MVP keystore is a local, passphrase-encrypted stand-in. The production model keeps the private key **only on your phone** (Face ID), so it never touches the AI's machine. Treat the local keystore accordingly.
- Verification always **recomputes hashes from the real files** and checks signatures against public keys — nothing is trusted on a stored say-so.

## License

MIT © the YayLayer authors. See [`LICENSE`](LICENSE).
