# Contributing to YayLayer

YayLayer is early, MIT-licensed, and built in the open — a great time to help shape the protocol. Whether you're fixing a typo, adding a language adapter, or trying it on a real project and telling us what hurt, you're welcome here.

## Ways to help

- **Language adapters** — the highest-leverage work. Per-language AST + behavioural proving so today's *signed-only* tier (Python, C#, Rust, Go, Solidity, and more) can also earn machine-**proven** Green, plus more comment syntaxes and out-of-the-box extensions.
- **Teams & policy** — M-of-N multi-sig for crown-jewel Cells, safe merge re-proving, and a richer policy engine (mandate / prohibit / grant).
- **Real-world use** — install it, run it on something real, and open issues about rough edges, confusing docs, or missing pieces. Field feedback shapes the roadmap more than anything else.
- **Docs & examples** — walkthroughs, example projects, and integrations.

## Before you start

- **Read the source of truth first:** [`CONSTITUTION.md`](CONSTITUTION.md) and [`standard/STANDARD.md`](standard/STANDARD.md) define how the protocol behaves. Changes to behaviour should be reflected there.
- **Open an issue to discuss anything non-trivial** before writing a lot of code. It saves everyone time and keeps the design coherent while things are still moving fast.
- Small fixes (typos, docs, obvious bugs) can go straight to a pull request.

## Development setup

You need **Node ≥ 18**.

```bash
git clone https://github.com/jonas-developer/yay-layer.git
cd yay-layer
npm install
```

Run the CLI locally without installing it globally:

```bash
node bin/yay.js help
node bin/yay.js verify --dir examples
```

## Running the tests

There's a single, fast, dependency-light smoke suite. **Run it before every PR** — it must stay green:

```bash
node test/smoke.js
```

Please add checks to `test/smoke.js` for anything you change or add. Bug fixes should come with a check that fails before the fix and passes after.

## Working spec-first

YayLayer is built *with* YayLayer, so:

- Keep `yay verify` green. If you change what a unit does, update its spec Cell and re-sign as part of the change — don't leave the code drifting from a signed spec (that's exactly the Red state the tool exists to catch).
- Prefer smaller, single-concern pull requests. If a change mixes unrelated concerns (say, a security fix and a UI tweak), split it.

## Style

- Match the surrounding code: same naming, comment density, and idioms as the file you're editing.
- No new runtime dependencies without discussion — YayLayer deliberately ships with a tiny dependency footprint (crypto is vendored). If you think a dependency is warranted, raise it in an issue first.
- Keep user-facing CLI text and docs plain, honest, and free of overclaiming — never describe unproven code as proven.

## Pull requests

- Branch off `main`, keep the history readable, and describe **what** changed and **why**.
- Make sure `node test/smoke.js` passes.
- Note any change to `CONSTITUTION.md` / `standard/STANDARD.md` in the PR description.
- By contributing, you agree your contributions are licensed under the project's [MIT License](LICENSE).

## Security

Found a vulnerability? **Don't open a public issue** — see [`SECURITY.md`](SECURITY.md) for how to report it privately.

## Questions

Open a GitHub issue (or a Discussion, once enabled). Thanks for helping make AI-written code something people can actually trust.
