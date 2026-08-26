'use strict';
// `yay dashboard` — a persistent local control panel. Serves the map LIVE
// (auto-refresh + Refresh button) and hosts on-demand ACTIONS that a static map
// can't: run the project's test suite, and regenerate the System Plan (an LLM call,
// so never automatic). Mutating/executing actions are gated to localhost — anyone
// on the Wi-Fi can VIEW the map, but only this machine can run tests / spend LLM
// tokens. (v-next: route phone pair/sign through here too, for one origin.)

const http = require('http');
const os = require('os');
const crypto = require('crypto');
const C = require('./crypto');
const { canonical } = require('./util');
const { signerHTML } = require('./signer-page');

function confirmCode(pubB64) { return String(parseInt(C.sha256('yay-pair:' + pubB64).slice(0, 8), 16) % 1000000).padStart(6, '0'); }
function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 4e6) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } }); req.on('error', () => resolve({})); });
}

function lanIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) for (const i of ifaces[name] || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}
// This machine's OWN addresses — so an action triggered from the laptop is allowed
// whether it reached the dashboard via localhost OR the machine's own LAN IP, while
// a DIFFERENT device (the phone, a teammate's laptop) is still blocked.
const OWN = new Set(['127.0.0.1', '::1', 'localhost']);
try { const ifs = os.networkInterfaces(); for (const n of Object.keys(ifs)) for (const i of ifs[n] || []) if (i.address) OWN.add(i.address); } catch (_) {}
function isLocal(req) { const a = (req.socket.remoteAddress || '').replace(/^::ffff:/, ''); return OWN.has(a); }
function sendJSON(res, status, obj) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function sendHTML(res, html) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); }
// Serve the (public) CA certificate with the content-type that makes iOS/Android
// offer to install it as a trusted root. NEVER serve the CA private key.
function sendCert(res, pem, filename) {
  res.writeHead(200, { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="' + (filename || 'yaylayer-ca.crt') + '"', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  res.end(pem);
}
// A tiny self-contained page that hands the phone the certificate + the exact
// (non-obvious) trust steps for iOS and Android, so users get the cert from
// yay-layer itself instead of copying a file off the laptop.
function trustHTML() {
  return '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">'
    + '<title>Trust this dashboard</title>'
    + '<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;padding:24px;max-width:640px;color:#1a1a1a;background:#fff}'
    + 'h1{font-size:20px;margin:0 0 4px}.sub{color:#666;margin:0 0 20px}'
    + 'a.btn{display:block;text-align:center;background:#2f6f4f;color:#fff;text-decoration:none;padding:14px;border-radius:12px;font-weight:600;margin:16px 0}'
    + 'ol{padding-left:20px}li{margin:6px 0}h2{font-size:15px;margin:22px 0 6px}.note{color:#666;font-size:14px;margin-top:20px}code{background:#f0f0f0;padding:1px 5px;border-radius:5px}</style>'
    + '<h1>Trust this dashboard</h1>'
    + '<p class=sub>One-time setup so your phone shows a secure padlock (no warning) for signing.</p>'
    + '<a class=btn href="/ca.crt">⬇ Download the certificate</a>'
    + '<p class=note>Tap through any "not private" warning to download — you\'re about to make it trusted.</p>'
    + '<h2>iPhone / iPad</h2><ol>'
    + '<li>After the download, open <b>Settings</b> — you\'ll see <b>Profile Downloaded</b> near the top → tap <b>Install</b> (enter passcode).</li>'
    + '<li>Go to <b>Settings → General → About</b>, scroll to the very bottom → <b>Certificate Trust Settings</b>.</li>'
    + '<li>Turn <b>ON</b> the switch next to the <b>mkcert</b> entry (this step is separate — installing the profile alone is not enough).</li>'
    + '</ol>'
    + '<h2>Android</h2><ol>'
    + '<li>Open <b>Settings → Security</b> (or <b>Security &amp; privacy</b>) → <b>More settings / Encryption &amp; credentials</b>.</li>'
    + '<li>Tap <b>Install a certificate → CA certificate</b>, accept the warning, and pick the downloaded file.</li>'
    + '<li>Exact menu names vary by phone; search settings for <code>CA certificate</code> if needed.</li>'
    + '</ol>'
    + '<p class=note>Then reopen the signing page — it\'ll be a trusted <code>https</code> connection. Menu paths differ slightly by OS version.</p>';
}

// Inject the live controls (Refresh + Run tests + Regenerate plan) + a results panel
// + an auto-poller that reloads the page when the underlying state version changes.
function withLiveControls(mapHTML, version) {
  const bar = '<div id="yd-bar" style="position:fixed;right:14px;bottom:14px;z-index:99999;display:flex;gap:8px;align-items:center;font-family:ui-monospace,Menlo,monospace;font-size:12px">'
    + '<span id="yd-live" style="padding:5px 11px;border-radius:100px;background:#1f9d57;color:#fff;box-shadow:0 6px 20px -8px rgba(0,0,0,.4)">● live</span>'
    + '<button class="yd-btn yd-primary" id="yd-sign" title="Manually start a sign request. Normally your AI does this for you by running `yay sign --brief \\"…\\"` — it drafts the Brief and it appears on your phone to approve. Use this only to trigger a sign yourself.">✍ Sign changes</button>'
    + '<button class="yd-btn" id="yd-diffs">≷ Changes</button>'
    + '<button class="yd-btn" id="yd-tests">▶ Run tests</button>'
    + '<button class="yd-btn" id="yd-adv">⚔ Adversary</button>'
    + '<button class="yd-btn" id="yd-plan">⟲ System Plan</button>'
    + '<button class="yd-btn yd-primary" id="yd-refresh">⟳ Refresh</button></div>'
    + '<div id="yd-panel" style="display:none;position:fixed;left:14px;right:14px;bottom:60px;max-height:52vh;overflow:auto;z-index:99999;background:#0f1115;color:#e6e6e6;border:1px solid #2b2b2b;border-radius:12px;box-shadow:0 24px 60px -20px rgba(0,0,0,.6);font-family:ui-monospace,Menlo,monospace;font-size:12.5px">'
    + '<div id="yd-phead" style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #2b2b2b;position:sticky;top:0;background:#0f1115"><b id="yd-ptitle">Output</b><button class="yd-btn" id="yd-close" style="padding:3px 10px">✕ close</button></div>'
    + '<pre id="yd-pout" style="margin:0;padding:12px 14px;white-space:pre-wrap;word-break:break-word"></pre></div>'
    + '<style>.yd-btn{padding:6px 12px;border-radius:100px;border:1px solid #3ecf8e;background:transparent;color:#159a63;font-weight:700;cursor:pointer;font-family:inherit;font-size:12px;box-shadow:0 6px 20px -10px rgba(0,0,0,.4)}.yd-btn.yd-primary{background:#3ecf8e;color:#04231a;border-color:#3ecf8e}.yd-btn:active{filter:brightness(.93)}@media(max-width:600px){#yd-bar{left:8px;right:8px;bottom:8px;flex-wrap:wrap;justify-content:flex-end}#yd-panel{left:8px!important;right:8px!important}.yd-btn{padding:6px 10px;font-size:11px}}</style>';
  const js = '<script>(function(){var V=' + JSON.stringify(version) + ';'
    + 'var live=document.getElementById("yd-live"),panel=document.getElementById("yd-panel"),pout=document.getElementById("yd-pout"),ptitle=document.getElementById("yd-ptitle");'
    + 'function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(m){return m==="&"?"&amp;":m==="<"?"&lt;":"&gt;";});}'
    + 'function show(t,txt,cls){ptitle.textContent=t;pout.textContent=txt;pout.style.color=cls==="ok"?"#3fbf77":cls==="err"?"#ff6b6b":"#e6e6e6";panel.style.display="block";}'
    + 'document.getElementById("yd-close").onclick=function(){panel.style.display="none";};'
    + 'document.getElementById("yd-refresh").onclick=function(){location.reload();};'
    + 'document.getElementById("yd-diffs").onclick=async function(){ptitle.textContent="Spec changes since last commit";pout.style.color="#e6e6e6";pout.textContent="loading…";panel.style.display="block";try{var j=await fetch("/api/diffs").then(function(r){return r.json();});if(!j.diffs||!j.diffs.length){pout.textContent="No spec changes since the last commit (working tree matches HEAD).";return;}pout.innerHTML=j.diffs.map(function(c){var lines=c.diff.map(function(d){var col=d.t==="+"?"#3fbf77":d.t==="-"?"#ff6b6b":"#8a8a8a";var pre=d.t==="+"?"+ ":d.t==="-"?"- ":"  ";return "<div style=\\"color:"+col+"\\">"+esc(pre+d.text)+"</div>";}).join("");return "<div style=\\"margin:0 0 16px\\"><div style=\\"color:#e6e6e6;font-weight:700;margin-bottom:5px\\">"+esc(c.id+(c.unit?" · "+c.unit:"")+"   "+c.file)+"</div>"+lines+"</div>";}).join("");}catch(e){pout.textContent="Could not load diffs: "+e;}};'
    + 'document.getElementById("yd-adv").onclick=async function(){if(!confirm("Run the spec-only adversary? An LLM writes probes from the specs (never the code) and runs them — costs tokens."))return;show("Adversary","Writing probes from the specs and running them… (a few seconds)");try{var r=await fetch("/api/adversary/run",{method:"POST"});if(r.status===403){show("Adversary","Run this on THIS computer (localhost).","err");return;}var j=await r.json();if(j.error){show("Adversary","✗ "+j.error,"err");return;}var rows=(j.results||[]);var broke=rows.filter(function(x){return x.status==="broke";});var html=rows.map(function(x){var col=x.status==="broke"?"#ff6b6b":x.status==="survived"?"#3fbf77":"#c9860f";var msg=x.status==="broke"?("BROKE: "+x.counterexample):x.status==="survived"?"survived":(x.reason||x.status);return "<div style=\\"color:"+col+"\\">"+esc((x.status==="broke"?"✗ ":x.status==="survived"?"✓ ":"– ")+x.id+" "+(x.unit||"")+" — "+msg)+"</div>";}).join("")||"No eligible Cells (need a leaf unit with ensures/out/throws).";ptitle.textContent="Adversary — "+broke.length+" broke / "+rows.length+" probed";pout.style.color="#e6e6e6";pout.innerHTML=html;panel.style.display="block";}catch(e){show("Adversary","Could not run: "+e,"err");}};'
    + 'document.getElementById("yd-tests").onclick=async function(){show("Tests","Running the project test suite…");try{var r=await fetch("/api/tests/run",{method:"POST"});if(r.status===403){show("Tests","Run tests from the dashboard on THIS computer (localhost) — not from the phone.","err");return;}var j=await r.json();show("Tests "+(j.configured?(j.ok?"✓ passed":"✗ failed (exit "+j.code+")"):""),(j.cmd?("$ "+j.cmd+"\\n\\n"):"")+(j.output||""),j.configured?(j.ok?"ok":"err"):"");}catch(e){show("Tests","Could not run: "+e,"err");}};'
    + 'document.getElementById("yd-sign").onclick=async function(){var m=prompt("Signing manually.\\n\\nNormally your AI drafts the Brief (it runs `yay sign --brief \\"…\\"`) and it appears on your phone to approve — you don\'t type it here.\\n\\nSince you\'re starting a sign yourself, type the one-line Brief of what you\'re approving (you can still edit it on the phone):");if(m==null)return;m=String(m).trim();if(!m){show("Sign","A brief is required.","err");return;}show("Sign","Sent to your phone — review the brief there (you can edit it) and approve…");try{var r=await fetch("/api/sign/start",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({brief:m})});if(r.status===403){show("Sign","Start signing from the dashboard on THIS computer (localhost).","err");return;}if(r.status===409){show("Sign","A request is already awaiting the phone — approve or cancel that first.","err");return;}var j=await r.json();if(j.ok){show("Sign","✓ Signed. Reloading…","ok");setTimeout(function(){location.reload();},1000);}else{show("Sign","✗ "+(j.error||"failed"),"err");}}catch(e){show("Sign","Could not sign: "+e,"err");}};'
    + 'document.getElementById("yd-plan").onclick=async function(){if(!confirm("Regenerate the System Plan? This calls your LLM provider and costs tokens."))return;show("System Plan","Regenerating via your LLM provider… (a few seconds)");try{var r=await fetch("/api/plan/regen",{method:"POST"});if(r.status===403){show("System Plan","Regenerate from the dashboard on THIS computer (localhost).","err");return;}var j=await r.json();if(j.ok){show("System Plan","✓ Updated ("+j.provider+"/"+j.model+", "+j.subsystems+" subsystems). Reloading…","ok");setTimeout(function(){location.reload();},900);}else{show("System Plan","✗ "+(j.error||"failed"),"err");}}catch(e){show("System Plan","Could not regenerate: "+e,"err");}};'
    + 'async function poll(){try{var r=await fetch("/api/version",{cache:"no-store"});var j=await r.json();if(j.v&&j.v!==V){live.textContent="● updated — refreshing";live.style.background="#c9860f";setTimeout(function(){location.reload();},500);}}catch(_){live.textContent="● server stopped";live.style.background="#d92d20";}}'
    + 'setInterval(poll,3000);})();</script>';
  return mapHTML.indexOf('</body>') >= 0 ? mapHTML.replace('</body>', bar + js + '</body>') : mapHTML + bar + js;
}

// deps: { buildMapHTML():{html}, version():string, testInfo():{configured,cmd},
//         runTests():Promise<result>, regenPlan():Promise<{ok,...}> }
function startDashboard(deps, opts) {
  opts = opts || {};
  let lastTest = null;
  // ── relay: one pending request at a time; the CLI posts it, the phone (already
  // open at this one origin) picks it up and signs, the CLI reads the result. This
  // is what lets the human scan the QR ONCE and then approve everything from here.
  let pending = null;      // { mode, session, expectPubs, genesis, done, submitted, waiters:[], at }
  let finalStatus = null;  // outcome the phone shows after it submits (pair confirm / ✓)
  // ── teammate invites (owner-initiated, 30-min one-time). An owner runs `yay invite`
  // to mint one; the new member opens /join, makes a key, and submits their PUBLIC key;
  // we then run the normal owner-signed enroll (routed to the owner's phone), so nothing
  // trust-critical is new here — this only collects the pubkey and triggers `yay enroll`.
  const invites = new Map(); // token → { name, role, exp, used, done, result, code }
  const INVITE_TTL = 30 * 60 * 1000;
  const purgeInvites = () => { const now = Date.now(); for (const [k, v] of invites) if (v.exp < now && v.done !== false) invites.delete(k); };
  const phoneHTML = signerHTML({ mode: 'dashboard', project: deps.project || 'project' });
  function verifySubmit(b) {
    if (pending.mode === 'pair') {
      const { name, pubB64, proof } = b || {};
      if (!name || !pubB64 || !proof) return { error: 'missing name/pubB64/proof' };
      if (pending.genesis) {
        const ev = { ...pending.genesis, name: String(name), pub: pubB64, by: String(name) };
        if (!C.verify(canonical(ev), proof, pubB64)) return { error: 'genesis self-signature failed' };
        return { code: confirmCode(pubB64), done: { name: String(name), pubB64, code: confirmCode(pubB64), genesisEvent: { ...ev, signature: proof } } };
      }
      if (!C.verify(pending.session.challenge, proof, pubB64)) return { error: 'key possession proof failed' };
      return { code: confirmCode(pubB64), done: { name: String(name), pubB64, proof, code: confirmCode(pubB64) } };
    }
    // approve / authorize: verify the signature over the canonical approval/event.
    // If the phone edited the Brief text (§5), rebuild the approval with it so the
    // signature is checked against — and the seal stores — exactly what was signed.
    let target = pending.session.approval || pending.session.event;
    const editedBrief = (b && b.brief !== undefined && pending.session.approval && pending.session.approval.brief);
    if (editedBrief) target = { ...pending.session.approval, brief: { ...pending.session.approval.brief, text: String(b.brief).trim() } };
    const canon = canonical(target);
    if (!b || !b.signature) return { error: 'missing signature' };
    if (!(pending.expectPubs || []).some((pub) => pub && C.verify(canon, b.signature, pub))) return { error: 'not signed by an authorized key on this phone' };
    return { done: editedBrief ? { signature: b.signature, brief: String(b.brief).trim() } : { signature: b.signature } };
  }
  const handler = async (req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'OPTIONS') return sendJSON(res, 200, {});
    if (req.method === 'GET' && url === '/api/ping') return sendJSON(res, 200, { yay: 'dashboard', busy: !!pending });

    // ── CLI-facing (localhost only) ──
    if (req.method === 'POST' && url === '/api/request') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (pending) return sendJSON(res, 409, { error: 'a request is already awaiting the phone' });
      const b = await readBody(req);
      const session = { mode: b.mode };
      if (b.approval) session.approval = b.approval;
      if (b.event) session.event = b.event;
      if (b.summary) session.summary = b.summary;
      if (b.challenge) session.challenge = b.challenge;
      if (b.genesis) session.genesis = b.genesis;
      if (b.signer) session.signer = b.signer;
      if (b.signerPubs) session.signerPubs = b.signerPubs;
      pending = { mode: b.mode, session, expectPubs: b.expectPubB64 || b.ownerPubs || [], genesis: b.genesis || null, done: null, submitted: false, waiters: [], at: Date.now() };
      finalStatus = null;
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url === '/api/result') { // CLI long-poll for the phone's subbrief
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (!pending) return sendJSON(res, 200, { result: null, gone: true });
      if (pending.done) return sendJSON(res, 200, { result: pending.done });
      pending.waiters.push(res); return; // held until the phone submits
    }
    if (req.method === 'POST' && url === '/api/final') { // CLI publishes the outcome, then clears the slot
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      finalStatus = (await readBody(req)).final || null; pending = null; return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'POST' && url === '/api/cancel') { if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' }); pending = null; finalStatus = null; return sendJSON(res, 200, { ok: true }); }
    // Owner mints a teammate invite (localhost only — an owner on this machine).
    if (req.method === 'POST' && url === '/api/invite/create') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      purgeInvites();
      const b = await readBody(req);
      const name = String(b.name || '').trim(); // an optional SUGGESTION — the joiner can edit or set their own
      const role = b.role === 'owner' ? 'owner' : 'signer';
      const token = crypto.randomBytes(18).toString('hex');
      invites.set(token, { name, role, exp: Date.now() + INVITE_TTL, used: false, done: null, result: null, code: null });
      return sendJSON(res, 200, { ok: true, token, name, role, joinPath: '/join?t=' + token, expiresInMin: INVITE_TTL / 60000 });
    }

    // ── phone-facing ──
    if (req.method === 'GET' && (url === '/phone' || url === '/phone.html')) return sendHTML(res, phoneHTML);
    // Teammate join page + its API (the new member's phone).
    if (req.method === 'GET' && url === '/join') {
      const t = new URLSearchParams(req.url.split('?')[1] || '').get('t') || '';
      return sendHTML(res, signerHTML({ mode: 'join', project: deps.project || 'project', token: t }));
    }
    if (req.method === 'GET' && url === '/api/invite/info') {
      const t = new URLSearchParams(req.url.split('?')[1] || '').get('t') || '';
      const inv = invites.get(t);
      if (!inv || inv.exp < Date.now()) return sendJSON(res, 200, { valid: false });
      return sendJSON(res, 200, { valid: true, name: inv.name, role: inv.role, used: !!inv.used, project: deps.project || 'project' });
    }
    if (req.method === 'POST' && url === '/api/invite/join') {
      const b = await readBody(req);
      const inv = invites.get(b.token);
      if (!inv || inv.exp < Date.now()) return sendJSON(res, 400, { error: 'this invite is invalid or has expired — ask for a new one' });
      if (inv.used) return sendJSON(res, 409, { error: 'this invite has already been used' });
      if (!b.pubB64 || !b.proof || !C.verify(b.token, b.proof, b.pubB64)) return sendJSON(res, 400, { error: 'key possession proof failed' });
      if (!deps.enroll) return sendJSON(res, 200, { error: 'enrollment is not available on this dashboard' });
      // The joiner's chosen name (pre-filled from the invite suggestion, editable) is the
      // roster label; the owner sees and approves it on their phone.
      const memberName = String(b.name || '').trim() || inv.name;
      if (!memberName) return sendJSON(res, 400, { error: 'a name is required' });
      inv.used = true; inv.done = false; inv.result = null; inv.code = confirmCode(b.pubB64); inv.memberName = memberName;
      // Run the normal owner-signed enroll (routes the approval to the owner's phone).
      Promise.resolve(deps.enroll({ name: memberName, pubkey: b.pubB64, role: inv.role }))
        .then((r) => { inv.result = r || { ok: false, error: 'no result' }; inv.done = true; })
        .catch((e) => { inv.result = { ok: false, error: String((e && e.message) || e) }; inv.done = true; });
      return sendJSON(res, 200, { ok: true, code: inv.code });
    }
    if (req.method === 'GET' && url === '/api/invite/status') {
      const t = new URLSearchParams(req.url.split('?')[1] || '').get('t') || '';
      const inv = invites.get(t);
      if (!inv) return sendJSON(res, 200, { gone: true });
      return sendJSON(res, 200, { done: !!inv.done, result: inv.result || null, code: inv.code || null });
    }
    // Certificate download + trust guide, so users get the cert FROM yay-layer (not off the laptop).
    if (req.method === 'GET' && (url === '/ca' || url === '/ca.crt' || url === '/ca.pem' || url === '/ca.cer')) {
      if (!opts.caPem) return sendJSON(res, 404, { error: 'no certificate to install (running over http, or self-signed cert unavailable)' });
      return sendCert(res, opts.caPem, opts.caFilename);
    }
    if (req.method === 'GET' && (url === '/trust' || url === '/cert')) {
      if (!opts.caPem) return sendHTML(res, '<meta name=viewport content="width=device-width,initial-scale=1"><p style="font:16px sans-serif;padding:24px">This dashboard is running over plain http (or without an installable certificate), so there is nothing to trust — the phone connects directly.</p>');
      return sendHTML(res, trustHTML());
    }
    if (req.method === 'GET' && url === '/api/session') return sendJSON(res, 200, pending ? { ...pending.session } : { mode: 'idle' });
    if (req.method === 'GET' && url === '/api/status') return sendJSON(res, 200, { final: finalStatus });
    if (req.method === 'POST' && url === '/api/submit') {
      if (!pending) return sendJSON(res, 409, { error: 'nothing to sign right now' });
      const out = verifySubmit(await readBody(req));
      if (out.error) return sendJSON(res, 400, { error: out.error });
      pending.done = out.done; pending.submitted = true;
      const ws = pending.waiters; pending.waiters = [];
      for (const w of ws) { try { sendJSON(w, 200, { result: out.done }); } catch (_) {} }
      return sendJSON(res, 200, { ok: true, code: out.code });
    }

    if (req.method === 'GET' && url === '/api/version') { try { return sendJSON(res, 200, { v: deps.version() }); } catch (e) { return sendJSON(res, 200, { v: 'err' }); } }
    if (req.method === 'GET' && url === '/api/diffs') { try { return sendJSON(res, 200, { diffs: deps.diffs ? deps.diffs() : [] }); } catch (e) { return sendJSON(res, 200, { diffs: [], error: String(e && e.message || e) }); } }
    if (req.method === 'GET' && url === '/api/tests') return sendJSON(res, 200, { ...(deps.testInfo ? deps.testInfo() : { configured: false }), last: lastTest });
    if (req.method === 'POST' && url === '/api/tests/run') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (!deps.runTests) return sendJSON(res, 200, { configured: false, output: 'tests not available' });
      const r = await deps.runTests(); lastTest = r; return sendJSON(res, 200, r);
    }
    if (req.method === 'POST' && url === '/api/adversary/run') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (!deps.adversary) return sendJSON(res, 200, { error: 'adversary not available' });
      return sendJSON(res, 200, await deps.adversary());
    }
    if (req.method === 'POST' && url === '/api/plan/regen') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (!deps.regenPlan) return sendJSON(res, 200, { ok: false, error: 'plan not available' });
      return sendJSON(res, 200, await deps.regenPlan());
    }
    // Human-initiated sign FROM the dashboard: gather the current change-set under the
    // given brief and push it to the phone to approve (the key stays on the phone).
    if (req.method === 'POST' && url === '/api/sign/start') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (!deps.signPending) return sendJSON(res, 200, { ok: false, error: 'signing not available' });
      if (pending) return sendJSON(res, 409, { error: 'a request is already awaiting the phone' });
      const brief = ((await readBody(req)).brief || '').trim();
      if (!brief) return sendJSON(res, 400, { error: 'a brief is required' });
      try { return sendJSON(res, 200, await deps.signPending(brief)); }
      catch (e) { return sendJSON(res, 200, { ok: false, error: String((e && e.message) || e) }); }
    }
    if (req.method === 'GET' && (url === '/' || url === '/index.html' || url === '/map')) {
      try { const m = deps.buildMapHTML(); return sendHTML(res, withLiveControls(m.html, deps.version())); }
      catch (e) { return sendHTML(res, '<pre style="font-family:monospace;padding:24px;color:#d92d20">map build error:\n' + String((e && e.stack) || e).replace(/[<&]/g, '_') + '</pre>'); }
    }
    sendJSON(res, 404, { error: 'not found' });
  };
  const tls = opts.tls;
  const server = tls ? require('https').createServer({ key: tls.key, cert: tls.cert }, handler) : http.createServer(handler);
  const scheme = tls ? 'https' : 'http';
  const port = (opts.port !== undefined && opts.port !== null) ? opts.port : 48757; // port 0 = random (tests)
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => { const bound = server.address().port; resolve({ url: `${scheme}://${lanIP()}:${bound}`, local: `${scheme}://localhost:${bound}`, port: bound, close: () => server.close() }); });
  });
}

module.exports = { startDashboard, withLiveControls, lanIP };
