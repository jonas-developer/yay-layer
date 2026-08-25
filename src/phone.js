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
// Stable default port so the phone page keeps one origin (→ its saved key persists).
// 48757 is a deliberately uncommon high port, clear of the usual dev ports
// (React 3000, Vite 5173, Express 8080/3000, Rails 3000, webpack 4200/8000, …) so
// it rarely collides. YAY_PHONE_PORT overrides it; set it to 0 to force a random port.
const PHONE_PORT = (process.env.YAY_PHONE_PORT !== undefined && process.env.YAY_PHONE_PORT !== '')
  ? Number(process.env.YAY_PHONE_PORT) : 48757;
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
  // Final outcome the phone can poll after it submitted (pairing completes on the
  // laptop, so the phone learns success/failure via GET /api/status). `settled`
  // resolves once the phone has actually read that final status.
  let final = null, resolveSettled;
  const settled = new Promise((r) => { resolveSettled = r; });
  const html = signerHTML({ mode, project });
  // Auto-close if nobody completes it, so an abandoned server can't linger holding
  // the stable port (which would push the next sign onto a new origin → lost key).
  const timeoutMs = (opts && opts.timeoutMs) || Number(process.env.YAY_PHONE_TIMEOUT_MS) || 600000;
  let timer = null;

  const handler = async (req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'OPTIONS') return sendJSON(res, 200, {});
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) return sendHTML(res, html);
    if (req.method === 'GET' && url === '/api/session') return sendJSON(res, 200, { mode, project, ...sessionData });
    if (req.method === 'GET' && url === '/api/status') { if (final) resolveSettled(); return sendJSON(res, 200, { final }); }
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

  // Bind a STABLE port so the phone URL's origin (host:port) stays constant across
  // pair → sign sessions — otherwise localStorage (where the phone key lives) is
  // scoped to a different origin each run and the phone "forgets" its key. Prefer
  // PHONE_PORT, step through a few, and only fall back to a random port as a last
  // resort (in which case the phone may need to restore from its recovery phrase).
  return new Promise((resolve, reject) => {
    const mk = (port) => ({
      url: `${scheme}://${lanIP()}:${port}`, local: `${scheme}://localhost:${port}`, port, done, settled,
      // fellBack: we could not get the stable port → the phone address changed and
      // its saved key may be invisible (caller warns the user).
      fellBack: PHONE_PORT !== 0 && port !== PHONE_PORT,
      setFinal: (f) => { final = f; },
      close: () => { if (timer) clearTimeout(timer); server.close(); },
    });
    const bind = (port, triesLeft) => {
      const onErr = (e) => {
        if ((e.code === 'EADDRINUSE' || e.code === 'EACCES') && triesLeft > 0) bind(triesLeft === 1 ? 0 : port + 1, triesLeft - 1);
        else reject(e);
      };
      server.once('error', onErr);
      server.listen(port, '0.0.0.0', () => {
        server.removeListener('error', onErr);
        timer = setTimeout(() => { resolveDone({ timedOut: true }); try { server.close(); } catch (_) {} }, timeoutMs);
        if (timer.unref) timer.unref();
        resolve(mk(server.address().port));
      });
    };
    bind(PHONE_PORT, 6);
  });
}

// Pairing: the phone creates its key and proves possession by signing our
// challenge; we return its name + public key + the confirm code for the human.
//
// When `genesis` is supplied (no signed trust root exists yet), we run
// PHONE-AS-GENESIS: the phone self-signs the genesis roster event, so its
// signature IS the trust root. The laptop never holds a key. We rebuild the
// event authoritatively from our own fields + the phone's name/pub, so a
// tampered phone cannot smuggle a different role/nonce past us.
async function pairOverLan({ project, tls, genesis, challenge }) {
  challenge = challenge || (C.randomNonce() + C.randomNonce());
  const session = genesis ? { challenge, genesis } : { challenge };
  const s = await serve('pair', project, session, (body) => {
    const { name, pubB64, proof } = body || {};
    if (!name || !pubB64 || !proof) return { error: 'missing name/pubB64/proof' };
    if (genesis) {
      const ev = { ...genesis, name: String(name), pub: pubB64, by: String(name) };
      if (!C.verify(canonical(ev), proof, pubB64)) return { error: 'genesis self-signature failed' };
      const code = confirmCode(pubB64);
      return { ok: true, code, done: { name: String(name), pubB64, code, genesisEvent: { ...ev, signature: proof } } };
    }
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

// Roster authorization: an OWNER's phone signs a governance event (enroll / revoke
// / reroot) so a phone-only owner can manage the roster with no key on the laptop.
// The phone signs canonical(event) == eventBytes, verified against current owner keys.
async function authorizeOverLan({ project, event, summary, ownerPubs, tls }) {
  const canon = canonical(event);
  const pubs = Array.isArray(ownerPubs) ? ownerPubs : [ownerPubs];
  const s = await serve('authorize', project, { event, summary }, (body) => {
    const { signature } = body || {};
    if (!signature) return { error: 'missing signature' };
    if (!pubs.some((pub) => pub && C.verify(canon, signature, pub))) return { error: 'not signed by a current owner key on this phone' };
    return { ok: true, done: { signature } };
  }, { tls });
  return s;
}

module.exports = { pairOverLan, signOverLan, authorizeOverLan, lanIP, confirmCode };
