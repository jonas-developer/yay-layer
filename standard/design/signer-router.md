# Design note — Signer-inbox router (address a request to a person)

Status: **proposal, for review** · Relates to Standard §9 (Integrity & approval), §11 (Teams) · Builds on the per-machine relay channel and the signer-gate.

## Problem

Today a request routes by **machine**: `yay sign` posts to *this machine's* relay channel, which is *this person's* phone. That's right for "sign your own work" — Lisa on Lisa's machine → Lisa's phone; Sara on Sara's machine → Sara's phone (they're on separate channels and never collide).

What it can't do is **address a request to a specific other person**. When Lisa (or the AI on her machine) needs **Sara** to sign — e.g. company policy: *"Sara signs security-related Cells"* — there's no way to deliver it to Sara's phone. Best case today, it lands on Lisa's phone and the signer-gate says *"this is for Sara, not you"* and blocks — correct, but it never reaches Sara.

## Goal

`yay sign --name "Sara"` (from anywhere) makes the request appear **only on Sara's phone**. Nothing pops on the sender's phone. Multiple requests to Sara **queue** instead of taking over. Stays end-to-end encrypted; the relay stays blind; signatures still verify against the roster exactly as now.

## Non-goals

- Not changing the seal, the roster format's trust semantics, or how `yay verify` establishes trust.
- Not requiring a persistent server. Delivery is via the existing content-agnostic relay (short-poll), like signing today.
- Not multi-sig (M-of-N). This is *addressing* (who receives a request), not *threshold* (how many must sign). Multi-sig can build on top later.

## Addressing: derive an inbox from the signer's public key

Every signer's public key is already in the roster (public), so anyone can address them:

- **Inbox channel** = `hash("yay-inbox:v1:" + signPub)` — deterministic, public. Anyone can compute Sara's inbox from her roster pubkey; only Sara can *read* it (below).
- **Sealed to the recipient.** A request for Sara is encrypted with an **anonymous sealed box (X25519)** to Sara's **box key**, so only Sara's phone can open it. The relay only ever sees ciphertext.

### Two keys per signer, both from the 24 words

A signer's device derives two keys from the same BIP-39 seed:
- **Ed25519 signing key** (today) — signs approvals; roster stores its pubkey.
- **X25519 box key** (new) — receives sealed requests; derived via a domain-separated hash of the same seed (`X25519seed = SHA-256("yay-box:v1" || seed)`), so it round-trips from the 24 words with no extra backup.

The roster/enrollment must therefore also record the signer's **box pubkey** alongside the signing pubkey. (Enrollment/invite/pair payloads gain one field: `boxPub`.)

## Flow

```
Lisa's machine                     relay (blind)                 Sara's phone (on duty)
  yay sign --name "Sara"
  seal(request → Sara.boxPub) ───▶  ch:inbox(Sara):req:<id>  ───▶ open with Sara's box key
                                                                   signer-gate: it's for Sara ✓
                                                                   approve → sign the approval
  read result for <id> ◀───── seal(signature → Lisa) ◀────────── seal(sig → sender.boxPub)
  (Lisa's phone: nothing)
```

- The sender includes a **reply address** (their own box pubkey) so Sara's phone can seal the signature back to just the sender.
- Sara's phone **queues** requests: `ch:inbox(Sara):req:<id>` entries, each with its own id and TTL. Sara sees "N requests waiting" and clears them one at a time; the sender polls their own `<id>`. No single-pending clobber — a new request for Sara never overwrites another.

## "On duty": Sara opens her inbox

Sara opens her **inbox page** (a relay URL carrying *only her public identity*, e.g. `relay.yaylayer.com/#inbox=<signPub>`). The page computes her inbox channel, polls it, and decrypts requests with the box key it unlocks from her on-device keystore (PIN). Her private keys never leave the phone and are never in the URL. She leaves it open to receive requests — the same "scan once, stay on the page" model as signing today.

She gets that URL from `yay inbox` (prints her inbox link + QR) or from the dashboard, once she's enrolled and paired.

## Relationship to the per-machine channel

Two clean options (decide in review):

- **(A) Additive:** keep the per-machine channel for the fast "sign my own work" path; use the inbox **only** when `--name` targets *someone other than this machine's signer*. Least disruption.
- **(B) Inbox-for-all:** every signer always receives on their inbox; `yay sign` (self) routes to your own inbox too. One model, slightly more setup (everyone stays "on duty").

Proposal: **(A)** first — it adds delegation without touching the common path — with (B) as a possible later simplification.

## Security invariants (must hold)

1. **Only the addressed signer can read it.** Sealed to their box pubkey; the relay and everyone else see ciphertext only.
2. **Only the addressed signer can satisfy it.** The approval names `signer: Sara`; the returned signature must verify against Sara's roster key (the signer-gate + the laptop check both enforce this) — so even a mis-delivered request can't be signed by the wrong person.
3. **Relay stays blind.** Content-agnostic ciphertext + timestamps, as today.
4. **No clobber.** Per-request ids + a queue; a new request never overwrites another (generalizes the anti-clobber fix already shipped).
5. **Reply is sealed to the sender only.** The signature comes back encrypted to the sender's box pubkey.
6. **Recoverable.** The box key derives from the same 24 words, so losing/restoring a phone behaves exactly like signing recovery.
7. **Addressing is public, authority is not.** Anyone can *send* Sara a request (it's just a proposal); nothing is trusted until Sara signs and the gate verifies. Spam is bounded by TTL + the fact that unsigned requests do nothing.

## New/changed surfaces

- **Relay:** per-request queue endpoints (`request`/`result`/`final` keyed by `inbox:req:<id>` instead of one pending per channel). Additive; the current single-pending path stays for pair/self-sign under option (A).
- **Keys:** derive + store an X25519 box key from the seed (recovery.js); record `boxPub` at enroll/invite/pair.
- **CLI:** `yay sign --name X` routes to X's inbox (sealed) when X isn't the local signer; `yay inbox` prints the on-duty link.
- **Phone:** an inbox mode (poll the inbox, decrypt, queue, approve) — reuses the existing approve/gate UI.

## Open questions (for review)

1. **(A) additive vs (B) inbox-for-all** — proposal (A).
2. **Queue depth / spam bound** — cap pending requests per inbox (e.g. 20) + short TTL? Proposal: yes.
3. **Must the sender be a roster member to address someone?** Proposal: yes — only enrolled signers can post to an inbox (a signed/authenticated post), so randoms can't spam an inbox.
4. **Does `yay sign --name "Sara"` block waiting for Sara**, or fire-and-return (Sara signs later, the sender polls / picks it up)? Proposal: return a pending id; the sender can wait or check back.
5. **`boxPub` rollout** — new enrollments capture it; existing signers add it on next `yay pair`. OK?

## Doc hygiene

If accepted, add a short §12-bis (Routing) to STANDARD.md, and note the two-key (sign + box) derivation in §9.
