# 08 — Teams, roles & recovery

Everything here is ✅ **Shipped** today. This is the foundational trust layer the rest of YayLayer stands on: *who* may sign, how they're added and removed, and how you recover when a key is lost.

## Two roles: signer and owner

A project's trust is a set of enrolled identities, each holding one or more public keys, each with a **role**:

| Role | Can sign Briefs/specs | Can enroll / revoke signers | Can issue Autopilot grants | Can sign policy into effect | Can re-root |
|------|:---:|:---:|:---:|:---:|:---:|
| **Signer** | ✅ | — | — | — | — |
| **Owner** | ✅ | ✅ | ✅ | ✅ | ✅ |

- A **signer** can approve intent — sign specs + Briefs, and ratify delegated work. That's it.
- An **owner** can do everything a signer can, **plus** govern the project: add/remove other signers, issue [Autopilot](03-autopilot-delegated-execution.md) grants, sign the [signing policy](05-how-to.md#set-signing-policy) into effect, and recover the trust root.

The very first identity (created at `yay init` / `yay keygen` / first `yay pair`) is the **genesis owner**. Governance actions are **owner-signed** — so only a human owner can change who is trusted, and the AI never can.

## The roster — how "who may sign" is decided

The set of trusted identities is not a config file you can edit freely; it's an **append-only, owner-signed event log** (`.yaylayer/` roster, `prev`-chained ed25519 events):

```
genesis (owner)  →  enroll Bob (signer)  →  enroll Cleo (owner)  →  revoke Bob …
```

- Each event is signed by a current **owner**, and references the previous event's hash — so the roster is tamper-evident and its history is auditable.
- `yay verify` derives the current roster (identities → keys → roles) from this log, and checks every seal against it.
- The **trust root** is pinned in CI, so nobody can swap in a different roster or root and have the gate accept it. Change the roster or the root and the gate fails until CI is repointed. (This is why enrollment can't be forged: a valid roster event needs an owner's signature, and the root is pinned outside the AI's reach.)

Past approvals stay **attributed** to whoever signed them even after that person is revoked — revocation stops *future* signing, it never rewrites history.

## Adding a teammate

Two ways, both ending in an **owner-signed** roster event:

- **`yay invite "Bob"`** — the easy path. Mints a **30-minute, one-time link**. Bob opens it, his device generates his key (private key never leaves it), and *you* get an approval on your phone — you verify a **6-digit code** matches and tap Approve. No public key to copy by hand. Needs a running `yay dashboard`.
  - `--role owner|signer` — the role Bob gets on approval (default **signer**).
- **`yay enroll --name Bob --pubkey <b64>`** — the direct path when you already have Bob's public key. Writes the owner-signed roster event.
  - `--role owner|signer` (default signer) · `--by <owner>` (which owner authorizes it) · `--phone` (authorize on an owner's phone — no local key needed).

Grant **owner** only to people who should be able to govern the project (enroll/revoke/grant/policy/re-root). Most teammates are **signers**.

## Removing a key or identity

**`yay revoke --name X`** — an owner-signed revocation for a compromised or rotated key, or a whole identity.
- `--pubkey <b64>` — revoke just that one key (leave the identity, e.g. after a key rotation); omit to remove the whole identity.
- `--phone` — authorize on an owner's phone.
- **Guard:** revocation **refuses if it would leave the project with no owner** — you can never lock everyone out. Past approvals stay attributed.

## Working across a team — signer routing

You don't have to be at the same machine as the person who must sign:

- **`yay sign --name "<teammate>"`** — routes the approval to that teammate's **inbox** over the relay (fire-and-return; it returns a request id). They approve on their own phone.
- **`yay sign --check [id]`** — later, collect the routed signature and write the seal.

So "Lisa must sign the security Cells" (a [policy](05-how-to.md#set-signing-policy) rule) works even if Lisa is elsewhere: the request lands in her inbox, she signs, you collect.

## Signing methods

Chosen at `yay init` (per project), each identity's key can live in one of three places:

| Method | Where the key lives | Transport | Best for |
|--------|--------------------|-----------|----------|
| **Local** | An encrypted keystore on this machine (`*.keystore`, gitignored) | none | solo / CI-less local work; a passphrase unlocks it per sign |
| **Mobile · LAN** | Your **phone** (key held on-device, PIN-encrypted) | phone ⇄ laptop directly over your Wi-Fi | private, no server; you're on the same network |
| **Mobile · Relay** | Your **phone** | via **`relay.yaylayer.com`**, end-to-end encrypted | signing off your LAN; the relay never sees your code |

The first `yay pair` with no roster yet makes the **phone itself the trust root** (phone-as-genesis) — no local key is ever needed. The AI's machine only ever holds **public** keys; the private key never touches it (see [07 — Security](07-security-model.md#phone-signing--why-the-key-lives-on-the-phone)).

## Recovery

- **Lost the phone, still have your 24 words** — every mobile key is backed by a **24-word mnemonic** shown at pairing. Restore the key onto a new phone from the phrase and carry on; nothing on the laptop changes.
- **Lost the phone *and* the words** — you can no longer sign *as that identity*. An **owner** enrolls a fresh key for you (`yay enroll` / `yay invite`) — a normal roster event. Your past approvals stay attributed; you just sign new work with the new key.
- **Lost or compromised the *root* key** — **`yay reroot`** retires the current trust root and establishes a new one. This is a deliberate **trust discontinuity**: after it you re-sign specs under the new root and repoint the CI pin. Flags: `--phone` (root the new key on your phone), `--name <you>` (new local owner), `--force` (skip the confirm).

## Related

- The keys/roster commands in full: [06 — CLI reference](06-cli-reference.md#setup--identity).
- Why the phone key can't be forged, and the pinned trust root: [07 — Security model](07-security-model.md).
- Who-must-sign rules (policy) that build on roles: [05 — How-to](05-how-to.md#set-signing-policy).
