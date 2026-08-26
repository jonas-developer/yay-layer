# Design note — Invite & one-tap teammate enrollment

Status: **v1 built (same-network / phone-signing owner)** · Relates to Standard §9 (Integrity & approval), §11 (Teams)

**Implemented:** `yay invite` + dashboard invite endpoints (`/api/invite/create|join|status|info`, `/join` page) + a `join` mode on the signer page + the `enroll` dashboard dep (spawns the normal owner-signed `yay enroll --phone`) + the 6-digit confirm code on the owner's approval card. 8 integration tests cover mint → info → join (real keypair + proof) → confirm code → enroll trigger → status, plus one-time reuse, bad-proof, and unknown-token guards.
**Follow-ups (not yet built):** (a) **remote member join over the relay** — v1 has the member open the dashboard's LAN URL, so it covers same-network teams; a remote teammate needs the relay message-type bridge. (b) **local-signing owner via the panel** — the approval routes to the owner's phone (`yay enroll --phone`); a passphrase-in-panel path for local-only owners is still to wire.

## Problem

Adding a teammate today is a manual, two-machine dance:

1. The new member creates a key and reads its **public key** off their screen.
2. They send that pubkey to an owner (chat, email…).
3. The owner types `yay enroll --name "Bob" --pubkey <base64> [--phone]` and approves.

Steps 1–2 are pure friction — copy-pasting a base64 blob between people — and they're the *only* manual part left, because `yay enroll --phone` already routes the approval to the owner's phone via `authorizeRosterEvent`.

## Goal

Make enrollment feel **exactly like approving a `yay sign` request**: the member's request appears in the owner's existing approval surface, the owner taps once, done. No copied pubkeys, no typed command.

- **Phone signing (relay/LAN):** pops up on the owner's linked phone.
- **Local signing:** appears in the owner's dashboard **panel** (where `Sign changes` output shows), approved with the passphrase.

## Non-goals

- **Not** auto-approve. Enrollment stays an explicit, owner-**signed** action. "Automatic" means *no manual steps*, never *no human*.
- Not changing the roster format, the seal, or how verification derives trust. This only changes how an `add-signer` event is *initiated and routed for approval*.

## Flow (owner-initiated invite)

```
Owner                         Channel (relay or LAN dashboard)         New member (Bob)
  │  yay invite "Bob"  ───────────────▶  create invite {token, ch, role, exp}
  │  share link/QR  ──────────────────────────────────────────────▶  open link
  │                                                                    make key on phone
  │                              ◀── POST join {name, pubkey, code} ── show 6-digit code
  │  dashboard queues pending-enroll
  │  ▲ pops on phone / panel:
  │    "Add Bob as signer?  key 9f2c·41ab  code 472916"
  │  (owner checks code with Bob, taps Approve)
  │  owner key signs add-signer event ─▶ roster.json updated ───────▶  Bob can now sign
```

**Owner-initiated** (owner runs `yay invite`) rather than open self-request, so only people the owner handed a link to can even reach the queue.

## Approval screen contents

The pending-enroll card shows, for the owner to verify before approving:

- **Name** the member chose (editable by the owner before signing).
- **Key fingerprint** (short, e.g. `9f2c·41ab·77de`).
- **Role** being granted (`signer` default; `owner` shows an extra warning — "can enroll/revoke others").
- **6-digit confirm code** — the same code Bob sees on his screen. The owner confirms out-of-band (says it aloud / on a call) that they match. This binds the pubkey to the *right human* and defeats a man-in-the-middle swapping in their own key.

## What's reused vs new

**Reused (no change to trust core):**
- `authorizeRosterEvent` / `add-signer` event construction and validation (`src/roster.js`, `bin/yay.js`).
- The dashboard's single-pending-request + phone-poll + submit pattern (`src/dashboard.js`).
- The roster's owner-signed, append-only, `prev`-chained, nonce'd invariants (§9).

