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
  const bar = '<div id="yd-bar" class="yd-float">'
    + '<div class="yd-livewrap"><span id="yd-live" class="yd-live">● live</span><button id="yd-refresh" class="yd-refresh" aria-label="Refresh" title="Refresh — reload the dashboard">↻</button></div>'
    + '<button class="yd-btn yd-primary" id="yd-req" title="Describe a change you want, in plain words. It is queued as a request your AI picks up (it runs `yay requests`) and turns into a polished Brief + specs for you to sign on your phone. You never write the Brief here."><span class="yd-icon">➕</span>Request a change</button>'
    + '<button class="yd-btn" id="yd-diffs"><span class="yd-icon">≷</span>Changes</button>'
    + '<button class="yd-btn" id="yd-prev" title="Preview: run a package.json script (dev server, build, …) through the dashboard — see its URL + output and stop it."><span class="yd-icon">▷</span>Preview</button>'
    + '<button class="yd-btn" id="yd-tests"><span class="yd-icon">▶</span>Run tests</button>'
    + '<button class="yd-btn" id="yd-adv"><span class="yd-icon">⚔</span>Adversary</button>'
    + '<button class="yd-btn" id="yd-plan"><span class="yd-icon">⟲</span>Regenerate System Plan</button>'
    + '<button class="yd-btn" id="yd-reseal" title="Re-seal the project foundation (Constitution, CI workflow, .gitignore, protocol files) after a legitimate change — approve on your phone."><span class="yd-icon">🛡</span>Re-seal foundation</button></div>'
    + '<div id="yd-panel" style="display:none"><div id="yd-phead" style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #2b2b2b;position:sticky;top:0;background:#0f1115"><b id="yd-ptitle">Output</b><button class="yd-btn yd-panel-btn" id="yd-close" style="padding:3px 10px">✕ close</button></div>'
    + '<pre id="yd-pout" style="margin:0;padding:12px 14px;white-space:pre-wrap;word-break:break-word"></pre></div>'
    // Request-a-change: a proper in-page modal (theme-aware), not a native prompt().
    + '<div id="yd-reqmodal" class="yd-modal"><div class="yd-modal-card">'
    + '<div class="yd-modal-h">Request a change</div>'
    + '<p class="yd-modal-p">Describe what you want built or changed, in plain words — just like you\'d tell your AI. It becomes a request your AI picks up, turns into a polished Brief + specs, and sends to your phone to sign. You don\'t write the Brief here.</p>'
    + '<textarea id="yd-reqtext" placeholder="e.g. Add rate-limiting to the login endpoint, 5 attempts per minute…"></textarea>'
    + '<div class="yd-modal-actions"><span id="yd-reqmsg" class="yd-modal-msg"></span><button id="yd-reqcancel" class="yd-mbtn">Cancel</button><button id="yd-reqsend" class="yd-mbtn yd-mbtn-primary">Send request →</button></div>'
    + '<div class="yd-modal-hint">⌘/Ctrl + Enter to send · Esc to close</div>'
    + '</div></div>'
    // Reusable confirm modal (replaces native confirm() for Adversary / Regenerate, etc.)
    + '<div id="yd-confirm" class="yd-modal"><div class="yd-modal-card" style="max-width:440px">'
    + '<div class="yd-modal-h" id="yd-cfh">Confirm</div>'
    + '<p class="yd-modal-p" id="yd-cfp" style="margin-bottom:4px"></p>'
    + '<div class="yd-modal-actions"><button id="yd-cfcancel" class="yd-mbtn">Cancel</button><button id="yd-cfok" class="yd-mbtn yd-mbtn-primary">Confirm</button></div>'
    + '</div></div>'
    + '<style>'
    // docked into the sidebar (the default: the dashboard shell provides #yd-slot)
    + '.yd-dock{display:flex;flex-direction:column;gap:0;padding:7px 12px 9px}'
    + '.yd-dock .yd-live{display:inline-flex;align-items:center;gap:6px;font-family:var(--sans);font-size:.62rem;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:#1f9d57;padding:0 2px 6px;transition:color .2s ease}'
    + '.yd-dock .yd-live.upd{color:var(--amber)}'
    + '.yd-dock .yd-live.stopped{color:var(--mut)}'
    + '.yd-dock .yd-livewrap{display:flex;align-items:center;justify-content:space-between;padding:0 2px 4px}'
    + '.yd-dock .yd-livewrap .yd-live{padding:0}'
    + '.yd-float .yd-livewrap{display:flex;align-items:center;gap:8px;justify-content:center;margin-bottom:2px}'
    + '.yd-refresh{background:none;border:none;color:var(--mut);cursor:pointer;font-size:1rem;line-height:1;padding:3px 5px;border-radius:7px;transition:color .14s,background .14s}'
    + '.yd-refresh:hover{color:var(--ink);background:color-mix(in srgb,var(--ink) 8%,transparent)}'
    + '.yd-dock .yd-btn{display:flex;align-items:center;gap:11px;width:100%;text-align:left;background:none;border:none;color:var(--ink2);border-radius:8px;padding:5px 12px;line-height:1.25;font-family:var(--sans);font-size:.84rem;font-weight:500;cursor:pointer;transition:background .14s,color .14s}'
    + '.yd-dock .yd-btn:hover{background:color-mix(in srgb,var(--ink) 6%,transparent);color:var(--ink)}'
    + '.yd-dock .yd-btn.yd-primary{color:var(--accent);font-weight:600}'
    + '.yd-dock .yd-icon{flex:0 0 18px;display:inline-flex;align-items:center;justify-content:center;font-size:13px;opacity:.85}'
    // floating fallback (only if no sidebar slot exists)
    + '.yd-float{position:fixed;right:16px;bottom:16px;z-index:99999;display:flex;flex-direction:column;gap:7px;align-items:stretch;font-family:ui-monospace,Menlo,monospace}'
    + '.yd-float .yd-live{align-self:center;padding:4px 12px;border-radius:100px;background:#1f9d57;color:#fff;font-size:11px;margin-bottom:2px}'
    + '.yd-float .yd-live.upd{background:#c9860f}.yd-float .yd-live.stopped{background:#8a939b}'
    + '.yd-float .yd-btn{display:flex;align-items:center;gap:9px;width:188px;box-sizing:border-box;padding:10px 14px;border-radius:11px;border:1px solid #3ecf8e;background:#fff;color:#159a63;font-weight:700;font-size:12.5px;text-align:left;cursor:pointer;box-shadow:0 3px 12px -6px rgba(0,0,0,.3)}'
    + '.yd-float .yd-btn.yd-primary{background:#3ecf8e;color:#04231a}.yd-float .yd-btn:hover{background:#f1fbf6}.yd-float .yd-icon{flex:0 0 18px;text-align:center;font-size:14px}'
    // output panel: overlays the main column, clear of the left sidebar
    + '#yd-panel{position:fixed;left:258px;right:16px;bottom:16px;max-height:64vh;overflow:auto;z-index:99998;background:#0f1115;color:#e6e6e6;border:1px solid #2b2b2b;border-radius:12px;box-shadow:0 24px 60px -20px rgba(0,0,0,.6);font-family:ui-monospace,Menlo,monospace;font-size:12.5px}'
    + '.yd-panel-btn{border:1px solid #3ecf8e;background:#fff;color:#159a63;border-radius:8px;font-weight:700;cursor:pointer}'
    + '@media(max-width:900px){#yd-panel{left:8px;right:8px;bottom:auto;top:8px;max-height:62vh}}'
    // request-a-change modal (theme-aware, matches the app)
    + '.yd-modal{position:fixed;inset:0;z-index:100000;display:none;align-items:flex-start;justify-content:center;padding:64px 16px;background:rgba(10,12,16,.55);backdrop-filter:blur(3px)}'
    + '.yd-modal.open{display:flex}'
    + '.yd-modal-card{background:var(--paper);color:var(--ink);border:1px solid var(--rule);border-radius:16px;max-width:520px;width:100%;padding:22px 24px 18px;box-shadow:0 40px 90px -30px rgba(0,0,0,.5);font-family:var(--sans)}'
    + '.yd-modal-h{font-size:1.15rem;font-weight:700;letter-spacing:-.01em;margin:0 0 8px}'
    + '.yd-modal-p{font-size:.88rem;color:var(--ink2);line-height:1.55;margin:0 0 14px}'
    + '.yd-modal textarea{width:100%;min-height:112px;box-sizing:border-box;padding:11px 13px;border-radius:10px;border:1px solid var(--rule);background:var(--card2);color:var(--ink);font-family:var(--sans);font-size:.92rem;line-height:1.5;resize:vertical}'
    + '.yd-modal textarea:focus{outline:none;border-color:var(--brand);box-shadow:0 0 0 3px color-mix(in srgb,var(--brand) 22%,transparent)}'
    + '.yd-modal-actions{display:flex;align-items:center;justify-content:flex-end;gap:9px;margin-top:14px}'
    + '.yd-modal-msg{margin-right:auto;font-size:.82rem;color:var(--mut)}'
    + '.yd-mbtn{font-family:var(--sans);font-size:.85rem;font-weight:600;padding:9px 16px;border-radius:9px;border:1px solid var(--rule);background:var(--card);color:var(--ink);cursor:pointer;transition:border-color .14s,filter .14s}'
    + '.yd-mbtn:hover{border-color:var(--mut)}'
    + '.yd-mbtn-primary{background:var(--brand);color:#04231a;border-color:var(--brand)}.yd-mbtn-primary:hover{filter:brightness(1.05)}'
    + '.yd-mbtn:disabled{opacity:.55;cursor:default}'
    + '.yd-modal-hint{margin-top:12px;font-size:.72rem;color:var(--mut);text-align:right}</style>';
  const js = '<script>(function(){var V=' + JSON.stringify(version) + ';'
    + 'var live=document.getElementById("yd-live"),panel=document.getElementById("yd-panel"),pout=document.getElementById("yd-pout"),ptitle=document.getElementById("yd-ptitle");'
    // Dock the controls into the sidebar slot when the dashboard shell provides one (the norm);
    // otherwise leave them floating (fallback for any non-shell page).
    + 'var ydSlot=document.getElementById("yd-slot"),ydBar=document.getElementById("yd-bar");'
    + 'if(ydSlot&&ydBar){ydBar.className="yd-dock";ydSlot.appendChild(ydBar);}else if(panel){panel.style.left="16px";}'
    + 'function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(m){return m==="&"?"&amp;":m==="<"?"&lt;":"&gt;";});}'
    + 'function show(t,txt,cls){ptitle.textContent=t;pout.textContent=txt;pout.style.color=cls==="ok"?"#3fbf77":cls==="err"?"#ff6b6b":"#e6e6e6";panel.style.display="block";}'
    + 'document.getElementById("yd-close").onclick=function(){panel.style.display="none";};'
    + 'document.getElementById("yd-refresh").onclick=function(){location.reload();};'
    + 'var pvTimer=null;function pvStop(){if(pvTimer){clearInterval(pvTimer);pvTimer=null;}}'
    + 'async function openPreview(){ptitle.textContent="Preview — run a package.json script";pout.style.color="#e6e6e6";panel.style.display="block";try{var j=await fetch("/api/scripts").then(function(r){return r.json();});var run=(j.running||[]),scripts=(j.scripts||[]);var h="";if(run.length){h+="<div style=\\"font-weight:700;margin:0 0 6px\\">Running</div>";run.forEach(function(r){h+="<div style=\\"border:1px solid #2b2b2b;border-radius:8px;padding:8px 10px;margin:0 0 8px\\"><div style=\\"display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap\\"><b>"+esc(r.name)+"</b><span>"+(r.url?("<a href=\\""+esc(r.url)+"\\" target=\\"_blank\\" rel=\\"noopener\\" style=\\"color:#3fbf77;font-weight:700;text-decoration:none\\">Open "+esc(r.url)+" ↗</a>"):(r.alive?"<span style=\\"color:#c9860f\\">starting…</span>":"<span style=\\"color:#ff6b6b\\">stopped</span>"))+" <button class=\\"yd-btn ps-stop\\" data-n=\\""+esc(r.name)+"\\" style=\\"padding:3px 10px\\">Stop</button></span></div>"+(r.output?"<pre style=\\"margin:6px 0 0;white-space:pre-wrap;max-height:150px;overflow:auto;color:#b8b8b8;font-size:11px\\">"+esc(r.output)+"</pre>":"")+"</div>";});}h+="<div style=\\"font-weight:700;margin:10px 0 6px\\">Scripts</div>";if(!scripts.length)h+="<div style=\\"color:#8a8a8a\\">No scripts in package.json.</div>";scripts.forEach(function(sn){var isr=run.some(function(r){return r.name===sn.name&&r.alive;});h+="<div style=\\"display:flex;justify-content:space-between;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid #222\\"><div><b>"+esc(sn.name)+"</b> <span style=\\"color:#8a8a8a;font-size:11px\\">"+esc(sn.cmd)+"</span></div>"+(isr?"<span style=\\"color:#3fbf77;font-size:11px\\">running</span>":"<button class=\\"yd-btn ps-run\\" data-n=\\""+esc(sn.name)+"\\" style=\\"padding:3px 12px\\">Run</button>")+"</div>";});pout.innerHTML=h;Array.prototype.forEach.call(pout.querySelectorAll(".ps-run"),function(b){b.onclick=async function(){b.textContent="…";await fetch("/api/scripts/run",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:b.getAttribute("data-n")})});setTimeout(openPreview,500);};});Array.prototype.forEach.call(pout.querySelectorAll(".ps-stop"),function(b){b.onclick=async function(){await fetch("/api/scripts/stop",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({name:b.getAttribute("data-n")})});setTimeout(openPreview,400);};});}catch(e){pout.textContent="Could not load scripts: "+e;}}'
    + 'document.getElementById("yd-prev").onclick=function(){pvStop();openPreview();pvTimer=setInterval(function(){if(panel.style.display!=="none"&&ptitle.textContent.indexOf("Preview")===0)openPreview();else pvStop();},2500);};'
    + 'document.getElementById("yd-diffs").onclick=async function(){ptitle.textContent="Spec changes since last commit";pout.style.color="#e6e6e6";pout.textContent="loading…";panel.style.display="block";try{var j=await fetch("/api/diffs").then(function(r){return r.json();});if(!j.diffs||!j.diffs.length){pout.textContent="No spec changes since the last commit (working tree matches HEAD).";return;}pout.innerHTML=j.diffs.map(function(c){var lines=c.diff.map(function(d){var col=d.t==="+"?"#3fbf77":d.t==="-"?"#ff6b6b":"#8a8a8a";var pre=d.t==="+"?"+ ":d.t==="-"?"- ":"  ";return "<div style=\\"color:"+col+"\\">"+esc(pre+d.text)+"</div>";}).join("");return "<div style=\\"margin:0 0 16px\\"><div style=\\"color:#e6e6e6;font-weight:700;margin-bottom:5px\\">"+esc(c.id+(c.unit?" · "+c.unit:"")+"   "+c.file)+"</div>"+lines+"</div>";}).join("");}catch(e){pout.textContent="Could not load diffs: "+e;}};'
    + 'document.getElementById("yd-adv").onclick=async function(){if(!(await ydConfirm("Run the spec-only adversary?","An LLM writes probes from the specs (never the code) and runs them to try to break the promise — this costs tokens.","Run adversary")))return;show("Adversary","Writing probes from the specs and running them… (a few seconds)");try{var r=await fetch("/api/adversary/run",{method:"POST"});if(r.status===403){show("Adversary","Run this on THIS computer (localhost).","err");return;}var j=await r.json();if(j.error){show("Adversary","✗ "+j.error,"err");return;}var rows=(j.results||[]);var broke=rows.filter(function(x){return x.status==="broke";});var html=rows.map(function(x){var col=x.status==="broke"?"#ff6b6b":x.status==="survived"?"#3fbf77":"#c9860f";var msg=x.status==="broke"?("BROKE: "+x.counterexample):x.status==="survived"?"survived":(x.reason||x.status);return "<div style=\\"color:"+col+"\\">"+esc((x.status==="broke"?"✗ ":x.status==="survived"?"✓ ":"– ")+x.id+" "+(x.unit||"")+" — "+msg)+"</div>";}).join("")||"No eligible Cells (need a leaf unit with ensures/out/throws).";ptitle.textContent="Adversary — "+broke.length+" broke / "+rows.length+" probed";pout.style.color="#e6e6e6";pout.innerHTML=html;panel.style.display="block";}catch(e){show("Adversary","Could not run: "+e,"err");}};'
    + 'document.getElementById("yd-tests").onclick=async function(){show("Tests","Running the project test suite…");try{var r=await fetch("/api/tests/run",{method:"POST"});if(r.status===403){show("Tests","Run tests from the dashboard on THIS computer (localhost) — not from the phone.","err");return;}var j=await r.json();show("Tests "+(j.configured?(j.ok?"✓ passed":"✗ failed (exit "+j.code+")"):""),(j.cmd?("$ "+j.cmd+"\\n\\n"):"")+(j.output||""),j.configured?(j.ok?"ok":"err"):"");}catch(e){show("Tests","Could not run: "+e,"err");}};'
    + 'var reqModal=document.getElementById("yd-reqmodal"),reqText=document.getElementById("yd-reqtext"),reqMsg=document.getElementById("yd-reqmsg"),reqSend=document.getElementById("yd-reqsend");'
    + 'function reqOpen(){reqText.value="";reqMsg.textContent="";reqMsg.style.color="var(--mut)";reqSend.disabled=false;reqModal.classList.add("open");setTimeout(function(){reqText.focus();},30);}'
    + 'function reqClose(){reqModal.classList.remove("open");}'
    + 'async function reqSubmit(){var t=(reqText.value||"").trim();if(!t){reqMsg.style.color="#cf4436";reqMsg.textContent="Type what you want changed.";reqText.focus();return;}reqSend.disabled=true;reqMsg.style.color="var(--mut)";reqMsg.textContent="Sending…";try{var r=await fetch("/api/request/create",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:t})});if(r.status===403){reqMsg.style.color="#cf4436";reqMsg.textContent="Add a request from the dashboard on THIS computer (localhost).";reqSend.disabled=false;return;}var j=await r.json();if(j.ok){reqClose();show("Request","✓ Queued as "+j.id+".\\n\\nYour AI picks this up when it next checks — tell it to \\"check requests\\" now, or it runs `yay requests` at the start of a session. It will draft the Brief + specs and send them to your phone to sign.","ok");}else{reqMsg.style.color="#cf4436";reqMsg.textContent="✗ "+(j.error||"failed");reqSend.disabled=false;}}catch(e){reqMsg.style.color="#cf4436";reqMsg.textContent="Could not queue: "+e;reqSend.disabled=false;}}'
    + 'document.getElementById("yd-req").onclick=reqOpen;document.getElementById("yd-reqcancel").onclick=reqClose;reqSend.onclick=reqSubmit;'
    + 'reqModal.addEventListener("click",function(e){if(e.target===reqModal)reqClose();});'
    + 'reqText.addEventListener("keydown",function(e){if(e.key==="Escape"){reqClose();}else if((e.metaKey||e.ctrlKey)&&e.key==="Enter"){reqSubmit();}});'
    // Promise-based confirm modal (replaces native confirm()).
    + 'var cfModal=document.getElementById("yd-confirm"),cfh=document.getElementById("yd-cfh"),cfp=document.getElementById("yd-cfp"),cfok=document.getElementById("yd-cfok"),cfcancel=document.getElementById("yd-cfcancel"),cfResolve=null;'
    + 'function ydConfirm(title,msg,okLabel){cfh.textContent=title;cfp.textContent=msg;cfok.textContent=okLabel||"Confirm";cfModal.classList.add("open");setTimeout(function(){cfok.focus();},30);return new Promise(function(res){cfResolve=res;});}'
    + 'function cfDone(v){cfModal.classList.remove("open");if(cfResolve){var r=cfResolve;cfResolve=null;r(v);}}'
    + 'cfok.onclick=function(){cfDone(true);};cfcancel.onclick=function(){cfDone(false);};'
    + 'cfModal.addEventListener("click",function(e){if(e.target===cfModal)cfDone(false);});'
    + 'document.addEventListener("keydown",function(e){if(cfModal.classList.contains("open")&&e.key==="Escape")cfDone(false);});'
    + 'var rs=document.getElementById("yd-reseal");if(rs)rs.onclick=async function(){if(!(await ydConfirm("Re-seal the foundation?","Signs a new baseline of the fixed core files (Constitution, CI workflow, .gitignore, protocol) — approve on your phone. Do this only after a change you made on purpose.","Re-seal")))return;show("Foundation","Sent to your phone — approve there…");try{var r=await fetch("/api/protect/reseal",{method:"POST"});if(r.status===403){show("Foundation","Re-seal from the dashboard on THIS computer (localhost).","err");return;}var j=await r.json();if(j.ok){show("Foundation","✓ Re-sealed. Reloading…","ok");setTimeout(function(){location.reload();},900);}else{show("Foundation","✗ "+(j.error||"failed"),"err");}}catch(e){show("Foundation","Could not re-seal: "+e,"err");}};'
    + 'document.getElementById("yd-plan").onclick=async function(){if(!(await ydConfirm("Regenerate the System Plan?","This calls your LLM provider and costs tokens.","Regenerate")))return;show("System Plan","Regenerating via your LLM provider… (a few seconds)");try{var r=await fetch("/api/plan/regen",{method:"POST"});if(r.status===403){show("System Plan","Regenerate from the dashboard on THIS computer (localhost).","err");return;}var j=await r.json();if(j.ok){show("System Plan","✓ Updated ("+j.provider+"/"+j.model+", "+j.subsystems+" subsystems). Reloading…","ok");setTimeout(function(){location.reload();},900);}else{show("System Plan","✗ "+(j.error||"failed"),"err");}}catch(e){show("System Plan","Could not regenerate: "+e,"err");}};'
    + 'function liveState(cls,txt){ if(!live) return; live.className="yd-live"+(cls?(" "+cls):""); live.textContent=txt; }'
    + 'async function poll(){try{var r=await fetch("/api/version",{cache:"no-store"});var j=await r.json();if(j.v&&j.v!==V){liveState("upd","● Updated — refreshing");setTimeout(function(){location.reload();},500);}else{liveState("","● Live");}}catch(_){liveState("stopped","● Server stopped");}}'
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
    // Send back (§5): the signer declined an approval and optionally noted what to change.
    if (pending.mode === 'approve' && b && b.rejected) return { done: { rejected: true, reason: String(b.reason || '').trim(), tags: Array.isArray(b.tags) ? b.tags : undefined } };
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
      if (b.tagPool) session.tagPool = b.tagPool;
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
    // Owner issues an Autopilot grant (localhost only; the approval routes to the owner's phone).
    if (req.method === 'POST' && url === '/api/grant/create') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'issue a grant from the dashboard on THIS computer (localhost).' });
      if (!deps.grant) return sendJSON(res, 200, { error: 'grant issuance is not available on this dashboard' });
      const b = await readBody(req);
      const r = await deps.grant(b);
      return sendJSON(res, 200, r);
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
    if (req.method === 'POST' && url === '/api/ask') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (!deps.ask) return sendJSON(res, 200, { ok: false, error: 'assistant not available' });
      const q = ((await readBody(req)).question || '').toString();
      try { return sendJSON(res, 200, await deps.ask(q)); }
      catch (e) { return sendJSON(res, 200, { ok: false, error: String((e && e.message) || e) }); }
    }
    if (req.method === 'POST' && url === '/api/protect/reseal') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (!deps.protect) return sendJSON(res, 200, { ok: false, error: 'foundation seal not available' });
      return sendJSON(res, 200, await deps.protect());
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
    // Queue a plain-language request FROM the dashboard. The AI picks it up (`yay requests`)
    // and turns it into a polished Brief + Cells to sign — the human never writes the Brief.
    if (req.method === 'POST' && url === '/api/request/create') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (!deps.addRequest) return sendJSON(res, 200, { ok: false, error: 'requests not available' });
      const text = ((await readBody(req)).text || '').trim();
      if (!text) return sendJSON(res, 400, { error: 'a request is required' });
      try { return sendJSON(res, 200, await deps.addRequest(text)); }
      catch (e) { return sendJSON(res, 200, { ok: false, error: String((e && e.message) || e) }); }
    }
    // Batch settings: how many small changes group into one Brief.
    if (req.method === 'POST' && url === '/api/batch') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (!deps.batchSet) return sendJSON(res, 200, { ok: false, error: 'batch settings not available' });
      const b = await readBody(req);
      try { return sendJSON(res, 200, deps.batchSet(b)); }
      catch (e) { return sendJSON(res, 200, { ok: false, error: String((e && e.message) || e) }); }
    }
    // Preview: run package.json scripts (dev server, build…) through the dashboard.
    if (req.method === 'GET' && url === '/api/scripts') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (!deps.scripts) return sendJSON(res, 200, { scripts: [], running: [] });
      try { return sendJSON(res, 200, deps.scripts()); } catch (e) { return sendJSON(res, 200, { scripts: [], running: [], error: String((e && e.message) || e) }); }
    }
    if (req.method === 'POST' && (url === '/api/scripts/run' || url === '/api/scripts/stop')) {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      const fn = url.endsWith('/run') ? deps.runScript : deps.stopScript;
      if (!fn) return sendJSON(res, 200, { ok: false, error: 'preview not available' });
      const name = (await readBody(req)).name;
      try { return sendJSON(res, 200, fn(name)); } catch (e) { return sendJSON(res, 200, { ok: false, error: String((e && e.message) || e) }); }
    }
    // Tag-pool editor (live): add / remove / rename / describe tags in .yaylayer/tags.json.
    if (req.method === 'POST' && url === '/api/tags/edit') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (!deps.tagsEdit) return sendJSON(res, 200, { ok: false, error: 'tag editing not available' });
      const b = await readBody(req);
      try { return sendJSON(res, 200, deps.tagsEdit(b)); }
      catch (e) { return sendJSON(res, 200, { ok: false, error: String((e && e.message) || e) }); }
    }
    // Policy editor: edit the DRAFT (.yaylayer/policy.json), then owner-sign it into effect.
    if (req.method === 'POST' && url === '/api/policy/rule') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (!deps.policyAddRule) return sendJSON(res, 200, { ok: false, error: 'policy editing not available' });
      const b = await readBody(req);
      try { return sendJSON(res, 200, deps.policyAddRule({ match: b.match || {}, signer: b.signer, inert: b.inert, ignore: b.ignore })); }
      catch (e) { return sendJSON(res, 200, { ok: false, error: String((e && e.message) || e) }); }
    }
    if (req.method === 'POST' && url === '/api/policy/remove') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (!deps.policyRemoveRule) return sendJSON(res, 200, { ok: false, error: 'policy editing not available' });
      const b = await readBody(req);
      try { return sendJSON(res, 200, deps.policyRemoveRule(parseInt(b.index, 10))); }
      catch (e) { return sendJSON(res, 200, { ok: false, error: String((e && e.message) || e) }); }
    }
    if (req.method === 'POST' && url === '/api/policy/apply') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (!deps.policyApply) return sendJSON(res, 200, { ok: false, error: 'policy apply not available' });
      if (pending) return sendJSON(res, 409, { error: 'a request is already awaiting the phone' });
      try { return sendJSON(res, 200, await deps.policyApply()); }
      catch (e) { return sendJSON(res, 200, { ok: false, error: String((e && e.message) || e) }); }
    }
    // Autopilot: ratify (human-sign for real) the Cells auto-approved under a grant. Routes
    // the signature to the phone (or local key), same as any sign — supersedes the delegation.
    if (req.method === 'POST' && url === '/api/ratify') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (!deps.ratifyApply) return sendJSON(res, 200, { ok: false, error: 'ratify not available' });
      if (pending) return sendJSON(res, 409, { error: 'a request is already awaiting the phone' });
      const b = await readBody(req); // b.reviewed = the bundle hash the page rendered (TOCTOU guard)
      try { return sendJSON(res, 200, await deps.ratifyApply(b && b.reviewed)); }
      catch (e) { return sendJSON(res, 200, { ok: false, error: String((e && e.message) || e) }); }
    }
    // Briefs history lens: a Cell as a given Brief signed it (git), + current + a then→now diff.
    if (req.method === 'POST' && url === '/api/cell-history') {
      if (!isLocal(req)) return sendJSON(res, 403, { error: 'local only' });
      if (!deps.cellAsOf) return sendJSON(res, 200, { ok: false, error: 'history not available' });
      const b = await readBody(req);
      try { return sendJSON(res, 200, deps.cellAsOf(String(b.brief || ''), String(b.cell || ''))); }
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
