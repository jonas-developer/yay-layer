# Security policy

YayLayer is a trust tool, so the security of the tool itself matters. Thank you for reporting responsibly.

## Reporting a vulnerability

**Do not open a public issue for a security vulnerability.** Instead, either:

- **Email** [contact@yaylayer.com](mailto:contact@yaylayer.com) with details and, ideally, a proof-of-concept; or
- Use **GitHub's private vulnerability reporting** ("Report a vulnerability" on the repository's *Security* tab).

Please include: affected version (`yay --version`) and verifier **capability** (`yay capability`), the signing mode (local / LAN / relay), and a minimal reproduction. We aim to acknowledge within **3 business days** and to agree a disclosure timeline with you; please give us a reasonable window to fix before public disclosure.

## Supported versions

| Version | Supported |
|---------|-----------|
| `1.x` (and the current `1.0.0-rc`) | ✅ |
| `0.1.x` | ❌ (withdrawn — see `CHANGELOG.md`) |

## Scope — what a report should target

The trust model and its guarantees are laid out in the **[threat model](documentation/07-security-model.md#threat-model-one-page)** (also in the [manual](https://yaylayer.com/docs/manual.html)). In scope, for example:

- Forging a human signature, or getting unsigned / mismatched / ungoverned code to a **PASS** verdict.
- **WYSIWYS** bypass — making the phone sign something other than what it displays.
- Tampering with a signed spec, seal, roster, or attestation **without detection**.
- The AI/agent widening its own authority past a grant, or signing without the human key.
- Shipping the verifier's **private** signing key in the npm package (it must never be there).

## Out of scope (by design — see the threat model's *non-guarantees*)

- **Host-admin bypass:** whoever controls the git host's settings can turn the CI gate off — enforcement is only as strong as your branch-protection policy + account security. (Detection still survives: such code stays cryptographically unsigned/mismatched to any `yay verify`.)
- **Signing a bad spec**, or approving malicious behaviour — the human is the boundary.
- **"Green" read as a proof of correctness / security** — it is a bounded conformance check, not a proof for all inputs or an absence-of-vulnerabilities claim.
- **Verifier blind spots** in signed-only languages, and third-party dependencies (`node_modules`).

## Good to know

- The verifier's **private** key is machine-held and gitignored; only the **public** key is committed. Anyone can verify an attestation (`yay attest verify`, or in-browser at [yaylayer.com/verify](https://yaylayer.com/verify)) but cannot forge one.
- Never commit private keys or secrets: `.yaylayer/keys/`, `*.keystore`, and `.env*` are gitignored.
