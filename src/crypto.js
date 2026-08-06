'use strict';
// YayLayer crypto core — ed25519 signatures + passphrase-encrypted keystore.
// Zero dependencies: everything here is Node's built-in `crypto`.
//
// Design (see standard/STANDARD.md, §Integrity):
//  - A SEAL is a signature over the canonical bytes of an approval object.
//  - The private key never leaves its owner; only the base64 SPKI public key
//    travels (into .yaylayer/config.json's roster).
//  - At-rest the private key is encrypted with a scrypt-derived AES-256-GCM key.
//    (The production path signs on a phone enclave; this local keystore is the
//    MVP stand-in so the whole loop runs today. See README "MVP vs roadmap".)

const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    pubB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privDer: privateKey.export({ type: 'pkcs8', format: 'der' }), // Buffer
  };
}

function encryptKeystore(privDer, passphrase) {
  if (!passphrase) throw new Error('a passphrase is required to encrypt the key');
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(passphrase, salt, SCRYPT.keylen, SCRYPT);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(privDer), cipher.final()]);
  return {
    v: 1,
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
}

function decryptKeystore(ks, passphrase) {
  const salt = Buffer.from(ks.salt, 'base64');
  const key = crypto.scryptSync(passphrase, salt, SCRYPT.keylen, SCRYPT);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ks.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(ks.tag, 'base64'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ks.ct, 'base64')), decipher.final()]);
  } catch (_) {
    throw new Error('wrong passphrase, or the keystore is corrupt');
  }
}

function sign(message, privDer) {
  const key = crypto.createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(message), key).toString('base64');
}

function verify(message, sigB64, pubB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(sigB64, 'base64'));
  } catch (_) {
    return false;
  }
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

function randomNonce() {
  return crypto.randomBytes(12).toString('hex');
}

module.exports = {
  generateKeypair, encryptKeystore, decryptKeystore, sign, verify, sha256, randomNonce,
};
