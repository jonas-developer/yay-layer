# 11 — Glossary

**Agent** — the AI (or automation) that produces Briefs, specs, and code. The **untrusted producer**: may say *what* it made, never that it's correct or approved.

**Attestation** — an immutable, content-addressed record of a claim. Verifier attestations are also **signed** (by the verifier key).

**Authority axis** — the human-trust dimension of a Cell: Unapproved → Delegated → Ratified. Orthogonal to the verification axis.

**Autopilot** — friendly name for delegated execution: operating under a grant. Formal term: **Delegated execution**.

**Brief** — the human-readable headline over a change-set: title + 1–3 sentences of intent + the Cells it covers. Signed with the specs; attributes intent; never earns Green.

**Capability envelope** — the signed set of constraints in a grant (allowed/prohibited paths, deps, max-cells, risk, deployment, child-grants…).

**Cell** — a unit of code plus its inline spec block, delimited by `∷YAY⟨id⟩ … ∷YAY-END⟨id⟩`. The atomic thing YayLayer governs.

**Content-addressed** — stored/looked-up by the hash of the content, so identical content is stored once and any change yields a new object.

**Delegated** — produced under a valid grant; not yet human-reviewed.

**Delegated execution** — formal term for Autopilot.

**Durable (provenance)** — mode where source code is archived (encrypted) inside the project's provenance store, surviving git loss. Cf. **Standard**.

**Effect net** — per-language regex/analysis that detects side effects (I/O, network, exec) so a `pure`-declared Cell with effects goes Red.

**Evidence manifest** — the granular, separately-hashed proof behind a verdict (static-analysis / mutation / prover / test results).

**Forward signing** — the default: signing the spec + Brief *before* the code exists. The trunk of the human's three acts.

**Gate** — the CI check (`yay verify --strict`) that blocks Red / Unsigned / Pink from `main`.

**Grandfathering** — leaving already-approved history valid when the verifier improves, rather than re-failing it. Configured by the **reverification posture** (off/guarded/strict), optionally scoped per-Cell via a `reverify: latest` policy rule.

**Grant** — an owner-signed authorization for the agent to act autonomously within an envelope, to be ratified later.

**Green / Yellow / Red / Unsigned / Pink** — the **verification** states. Green = satisfies spec; Yellow = signed-but-unproven / capped; Red = contradicts spec; Unsigned = no valid signature; Pink = code with no governing Cell.

**Integrity witness** — using the provenance ledger to detect that git history was rewritten away from what was originally verified.

**Inertness** — a branch removable with every spec-derived test still passing (dead weight / ahead-of-spec scaffolding / dormant payload); default Yellow, policy-adjustable.

**Non-delegable** — categories (auth, payments, secrets, deploy, CI/security, trust config) that require human approval *before* execution, not execute-then-ratify.

**Provenance** — the full chain: who had authority, where it came from, its limits, what the agent did, what the verifier established (and under which semantics), when a human ratified, and what changed after.

**Ratification** — retrospective human authorization of intent for work produced under a grant, with the code + verifier evidence present. Signed with the phone key; references the verifier attestation hash.

**Rejected** — a delegated result a human reviewed and did not accept; preserved as first-class history.

**Roster** — the append-only, owner-signed log of trusted signers and their public keys.

**Spec** — the structured behavioral promises above a Cell's code (`unit`, `intent`, `in`, `out`, `pure`, `ensures`, `renders`, …). What the human authorizes and the verifier checks.

**specHash** — `sha256(normalized spec block)`; what the seal signs and what the archive is keyed by.

**Reverification** — a new immutable assessment of a *preserved historical state* under today's verifier, appended beside the original (never rewriting it). `yay reverify --all` produces the keyless **upgrade report**; `--attest` mints the signed records. See **Reverification posture**.

**Reverification posture** — the project-level grandfathering control (`yay reverify posture off|guarded|strict`): off grandfathers history, guarded warns at `yay verify`, strict blocks the gate until preserved history is re-verified under the current capability. Gates on whether the signed record **exists**, never on holding a key.

**Standard (provenance)** — default mode: specs + attestations archived; code by git reference. Cf. **Durable**.

**Superseded** — an approval/state replaced by a later ratified one; kept in history.

**TOCTOU** — Time-Of-Check to Time-Of-Use: the bug where the thing signed differs from the thing reviewed. Prevented by the reviewed-bundle hash.

**Tombstone** — a record that a stored object was deliberately removed (`hash + status + when + reason`), preserving the chain while honoring content deletion.

**Triad** — Human / Agent / Machine verifier.

**Two chains** — human authorization chain vs. implementation verification chain.

**Verification axis** — the machine-trust dimension (Red / Yellow / Green). Orthogonal to the authority axis.

**Verifier** — the deterministic, **non-AI** system that evaluates code against specs. Versioned, cryptographically identifiable, its results signed by the verifier key.

**Verifier capability version** — what a given verifier release can detect/prove; grows over releases (PATCH/MINOR/MAJOR) and gates which envelope constraints are enforceable.