**New:**
- `yay invite "<name>" [--role signer|owner] [--expires 30m]` — mints an invite (channel id + one-time token + optional role/expiry) and prints a link/QR. Relay mode → `relay.yaylayer.com/#…`; LAN mode → the dashboard's `/join?token=…`.
- A **member "join" page** (variant of the signer page): generates a key, shows the 6-digit code, POSTs `{name, pubkey, code, token}`.
- A dashboard **pending-enroll** slot parallel to pending-sign, with endpoints: `POST /api/enroll/join` (member submits), owner-side poll, `POST /api/enroll/approve` (localhost-gated) → runs the phone/local authorize → writes roster.
- A relay **message type** for the join payload (relay mode) — still opaque ciphertext to the relay; the invite `#fragment` carries the E2E key, exactly like the signing channel, so the relay never sees the pubkey or name in the clear.
- Owner phone signer: an **enroll-approval screen** (name + fingerprint + code + Approve/Reject).

## Security invariants (must hold)

1. **Owner-signed only.** The roster only changes via an event signed by an existing **owner** key; the resulting roster must still validate (`deriveRoster` problems ⇒ refuse). Same as today.
2. **Explicit human approval.** No silent enrollment — the owner taps Approve on phone or enters the passphrase in the panel.
3. **Identity binding.** The 6-digit code (shown to both) must be confirmed by the owner before signing, so a MITM can't substitute their own pubkey.
4. **Invite is bounded.** One-time token, short expiry, single use; a used/expired invite is rejected. An owner can cancel a pending invite.
5. **Relay stays blind.** In relay mode the name+pubkey travel E2E-encrypted (key in the URL fragment); the relay only shuttles ciphertext + timestamps (§9).
6. **No owner online ⇒ no enrollment.** If no owner approves, nothing is written. The request simply sits pending (or expires). Fails closed.
7. **Replay-safe.** Per-request nonce + `prev` chain, as with every governance event.
8. **Role escalation is loud.** Granting `owner` requires the extra confirmation; you can't quietly mint an owner.

## Edge cases

- **Owner is offline / not running the dashboard:** the join request has nowhere to land → member sees "waiting for an owner to approve"; falls back to the current manual `yay enroll` path (print the command). Fails closed.
- **Code mismatch:** owner rejects; nothing written.
- **Duplicate name:** if the name already exists, this becomes an `add-key` for that identity (same as `enroll` today) — surface that on the card.
- **Two owners both approve:** first signed event wins; the second no-ops (key already present).
- **Invite leaked:** bounded by expiry + one-time token + the owner still having to approve with the code.

## CLI / UX surface

- `yay invite "Bob"` → link/QR + "share this; approve on your phone when Bob opens it."
- Dashboard: an **"Invite teammate"** button that does the same and shows pending invites.
- Owner approves in the same place they approve signs. Member needs zero CLI — just opens a link on their phone.

## Decisions (locked in review, 2026-08-26)

1. **Owner-initiated only** for v1 — no open self-request. Only someone handed an invite link can reach the queue.
2. **Invite expiry: 30 minutes, one-time.** A used or expired invite is rejected; an owner can cancel a pending invite.
3. **Tap-only authorization.** `yay invite` just mints a rendezvous (channel + one-time token + role); the *authorization* is the owner's tap at approval time. No pre-signature.
4. **Ship straight in** (no experimental flag). It's opt-in by nature (nothing happens unless an owner runs `yay invite`), doesn't touch the existing `yay enroll` path, and every action still needs an owner's tap — a flag would add ceremony for no safety gain.

## Who can add members (roles)

The role is chosen per-invite and decides whether the new member can, in turn, manage the roster:

- **signer** (default) — can sign Cells, **cannot** enroll/revoke anyone. Roster management is owner-only.
- **owner** — **can** invite/enroll and revoke others, same powers as the inviter. Granting `owner` shows an extra warning on the approval card and requires the owner to confirm.

There is no privileged single "founder": the trust root is simply the *first* owner. Owners can promote others to owner; governance only refuses to leave **zero** owners (lockout guard, already enforced in `yay revoke`).

## Doc hygiene note

Standard §11 (Teams) and §12 (Language reach) are now behind the reference impl — §11 still says roster/roles are "roadmap" (roster + enroll/revoke are built), and §12 lists Python/Rust/Solidity as deferred though they now run signed-only. Worth refreshing alongside this.
