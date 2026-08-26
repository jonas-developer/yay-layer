# Design note — Signer-inbox router (address a request to a person)

Status: **approved — building (convergent additive)** · Relates to Standard §9 (Integrity & approval), §11 (Teams) · Builds on the per-machine relay channel and the signer-gate.

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

### One identity key, converted for encryption (DECIDED — Option B)

We do **not** add a second key. A request is sealed to the recipient's **existing Ed25519 signing key, converted to X25519** via the standard birational Ed25519↔X25519 map (as libsodium sealed boxes / `age` / Signal do). The conversion is public and deterministic, so **anyone can derive Sara's X25519 pubkey from her roster signing pubkey** — no `boxPub` field, no roster change, and **existing signers are addressable immediately** (no re-pair). On the phone, the matching X25519 secret is derived from the same Ed25519 secret (already unlocked from the 24 words).

Security note: reusing the Curve25519 identity for both signing and encryption is safe for our flow — the human taps every signature (no blind signing oracle) and DH results are never returned to a sender (no DH oracle), so the theoretical cross-use conditions don't arise; and every key already shares one seed/phone/PIN, so separate derivation would add negligible real isolation. Strict key-separation (a distinct derived box key + a roster `boxPub`) remains a possible future hardening if ever wanted.

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

## Relationship to the per-machine channel — convergent additive (DECIDED)

The inbox is the **general mechanism**; **self-sign is a fast-path over it** (an inbox addressed to yourself). So there aren't two separate systems:
- `yay sign` (self, no `--name` or `--name` = this machine's signer) → the existing per-machine channel → your own phone, **blocking**, exactly as today.
- `yay sign --name "Sara"` (someone else) → **Sara's inbox** → Sara's phone, **fire-and-return**.

The queue/anti-clobber/reply-sealing live in **one** inbox engine that both paths share, so features and fixes apply everywhere. This keeps risk low now (the working self-path is untouched) and lets us later drop the fast-path to reach full inbox-for-all **without a rewrite** — nothing here is throwaway.

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

## Decisions (locked 2026-08-27)

1. **Convergent additive** — the inbox is the base engine; self-sign is a fast-path over it (see above). Not two separate systems; can converge to inbox-for-all later without a rewrite.
2. **Cap the queue** — a bounded number of pending requests per inbox (e.g. 20) + short TTL, so an inbox can't be flooded.
3. **Enrolled signers only** — a request may be posted to an inbox only by an authenticated roster member; randoms can't spam an inbox.
4. **Fire-and-return for cross-signer** — `yay sign --name "Sara"` drops the request in Sara's inbox and returns a **request id** immediately (the sender keeps working; the Cells stay Unsigned and gate-blocked until Sara signs, then complete out-of-band). **Self-sign stays blocking** (you're at your own phone).
5. **No extra key (Option B)** — encryption uses the recipient's existing Ed25519 roster key, converted to X25519 (standard birational map). No `boxPub` field, no rollout: **every existing signer is addressable immediately**, and recovery is unchanged (same 24 words).

## Constitution (AI harness) — delegation guidance

`yay constitution` output (CLAUDE.md, AGENTS.md, …) gains a **delegation** section so the AI knows to:
- address the right person when policy assigns a Cell to a specific signer (e.g. "security-related Cells → Sara");
- treat `yay sign --name "X"` as **fire-and-return** — do **not** block, do **not** report the change as done/approved;
- tell the human plainly: *"these Cells are pending X's signature — they stay Unsigned and the gate blocks them until X signs"*, and continue with other work.

## Doc hygiene

Add a short §12-bis (Routing) to STANDARD.md, and note the two-key (sign + box) derivation in §9.

## Build order

1. **Crypto foundation** — Ed25519↔X25519 conversion + anonymous sealed-box (seal to a signing pubkey / open with the signing secret) on both sides (node `e2e.js` + browser `recovery.js`); inbox-channel = `hash("yay-inbox:v1:"+signPub)`. Tests: seal(node)→open(phone) round-trip, and that it round-trips from the 24 words.
2. **Relay** — per-request queue endpoints keyed by inbox + request id (additive to the current single-pending path); bounded depth + TTL.
3. **CLI** — `yay sign --name "<other>"` seals to their inbox + returns an id; `yay sign --check <id>`; `yay inbox` prints the on-duty link.
4. **Phone** — inbox mode (poll, decrypt, queue, approve) reusing the approve/gate UI.
5. **Constitution + Standard** — the delegation guidance above.
