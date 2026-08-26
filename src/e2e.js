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

module.exports = { newKey, newChannel, b64url, fromB64url, seal, open };
