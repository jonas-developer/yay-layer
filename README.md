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

## Optional: put `yay` on your PATH

So you can type `yay …` instead of `node bin/yay.js …`:

```bash
npm link                    # from the repo root
yay verify --dir examples   # now this works
```

Everything below uses `yay`; if you skipped `npm link`, just prefix commands with `node bin/yay.js` (e.g. `node bin/yay.js verify`).

## Use it in your own project

```bash
yay init --project my-app     # set up .yaylayer/ (config + lock)
yay keygen --name you         # create your signing key (encrypted keystore)
yay adopt src                 # optional: scaffold draft specs over existing code
#   … you + your AI write/prune spec blocks above each unit …
yay sign --all                # approve the current specs (asks for your passphrase)
yay verify                    # the gate: paint every Cell
yay map -o map.html           # write the visual flowchart
```

Pass the passphrase non-interactively with `YAY_PASSPHRASE=…` for scripts/CI.

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
| `yay init` | set up YayLayer in the repo (`.yaylayer/config.json` + `lock.json`) |
| `yay keygen --name <you>` | create your signing key; public key → roster, private key → encrypted keystore |
| `yay adopt [path] [--dry]` | insert draft (unsigned) spec blocks above un-tagged functions |
| `yay sign [--all \| --cell C-040,C-041] [--name <you>]` | sign a change-set (append a seal to the lock) |
| `yay verify [--strict] [--dir <path>]` | the gate; `--strict` exits non-zero if blocked (for CI) |
| `yay map [-o file.html]` | write the colored flowchart |
| `yay status` | one-line summary |

## Colors

**GREEN** code proven to match a signed spec · **YELLOW** matches but flagged (prose-only, undeclared effect, unproven) · **RED** code ≠ spec (or tampered signature) · **UNSIGNED** awaiting a signature. The signature covers the **spec**, so you can refactor freely; only a changed promise re-prompts you.

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
