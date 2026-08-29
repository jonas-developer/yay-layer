# Security Policy

YayLayer is a trust tool — its whole job is to make AI-written code accountable — so security reports matter a great deal here. Thank you for helping keep it honest.

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Use one of these private channels instead:

- **GitHub private vulnerability reporting** (preferred): on this repository, go to the **Security** tab → **Report a vulnerability**. This keeps the report private until a fix is ready.
- **Email:** [contact@yaylayer.com](mailto:contact@yaylayer.com)

Please include, as best you can:

- what the issue is and where (file, command, or endpoint),
- steps to reproduce or a proof of concept,
- the impact you think it has,
- the version (`yay --version`) and your OS / Node version.

## What to expect

YayLayer is early and maintained by a small team, so responses are best-effort:

- **Acknowledgement:** within a few days.
- **Assessment & fix:** we'll work with you on severity and a timeline, and credit you in the release notes unless you prefer to stay anonymous.
- **Disclosure:** coordinated — we ask that you give us a reasonable window to ship a fix before any public write-up.

## Supported versions

While YayLayer is pre-1.0, security fixes land on the **latest** published version.

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |
| < 0.1   | ❌        |

## Scope

Especially interested in reports that touch the **trust boundary**, since that's where YayLayer's guarantees live:

- **Signing & verification** — anything that lets an approval, seal, or roster be forged, replayed, moved to different code, or verified against the wrong key.
- **The gate** — anything that makes `yay verify --strict` pass code it should block (Red / Unsigned / Pink), i.e. a "false green".
- **Key custody** — anything that could expose or exfiltrate a signing key (it's meant to stay only on the phone, or in the passphrase-encrypted local keystore).
- **The relay** (`relay.yaylayer.com` / the `yay-layer-relay` repo) — the relay is an untrusted pass-through by design; report anything that lets it read, alter, or forge end-to-end-encrypted traffic.
- **The dashboard** — the localhost-gated action endpoints, or anything reachable from another device that shouldn't be.

## Out of scope

- Vulnerabilities in third-party dependencies (report those upstream; tell us if YayLayer's usage makes them exploitable).
- Findings that require an already-compromised machine or a key the attacker already holds.
- Missing hardening that is documented as deferred (e.g. Secure-Enclave / biometric key storage) — mention it, but it's known.

## A note on the model

By design, the human signs the **specification**, and `yay verify` continuously re-derives whether the code still matches it. A signing key never leaves the phone (or the encrypted local keystore), and no code hash is ever inside the signed object. Reports that break any of these properties are exactly what we want to hear about.
