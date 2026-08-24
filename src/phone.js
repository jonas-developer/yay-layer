'use strict';
// Phone signing over the local network — the key lives only on the phone, the
// laptop only ASKS. No third-party server: the laptop runs a tiny LAN HTTP
// endpoint, the phone (same Wi-Fi) opens it, reviews the promises in plain
// language, and signs with its own key. The laptop verifies the signature
// against the enrolled public key and writes the seal.
//
// Wire format matches src/crypto.js exactly: public key = base64 SPKI-DER,
// signature = base64 raw ed25519 over canonical(approval). The phone's WebCrypto
// Ed25519 emits the same encodings, so it interoperates with `yay verify`.

const http = require('http');
const os = require('os');
const C = require('./crypto');
const { canonical } = require('./util');
const { signerHTML } = require('./signer-page');

function lanIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return '127.0.0.1';
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  res.end(body);
}
function sendHTML(res, html) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
}

// Short human-verifiable code bound to the phone's public key (MITM guard):
// if a different device pairs, its code won't match what the user's phone shows.
function confirmCode(pubB64) {
  return String(parseInt(C.sha256('yay-pair:' + pubB64).slice(0, 8), 16) % 1000000).padStart(6, '0');
}

// Serve a session until `done` resolves (the phone completed the action).
// Returns { url, port, done: Promise, close() }.
function serve(mode, project, sessionData, onPost, opts) {
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const html = signerHTML({ mode, project });

  const handler = async (req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'OPTIONS') return sendJSON(res, 200, {});
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) return sendHTML(res, html);
    if (req.method === 'GET' && url === '/api/session') return sendJSON(res, 200, { mode, project, ...sessionData });
    if (req.method === 'POST' && url === '/api/submit') {
      const body = await readBody(req);
      const result = onPost(body);
      if (result && result.error) return sendJSON(res, 400, { error: result.error });
      sendJSON(res, 200, result || { ok: true });
      if (result && result.done) resolveDone(result.done);
      return;
    }
    sendJSON(res, 404, { error: 'not found' });
  };
  // Pure-JS signer works over plain http; opt-in TLS (self-signed) encrypts transport.
  const tls = opts && opts.tls;
  const server = tls ? require('https').createServer({ key: tls.key, cert: tls.cert }, handler) : http.createServer(handler);
  const scheme = tls ? 'https' : 'http';

  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => {
      const port = server.address().port;
      resolve({ url: `${scheme}://${lanIP()}:${port}`, local: `${scheme}://localhost:${port}`, port, done, close: () => server.close() });
    });
  });
}

// Pairing: the phone creates its key and proves possession by signing our
// challenge; we return its name + public key + the confirm code for the human.
async function pairOverLan({ project, tls }) {
  const challenge = C.randomNonce() + C.randomNonce();
  const s = await serve('pair', project, { challenge }, (body) => {
    const { name, pubB64, proof } = body || {};
    if (!name || !pubB64 || !proof) return { error: 'missing name/pubB64/proof' };
    if (!C.verify(challenge, proof, pubB64)) return { error: 'key possession proof failed' };
    const code = confirmCode(pubB64);
    return { ok: true, code, done: { name: String(name), pubB64, code } };
  }, { tls });
  return s; // { url, port, done, close }
}

// Signing: hand the phone the unsigned approval + a plain-language summary; it
// signs canonical(approval) and posts the signature, which we verify.
async function signOverLan({ project, approval, summary, expectPubB64, tls }) {
  const canon = canonical(approval);
  const pubs = Array.isArray(expectPubB64) ? expectPubB64 : [expectPubB64]; // identity may hold several keys
  const s = await serve('approve', project, { approval, summary }, (body) => {
    const { signature } = body || {};
    if (!signature) return { error: 'missing signature' };
    if (!pubs.some((pub) => C.verify(canon, signature, pub))) return { error: 'signature did not verify against any enrolled key' };
    return { ok: true, done: { signature } };
  }, { tls });
  return s;
}

module.exports = { pairOverLan, signOverLan, lanIP, confirmCode };
