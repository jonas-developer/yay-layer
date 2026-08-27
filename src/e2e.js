'use strict';
// End-to-end encryption for the hosted relay path — TweetNaCl secretbox
// (XSalsa20-Poly1305), byte-for-byte compatible with the phone page's nacl.secretbox.
// The laptop and phone share a 32-byte key carried in the QR URL #fragment (never sent
// to the relay), so the relay only ever stores/forwards opaque {n,c} ciphertext.
const nacl = require('./vendor/tweetnacl.min.js');

const b64 = (u) => Buffer.from(u).toString('base64');
function b64url(u) { return b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function fromB64url(s) { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return new Uint8Array(Buffer.from(s, 'base64')); }

function newKey() { return nacl.randomBytes(32); }            // Uint8Array(32)
function newChannel() { return b64url(nacl.randomBytes(18)); } // 24 url-safe chars (matches the relay's channel regex)

// seal(key, obj) → { n, c } base64 (nonce, ciphertext+tag). open() returns the object or null.
function seal(key, obj) {
  const n = nacl.randomBytes(24);
  const c = nacl.secretbox(Buffer.from(JSON.stringify(obj), 'utf8'), n, key);
  return { n: b64(n), c: b64(c) };
}
function open(key, blob) {
  try {
    const m = nacl.secretbox.open(new Uint8Array(Buffer.from(blob.c, 'base64')), new Uint8Array(Buffer.from(blob.n, 'base64')), key);
    return m ? JSON.parse(Buffer.from(m).toString('utf8')) : null;
  } catch (_) { return null; }
}

// ── Sealed box: encrypt to a signer's EXISTING ed25519 key, converted to X25519
// (the standard birational map, as libsodium sealed boxes / age / Signal do). Lets us
// address a request so ONLY the recipient can read it — no extra key, no roster change.
const ll = nacl.lowlevel;
const gf1 = ll.gf([1]);
const u8 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
// bytes → field element (little-endian, top bit cleared)
function unpack25519(o, n) { for (let i = 0; i < 16; i++) o[i] = n[2 * i] + (n[2 * i + 1] << 8); o[15] &= 0x7fff; }
// modular inverse mod 2^255-19, by exponentiation to p-2 (tweetnacl's ladder)
function inv25519(o, i) { const c = ll.gf(); let a; for (a = 0; a < 16; a++) c[a] = i[a]; for (a = 253; a >= 0; a--) { ll.S(c, c); if (a !== 2 && a !== 4) ll.M(c, c, i); } for (a = 0; a < 16; a++) o[a] = c[a]; }
// ed25519 public key (raw 32) → X25519 public key: u = (1+y)/(1-y) mod p
function edPubToX(edPub32) { const y = ll.gf(), a = ll.gf(), b = ll.gf(), z = new Uint8Array(32); unpack25519(y, edPub32); ll.A(a, gf1, y); ll.Z(b, gf1, y); inv25519(b, b); ll.M(a, a, b); ll.pack25519(z, a); return z; }
// ed25519 secret key (64 = seed||pub) → X25519 secret: clamp(SHA-512(seed)[0..32])
function edSecToX(edSec64) { const h = nacl.hash(edSec64.subarray(0, 32)); const s = h.slice(0, 32); s[0] &= 248; s[31] &= 127; s[31] |= 64; return s; }
// Roster pubs are stored as SPKI (12-byte header + 32-byte key); take the raw key.
function edPubRaw(spkiB64) { const uu = u8(spkiB64); return uu.length === 32 ? uu : uu.subarray(uu.length - 32); }

// Each signer's INBOX channel is a deterministic hash of their (SPKI) public key —
// public, so anyone can address them; only they can decrypt (below).
function inboxChannel(pubB64) { return b64url(nacl.hash(Buffer.from('yay-inbox:v1:' + pubB64, 'utf8')).subarray(0, 18)); }

// Seal `obj` so ONLY the holder of `pubB64`'s key can open it (anonymous sealed box:
// an ephemeral X25519 keypair does a box to the recipient's converted pubkey).
function sealTo(pubB64, obj) {
  const xpub = edPubToX(edPubRaw(pubB64));
  const eph = nacl.box.keyPair();
  const n = nacl.randomBytes(24);
  const c = nacl.box(Buffer.from(JSON.stringify(obj), 'utf8'), n, xpub, eph.secretKey);
  return { epk: b64(eph.publicKey), n: b64(n), c: b64(c) };
}
// Open a sealed box with the recipient's ed25519 SECRET (64 bytes). Returns obj or null.
function openSealed(secB64, sealed) {
  try {
    const xsec = edSecToX(u8(secB64));
    const m = nacl.box.open(u8(sealed.c), u8(sealed.n), u8(sealed.epk), xsec);
    return m ? JSON.parse(Buffer.from(m).toString('utf8')) : null;
  } catch (_) { return null; }
}

module.exports = { newKey, newChannel, b64url, fromB64url, seal, open, inboxChannel, sealTo, openSealed, edPubToX, edSecToX };
