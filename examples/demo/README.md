# Demo dashboard generator

Regenerates the public demo at **yaylayer.com/demo/dashboard.html** (linked from the site's
Features page as "See a live example"). It builds a throwaway **coinwatch** project with a
deliberate spread of Cell states and governance data, then runs the current `yay map`, so the
demo always reflects the live dashboard design instead of drifting into a stale hand-made copy.

## Regenerate

```bash
bash examples/demo/build.sh
# → examples/demo/dashboard.html
```

Then publish:

```bash
cp examples/demo/dashboard.html ../yaylayer-site/public/demo/dashboard.html
# commit & push yaylayer-site (auto-deploys to yaylayer.com)
```

## What the demo shows

- **All five states** — Green (`addHolding`, pure + checkable `ensures`), Yellow (`formatMoney`
  prose-only; `NotifyDrop` a signed-only Go Cell), Red (`syncPrices` declares `pure: yes` but
  does network I/O), Unsigned (`exportReport`), Pink (`roundLots`, no Cell).
- **Briefs** across concerns, one tagged `security`.
- **Signers** — two enrolled (Alex, Sara).
- **Verifier attestation** — minted with `--force` (the demo spread blocks the gate on purpose).
- **Autopilot governance** — an active grant, one delegated Cell awaiting ratification (`sparkPoints`),
  and one rejected delegation (`trendBadge`).

Files: `write-src.js` (the signed/unsigned/pink tree), `write-delegated.js` (the two Cells produced
under the grant), `build.sh` (the full flow). Local signing via `YAY_PASSPHRASE`, so it runs headless.
