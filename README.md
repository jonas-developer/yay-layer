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

## Try it in under a minute

You need **Node ≥ 18**. Clone, install its one dependency ([`@babel/parser`](https://babeljs.io/docs/babel-parser), which handles JS, TypeScript, JSX & TSX), and run:

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
1. **Signing key** — choose **Local** (encrypted key on this machine) or **Mobile** (key stays on your phone — *under development*, so it's noted and skipped for now).
2. If Local, it asks for your **name** and a **passphrase**, and creates the key.
3. **Adopt** — asks whether the project already has code; if yes, it runs `adopt` to scaffold draft specs over it.

Prefer to script it (or skip the prompts)? Pass flags: `yay init --key local --name you --adopt` (or `--no-adopt`, `--key mobile`). The manual equivalents of each step:

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

## Commands

| Command | What it does |
|---|---|
| `yay init [dir] [--project <name>]` | set up YayLayer in `[dir]` (or the current folder); `--project` is a free-form display name (defaults to the folder name) |
| `yay keygen --name <you>` | create your signing key; public key → roster, private key → encrypted keystore |
| `yay adopt [path] [--dry]` | insert draft (unsigned) spec blocks above un-tagged functions |
| `yay sign [--all \| --cell C-040,C-041] [--name <you>]` | sign a change-set (append a seal to the lock) |
| `yay verify [--strict] [-d] [--dir <path>]` | the gate; `--strict` exits non-zero if blocked (for CI); `-d`/`--details` prints each Cell's spec, code & checks |
| `yay map [-o file.html]` | write the flowchart — Cells grouped into collapsible modules with roll-up health + module-flow arrows (defaults to `yay-layer-map.html`) |
| `yay status` | one-line summary |

## Colors

**GREEN** code proven to match a signed spec · **YELLOW** matches but flagged (prose-only, undeclared effect, unproven) · **RED** code ≠ spec (or tampered signature) · **UNSIGNED** awaiting a signature · **PINK** code with **no formal specification at all** — untracked, never described or signed.

**Total coverage is the whole point.** PINK is the most dangerous state — unknown territory where silent bugs hide — so it **blocks the gate just like Red and Unsigned.** YayLayer never silently ignores code it doesn't understand: **any named unit** with no spec block — a function, object method, class method, or arrow-prop, *even nested inside an IIFE, object, or class* — shows up **Pink** (`«unitName»`) until you `yay adopt` it and sign it. Top-level imperative code that runs at load is flagged too. That way "green gate" honestly means *the whole project is covered*, not just the parts someone happened to tag. (The signature covers the **spec**, so you can still refactor freely; only a changed promise re-prompts you. Coverage uses a real parser — [`@babel/parser`](https://babeljs.io/docs/babel-parser) — so **JS, TypeScript, JSX and TSX** are all handled; genuinely unparseable files degrade gracefully to file-level grouping.)

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

This is a **v0.1 reference implementation of the protocol's spine** — one dependency (`@babel/parser`), honest about scope.

**Working today:** marker extraction · manifest + `sha256` spec hashing · **ed25519** keygen, encrypted keystore, sign & verify · the green/yellow/red/unsigned gate with static code⇔spec checks (unit exists, declared purity holds, undeclared-effect flags with the offending line pinpointed) · **AST-based coverage** (`@babel/parser` — **JS, TS, JSX, TSX**) — every named unit (functions, methods, class methods, arrow-props, at any depth) with no spec shows **Pink** and blocks the gate · **AST-based `adopt`** that scaffolds specs over all of them · the interactive HTML map — a real **hierarchy** (Module → Public API / Internal / classes → units), collapsible zoom, roll-up health, and **module-flow from the call graph** · guided `yay init` wizard · `--strict` CI exit code.

**Roadmap** (designed in `docs/`, not yet built): the **phone signer + encrypted rendezvous channel** (the local keystore is today's stand-in) · 24-word **mnemonic** backup · property tests from `ensures`, real effect analysis, **mutation scoring** · scope-aware flow resolution · the **Policy** engine · **freedom-mode** grants + ratification queue · **multi-sig / roles** · LLM-driven `adopt` intent derivation.

## Mobile signing — the safety model *(roadmap)*

Every color in YayLayer ultimately rests on one thing: a **human signature** over the spec. That makes the signing key the crown jewel — whoever holds it can approve code *as you*. If that key ever sat on the machine the AI runs on, the AI (or any malware there) could forge your approval and paint its own code Green. **Mobile signing removes the key from the AI's reach entirely.** *(Designed in [`standard/STANDARD.md`](standard/STANDARD.md) §8; not yet built — the local passphrase-encrypted keystore is today's stand-in.)*

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

**If you lose the phone.** Your key backs up as a **24-word mnemonic + passphrase**, and you can enroll a **second key** — so a lost phone restores the *same* identity with nothing to re-sign. Re-issuing a fresh trust root is a rare, deliberate one-signature fallback.

## Security notes

- **Never commit private keys or secrets.** `.yaylayer/keys/`, `*.keystore`, and `.env*` are gitignored. `config.json` (public keys) and `lock.json` (seals) *are* committed — that's the shared proof state.
- The MVP keystore is a local, passphrase-encrypted stand-in. The production model keeps the private key **only on your phone** (Face ID), so it never touches the AI's machine. Treat the local keystore accordingly.
- Verification always **recomputes hashes from the real files** and checks signatures against public keys — nothing is trusted on a stored say-so.

## License

MIT © the YayLayer authors. See [`LICENSE`](LICENSE).
