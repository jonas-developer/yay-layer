'use strict';
// The phone signer — a self-contained page served by `yay pair` / `yay sign --phone`.
// The key is generated and kept ON THE PHONE (ed25519 via bundled TweetNaCl, stored
// locally); the laptop only receives the public key and signatures. Formats match
// src/crypto.js: public key = base64 SPKI-DER (raw key wrapped with the ed25519 SPKI
// header), signature = base64 raw ed25519 over canonical(approval) — so `yay verify`
// checks it like any other seal.
//
// Uses PURE-JS crypto (not WebCrypto), so it works over a plain http LAN address —
// no secure-context / HTTPS requirement. (TweetNaCl only needs crypto.getRandomValues,
// which is available over http.) HTTPS is an opt-in transport, not a requirement.
//
// Visual design: a calm, card-led look matching relay.yaylayer.com — accent-bordered
// cards, uppercase micro-labels, muted helper text, one clear primary action per screen.
// System fonts only (no web-font fetch), so it renders fully offline on the LAN.

const fs = require('fs');
const path = require('path');
const NACL = fs.readFileSync(path.join(__dirname, 'vendor', 'tweetnacl.min.js'), 'utf8');
const RECOVERY = fs.readFileSync(path.join(__dirname, 'vendor', 'recovery.js'), 'utf8');

function signerHTML({ mode, project, token }) {
  const M = JSON.stringify(mode || 'pair');
  const P = JSON.stringify(project || 'project');
  const T = JSON.stringify(token || '');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>YayLayer Signer</title>
<style>
:root{
  --ground:#f6f8f6;--panel:#ffffff;--card:#ffffff;--card-tint:#eef5f0;
  --ink:#131714;--ink-2:#5a635c;--mut:#8b948d;--rule:#e4e9e5;
  --accent:#177f52;--accent-ink:#0a2c1d;--green:#1f9d57;--amber:#b7791f;--red:#c8402f;
  --shadow:0 18px 40px -24px rgba(16,40,28,.40);
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
/* Light by default on every phone (matches the site + mockups), regardless of the phone's OS theme. */
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);line-height:1.55;-webkit-font-smoothing:antialiased;
  min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:26px 18px}
.top{width:100%;max-width:460px;margin-bottom:14px;text-align:center}
.brandrow{display:flex;align-items:center;justify-content:center;gap:9px;margin-bottom:10px}
.logo{display:inline-flex;flex:none}
.brand{font-weight:700;font-size:.92rem;color:var(--ink)}
h1{font-weight:800;font-size:1.5rem;letter-spacing:-.01em;margin:2px 0 0}
.sub{color:var(--mut);font-size:.76rem;font-family:var(--mono);letter-spacing:.02em;margin-top:3px}
#app{width:100%;max-width:460px;background:var(--panel);border:1px solid var(--rule);border-radius:20px;padding:22px;box-shadow:var(--shadow)}
.msg{color:var(--ink);font-size:.98rem;margin:0 0 14px}
.help{color:var(--mut);font-size:.85rem;line-height:1.5;margin:0 0 14px}
.lab{font-family:var(--mono);font-size:.64rem;font-weight:600;letter-spacing:.15em;text-transform:uppercase;color:var(--accent);margin:0 0 8px}
.lbl{display:block;font-size:.8rem;color:var(--mut);margin:0 0 7px}
.inp{width:100%;font-size:1.05rem;padding:13px 14px;border-radius:12px;border:1px solid var(--rule);background:var(--card);color:var(--ink);font-family:var(--sans);margin-bottom:14px}
.inp:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
textarea.inp{min-height:96px;resize:vertical;font-family:var(--mono);font-size:.95rem}
.btn{width:100%;font-family:var(--sans);font-size:1rem;font-weight:700;padding:15px;border:none;border-radius:13px;background:var(--accent);color:var(--accent-ink);cursor:pointer}
.btn:active{filter:brightness(.94)}
.btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.btn.alt,.btn.ghost{background:transparent;color:var(--accent);border:1px solid var(--rule);margin-top:10px}
.btnrow{display:flex;gap:10px}.btnrow .btn{flex:1;margin-top:0}
.link{display:block;text-align:center;margin-top:15px;color:var(--accent);text-decoration:underline;cursor:pointer;font-size:.9rem}
.code{font-family:var(--mono);font-size:clamp(1.7rem,8.5vw,2.3rem);font-weight:600;letter-spacing:.12em;text-align:center;color:var(--accent);margin:4px 0;white-space:nowrap;overflow-x:auto}
.bigok{display:grid;place-items:center;gap:13px;text-align:center;padding:20px 0}
.check{width:64px;height:64px;border-radius:50%;background:var(--card-tint);display:grid;place-items:center}
.check svg{width:32px;height:32px;stroke:var(--green);stroke-width:3;fill:none;stroke-linecap:round;stroke-linejoin:round}
.bigok .t{font-weight:800;font-size:1.4rem;color:var(--green)}
.bigok .h{font-weight:700;font-size:1.15rem;color:var(--ink)}
.bigok .help{margin:0;max-width:27ch}
.ok-big{font-weight:800;font-size:1.4rem;color:var(--green);text-align:center;margin:6px 0}
.spin{width:38px;height:38px;border-radius:50%;border:3px solid var(--rule);border-top-color:var(--accent);animation:sp 1s linear infinite}
@media(prefers-reduced-motion:reduce){.spin{animation:none}}
@keyframes sp{to{transform:rotate(360deg)}}
.crow{border-top:1px solid var(--rule)}.crow:first-of-type{border-top:none}.crow .cell{border-top:none}
.cell{display:flex;align-items:flex-start;gap:11px;padding:12px 2px;border-top:1px solid var(--rule)}
.cell:first-of-type{border-top:none}
.cell.tap{cursor:pointer;user-select:none}
.dot{width:9px;height:9px;border-radius:50%;flex:none;margin-top:6px}
.cid{font-family:var(--mono);font-size:.79rem;font-weight:600}
.cin{color:var(--ink-2);font-size:.84rem;line-height:1.4}
.col{margin-left:auto;font-family:var(--mono);font-size:.58rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--mut);border:1px solid var(--rule);border-radius:99px;padding:3px 8px;white-space:nowrap;display:inline-flex;align-items:center;gap:4px}
.caret{color:var(--mut);font-size:.7rem}
.detailwrap{padding:2px 2px 12px 20px}
.kv{display:flex;gap:10px;padding:5px 0;font-size:.85rem;border-top:1px solid var(--rule)}.kv:first-child{border-top:none}
.kv .k{font-family:var(--mono);color:var(--mut);min-width:62px;flex:none}
.kv .v{white-space:pre-wrap;word-break:break-word}
.notes{margin-top:8px;padding-top:8px;border-top:1px dashed var(--rule)}.note{font-size:.82rem;padding:2px 0}
.difflbl{font-family:var(--mono);font-size:.7rem;color:var(--mut);margin:10px 0 6px;text-transform:uppercase;letter-spacing:.06em}
.diff{font-family:var(--mono);font-size:.8rem;border:1px solid var(--rule);border-radius:9px;overflow:hidden}
.dl{padding:3px 9px;white-space:pre-wrap;word-break:break-word;border-top:1px solid var(--rule)}.dl:first-child{border-top:none}
.dl.add{background:rgba(31,157,87,.14);color:var(--green)}
.dl.del{background:rgba(200,64,47,.14);color:var(--red)}
.dl.ctx{color:var(--mut)}
.mcard{background:var(--card-tint);border:1px solid var(--rule);border-left:3px solid var(--accent);border-radius:14px;padding:14px 15px;margin:0 0 16px}
.mcard .mlab{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.mcard .mtag{font-family:var(--mono);font-weight:600;letter-spacing:.15em;font-size:.64rem;text-transform:uppercase;color:var(--accent)}
.mcard .medit{font-size:.8rem;font-weight:600;background:none;border:0;color:var(--accent);cursor:pointer;padding:0}
.mcard .mtxt{font-size:1.04rem;line-height:1.45;color:var(--ink)}
.mcard .marea{width:100%;font-size:1rem;line-height:1.45;padding:10px;border-radius:10px;border:1px solid var(--rule);background:var(--card);color:var(--ink);font-family:var(--sans);min-height:88px}
.mcard .msub{color:var(--mut);font-size:.75rem;margin-top:9px}
.words{display:grid;grid-template-columns:1fr 1fr;gap:8px 10px;margin:12px 0}
.word{font-family:var(--mono);font-size:.85rem;padding:8px 10px;background:var(--card);border:1px solid var(--rule);border-radius:9px;display:flex;gap:8px}
.word i{color:var(--mut);font-style:normal;min-width:1.3em;text-align:right}
.warn{color:var(--red);font-size:.84rem;line-height:1.45;margin:12px 0}
.chk{display:flex;align-items:flex-start;gap:9px;font-size:.9rem;margin:14px 0}
.chk input{margin-top:3px;width:18px;height:18px;flex:none;accent-color:var(--accent)}
.edited{font-family:var(--mono);font-size:.56rem;color:var(--amber);border:1px solid currentColor;border-radius:5px;padding:0 5px;margin-left:6px;vertical-align:middle;text-transform:uppercase;letter-spacing:.04em}
#status{width:100%;max-width:460px;margin-top:13px;font-family:var(--mono);font-size:.78rem;color:var(--mut);text-align:center;min-height:1.2em}
#status.ok{color:var(--green)}#status.err{color:var(--red)}
</style></head><body>
<div class="top"><div class="brandrow"><span class="logo"><svg width="24" height="24" viewBox="0 0 26 26" aria-hidden="true"><rect width="26" height="26" rx="7" fill="#177f52"/><path d="M6.5 13.5l4 4L20 7.5" fill="none" stroke="#eef5f0" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="brand">YayLayer Signer</span></div><h1 id="ttl">Sign</h1><div class="sub" id="proj"></div></div>
<div id="app"><div class="msg">Loading…</div></div>
<div id="status"></div>
<script>${NACL}</script>
<script>${RECOVERY}</script>
<script>
(function(){
var MODE=${M}, PROJECT=${P}, TOKEN=${T};
var app=document.getElementById('app'), statusEl=document.getElementById('status');
document.getElementById('proj').textContent=PROJECT;
document.getElementById('ttl').textContent=(MODE==='pair'?'Pair this phone':MODE==='authorize'?'Authorize change':MODE==='dashboard'?'YayLayer Signer':MODE==='join'?'Join the team':'Approve changes');
function setStatus(t,cls){statusEl.textContent=t;statusEl.className=cls||'';}
function h(html){app.innerHTML=html;}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
// Calm success screen (check circle + title + one muted line) — matches the mockup.
function okScreen(title,msg){h('<div class="bigok"><div class="check"><svg viewBox="0 0 24 24"><path d="M4 12.5l5 5L20 6.5"/></svg></div><div class="t">'+esc(title)+'</div><div class="help">'+esc(msg||'')+'</div></div>');}
var SPKI=new Uint8Array([48,42,48,5,6,3,43,101,112,3,33,0]); // ed25519 SPKI header (so the raw key matches Node's SPKI-DER)
function b64(buf){var b=new Uint8Array(buf),s='';for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s);}
function unb64(s){var bin=atob(s),a=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return a;}
function ebytes(str){return new TextEncoder().encode(str);}
function canonical(o){if(o===null||typeof o!=='object')return JSON.stringify(o);if(Array.isArray(o))return '['+o.map(canonical).join(',')+']';var k=Object.keys(o).sort(),p=[];for(var i=0;i<k.length;i++)p.push(JSON.stringify(k[i])+':'+canonical(o[k[i]]));return '{'+p.join(',')+'}';}
function hasCrypto(){return typeof nacl!=='undefined' && typeof YayRecovery!=='undefined' && window.crypto && typeof window.crypto.getRandomValues==='function';}
function loadKey(){try{return JSON.parse(localStorage.getItem('yay.key')||'null');}catch(e){return null;}}
function saveKey(o){localStorage.setItem('yay.key',JSON.stringify(o));}
// New identity from a fresh 24-word recovery phrase (the phrase is shown once,
// never stored — only the derived keypair is kept on the device).
function newIdentity(name){var ent=new Uint8Array(32);window.crypto.getRandomValues(ent);var mnemonic=YayRecovery.newMnemonic(ent);var kp=YayRecovery.mnemonicToKeypair(mnemonic);return {name:name,sec:kp.sec,pub:kp.pub,mnemonic:mnemonic};}
// Re-derive the SAME keypair from a written-down phrase (device loss / new phone).
function restoreIdentity(name,phrase){var kp=YayRecovery.mnemonicToKeypair(phrase);return {name:name,sec:kp.sec,pub:kp.pub};}
// ── PIN lock ── the secret is stored ENCRYPTED (nacl.secretbox under a PBKDF2(PIN)
// key); only ciphertext hits localStorage. Unlocked once per page-load, cached in
// memory. A longer passphrase is stronger; the 24 words remain the master backup.
var unlocked=null; // {pub,sec} after a successful unlock this page-load
function askPin(title,sub){
  return new Promise(function(resolve){
    h('<div class="msg"><b>'+esc(title)+'</b></div>'+(sub?'<div class="help">'+esc(sub)+'</div>':'')+'<input id="pin" class="inp" type="password" autocomplete="off" autocapitalize="off" placeholder="PIN or passphrase (6+ characters)"><button id="go" class="btn">Continue</button>');
    document.getElementById('pin').focus();
    document.getElementById('go').onclick=function(){var v=document.getElementById('pin').value||'';if(v.length<6){setStatus('At least 6 characters','err');return;}setStatus('');resolve(v);};
  });
}
// Set a PIN, seal the key, store only ciphertext, cache it for this page-load.
async function setPinAndSave(k){
  var pin=await askPin('Protect your key with a PIN','You’ll enter this to sign on this phone. A longer passphrase is stronger. It never leaves the phone and can’t be recovered — but your 24 words can always restore the key.');
  var pin2=await askPin('Confirm your PIN');
  if(pin!==pin2){setStatus('PINs didn’t match — start again','err');return setPinAndSave(k);}
  setStatus('Encrypting…'); await sleep(30);
  saveKey({name:k.name,pub:k.pub,enc:YayRecovery.sealSecret(k.sec,pin),v:2});
  unlocked={pub:k.pub,sec:k.sec}; setStatus('');
}
// Plaintext secret for a stored key, unlocking with the PIN if it's encrypted.
async function getSecret(key){
  if(key.sec) return key.sec;                       // legacy plaintext key
  if(!key.enc) throw new Error('no key material on this device');
  if(unlocked&&unlocked.pub===key.pub) return unlocked.sec;
  for(;;){
    var pin=await askPin('Enter your PIN to sign');
    setStatus('Unlocking…'); await sleep(30);
    var sec=YayRecovery.openSecret(key.enc,pin);
    if(sec){unlocked={pub:key.pub,sec:sec};setStatus('');return sec;}
    setStatus('Wrong PIN — try again','err');
  }
}
function signStr(secB64,str){return b64(nacl.sign.detached(ebytes(str),unb64(secB64)));}
async function api(path,body){var r=await fetch(path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return r.json();}

async function main(){
  if(!hasCrypto()){ h('<div class="msg">This browser is too old to sign here — it lacks <b>crypto.getRandomValues</b>. Try a current mobile browser.</div>'); return; }
  if(MODE==='dashboard') return dashLoop();   // persistent: scan once, requests appear
  if(MODE==='join') return joinFlow();        // new teammate: make a key, request to join
  try{
    var sess=await api('/api/session');
    if(sess.mode==='pair'||sess.mode==='approve'||sess.mode==='authorize') return dispatch(sess);
    h('<div class="msg">Nothing to do right now.</div>');
  }catch(e){ setStatus('Could not reach the laptop — still waiting? '+e,'err'); }
}
// Dashboard mode: idle here until the laptop sends a request, handle it, then wait
// for the next — the human only ever scans the QR once, at the start of the session.
function idleScreen(msg){ h('<div class="bigok"><div class="spin"></div><div class="h">'+esc(msg||'Waiting for a request')+'</div><div class="help">You’re connected. When your AI asks for approval, the brief shows up here.</div></div>'); setStatus('● connected','ok'); }
async function waitCleared(){ for(var i=0;i<4000;i++){ await sleep(1500); try{ var s=await api('/api/session'); if(!s||!s.mode||s.mode==='idle') return; }catch(e){ return; } } }
async function dashLoop(){
  idleScreen();
  for(;;){
    try{
      var sess=await api('/api/session');
      if(sess && sess.mode && sess.mode!=='idle'){ dispatch(sess); await waitCleared(); idleScreen(); }
    }catch(e){ setStatus('reconnecting…','err'); }
    await sleep(1500);
  }
}
function pairFlow(sess){
  var key=loadKey();
  var note=sess.genesis?'<div class="help" style="color:var(--accent)">This phone will become the project’s <b>trust root</b> — no key is stored on the computer.</div>':'';
  if(key){ h(note+'<div class="msg">Key ready for <b>'+esc(key.name)+'</b> on this device.</div><button id="go" class="btn">'+(sess.genesis?'Become trust root &amp; pair':'Pair this device')+'</button>'); document.getElementById('go').onclick=function(){doPair(sess,key);}; return; }
  h(note+'<label class="lbl">Your name (shown on every signature)</label><input id="nm" class="inp" placeholder="e.g. Alex Doe" autocapitalize="words"><button id="go" class="btn">Create key &amp; pair</button><span id="rst" class="link">Restore from recovery phrase</span>');
  document.getElementById('go').onclick=function(){
    var name=(document.getElementById('nm').value||'').trim(); if(!name){setStatus('Enter a name','err');return;}
    setStatus('Generating your key…');
    try{ var k=newIdentity(name); showBackup(sess,k); setStatus(''); }catch(e){ setStatus('Key generation failed: '+e,'err'); }
  };
  document.getElementById('rst').onclick=function(){restoreFlow(sess);};
}
// Show the 24-word recovery phrase ONCE. It is the only backup and is never
// stored on the device or sent to the laptop; only the derived key is kept.
function showBackup(sess,k){
  var words=k.mnemonic.split(' ');
  var grid=words.map(function(w,i){return '<div class="word"><i>'+(i+1)+'</i>'+esc(w)+'</div>';}).join('');
  h('<div class="lab">Recovery phrase</div>'
    +'<div class="msg">Write these 24 words down on paper, in order.</div>'
    +'<div class="words">'+grid+'</div>'
    +'<div class="warn">This is the ONLY way to restore your key if you lose this phone. Anyone who has it can sign as you. Never photograph it, type it into a website, or store it online.</div>'
    +'<label class="chk"><input type="checkbox" id="ack"><span>I have written down my recovery phrase and stored it safely.</span></label>'
    +'<button id="go" class="btn">Continue</button>');
  document.getElementById('go').onclick=function(){
    if(!document.getElementById('ack').checked){setStatus('Confirm you saved your phrase','err');return;}
    verifyBackup(sess,k,words);
  };
}
// Lightweight proof they actually recorded it: re-enter one random word.
function verifyBackup(sess,k,words){
  var pos=(window.crypto.getRandomValues(new Uint32Array(1))[0])%words.length;
  h('<div class="msg">Quick check — type word <b>#'+(pos+1)+'</b> of your recovery phrase.</div>'
    +'<input id="wv" class="inp" autocapitalize="none" autocomplete="off" placeholder="word #'+(pos+1)+'"><button id="go" class="btn">Confirm &amp; pair</button><span id="sk" class="link">Show my phrase again</span>');
  document.getElementById('go').onclick=async function(){
    var v=(document.getElementById('wv').value||'').trim().toLowerCase();
    if(v!==words[pos]){setStatus('That word doesn’t match #'+(pos+1)+' — check your written copy','err');return;}
    setStatus(''); delete k.mnemonic; await setPinAndSave(k); await doPair(sess,{name:k.name,sec:k.sec,pub:k.pub});
  };
  document.getElementById('sk').onclick=function(){showBackup(sess,k);};
}
// Re-enter the flow for the current mode after the key is available.
function dispatch(sess){ if(sess.mode==='approve') return approveFlow(sess); if(sess.mode==='authorize') return authorizeFlow(sess); return pairFlow(sess); }
// Restore an existing identity by pasting its written-down phrase. Works from ANY
// mode (pair / approve / authorize) — after restoring it continues that flow.
function restoreFlow(sess){
  h('<div class="lab">Restore your key</div>'
    +'<div class="msg">Paste your 24-word recovery phrase.</div>'
    +'<label class="lbl">Your name (as shown on your signatures)</label><input id="nm" class="inp" placeholder="e.g. Alex Doe" autocapitalize="words">'
    +'<label class="lbl">Recovery phrase</label><textarea id="ph" class="inp" autocapitalize="none" autocomplete="off" placeholder="word1 word2 … word24"></textarea>'
    +'<button id="go" class="btn">Restore key</button><span id="bk" class="link">Back</span>');
  document.getElementById('go').onclick=async function(){
    var name=(document.getElementById('nm').value||'').trim(); if(!name){setStatus('Enter your name','err');return;}
    var phrase=(document.getElementById('ph').value||'').trim(); if(!phrase){setStatus('Paste your phrase','err');return;}
    setStatus('Restoring your key…');
    try{ var k=restoreIdentity(name,phrase); await setPinAndSave(k); if(sess.mode==='pair'){ await doPair(sess,k); } else { dispatch(sess); } }
    catch(e){ setStatus(String(e&&e.message||e).replace(/^Error:\\s*/,''),'err'); }
  };
  document.getElementById('bk').onclick=function(){dispatch(sess);};
}
async function doPair(sess,key){
  try{
    var sec=await getSecret(key);
    setStatus('Pairing…');
    var proof;
    if(sess.genesis){
      // No trust root yet → this phone BECOMES it. Self-sign the genesis event
      // (canonical() here matches the laptop's eventBytes exactly).
      var g=sess.genesis;
      var ev={id:g.id,type:g.type,name:key.name,pub:key.pub,role:g.role,by:key.name,prev:g.prev,nonce:g.nonce,at:g.at};
      proof=signStr(sec,canonical(ev));
    }else{
      proof=signStr(sec,sess.challenge);
    }
    var res=await api('/api/submit',{name:key.name,pubB64:key.pub,proof:proof});
    if(res.error){ setStatus('Rejected: '+res.error,'err'); return; }
    h('<div class="lab" style="text-align:center">Code on this phone</div><div class="code">'+esc(res.code)+'</div><div class="help" style="text-align:center;margin:0">Your laptop should show this exact code. If it matches, approve it there.</div>');
    setStatus('Waiting for the laptop…','ok');
    pollPairStatus();
  }catch(e){ setStatus('Pairing failed: '+e,'err'); }
}
function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}
// After submitting, the phone waits for the laptop to confirm the code; poll the
// outcome so this screen flips to success/failure instead of hanging forever.
async function pollPairStatus(){
  for(var i=0;i<800;i++){
    try{
      var s=await api('/api/status');
      if(s&&s.final){
        if(s.final.ok){ okScreen('Paired', s.final.message||'Done — you can close this.'); setStatus('Paired','ok'); }
        else { h('<div class="msg">Pairing wasn’t completed'+(s.final.reason?': '+esc(s.final.reason):'')+'.</div><div class="help" style="margin:0">Start again with <b>yay pair</b> on the laptop.</div>'); setStatus('Not paired','err'); }
        return;
      }
    }catch(e){ return; } // server closed after finishing — stop quietly
    await sleep(1500);
  }
}
// Full spec of a Cell (intent/ensures/in/out/pure/…) + any verify notes, shown on tap.
function detailHTML(c){
  var sp=c.spec||{}, order=['intent','ensures','in','out','pure','throws','feeds','contains','lang','unit'], seen={}, parts=[];
  function add(k){ if(sp[k]!=null && String(sp[k]).trim()!==''){ seen[k]=1; parts.push('<div class="kv"><span class="k">'+esc(k)+'</span><span class="v">'+esc(String(sp[k]))+'</span></div>'); } }
  order.forEach(add);
  Object.keys(sp).forEach(function(k){ if(!seen[k]) add(k); });
  if(c.file) parts.push('<div class="kv"><span class="k">file</span><span class="v">'+esc(c.file)+(c.line?':'+c.line:'')+'</span></div>');
  var diff='';
  if(c.diff&&c.diff.length){
    diff='<div class="difflbl">changes vs last committed spec</div><div class="diff">'
      +c.diff.map(function(d){ var cl=d.t==='+'?'add':(d.t==='-'?'del':'ctx'); var pre=d.t==='+'?'+ ':(d.t==='-'?'- ':'  '); return '<div class="dl '+cl+'">'+pre+esc(d.text)+'</div>'; }).join('')
      +'</div>';
  }
  var notes=(c.notes||[]).map(function(nt){ var col=nt.level==='red'?'var(--red)':(nt.level==='yellow'?'var(--amber)':'var(--mut)'); return '<div class="note" style="color:'+col+'">'+esc(nt.text)+'</div>'; }).join('');
  return '<div class="detail">'+(parts.join('')||'<div class="kv"><span class="v">No structured spec fields.</span></div>')+diff+(notes?'<div class="notes">'+notes+'</div>':'')+'</div>';
}
function approveFlow(sess){
  var key=loadKey();
  if(!key){ h('<div class="msg">This phone has no key on this page yet — restore it from your recovery phrase, or run <b>yay pair</b>.</div><button id="rst" class="btn">Restore from recovery phrase</button>'); document.getElementById('rst').onclick=function(){restoreFlow(sess);}; return; }
  var rows=(sess.summary||[]).map(function(c,i){var ed=(c.diff&&c.diff.length)?' <span class="edited">edited</span>':'';return '<div class="crow"><div class="cell tap" data-i="'+i+'"><span class="dot" style="background:'+(c.color||'#888')+'"></span><div><div class="cid">'+esc(c.id)+' · '+esc(c.unit||'')+ed+'</div><div class="cin">'+esc(c.intent||'')+'</div></div><span class="col">'+esc(c.state||'')+'<span class="caret">▸</span></span></div><div class="detailwrap" id="d'+i+'" style="display:none">'+detailHTML(c)+'</div></div>';}).join('');
  // BRIEF header (Standard §5): the human-owned headline over these parts. Editable
  // before signing so the wording is the human's, not the AI's paraphrase; the edited
  // text is what gets signed (canonical(approval) is rebuilt with it below).
  var brief=sess.approval&&sess.approval.brief;
  var briefCard=brief?('<div class="mcard"><div class="mlab"><span class="mtag">Brief</span><button id="medit" class="medit">Edit</button></div>'
    +'<div id="mtxt" class="mtxt">'+esc(brief.text)+'</div>'
    +'<div class="msub">covers '+((sess.summary||[]).length)+' part(s) · you are approving this</div></div>'):'';
  h(briefCard+'<div class="help">Approve these <b>'+((sess.summary||[]).length)+'</b> change(s) — tap a part to see its spec.</div>'+rows+'<button id="go" class="btn" style="margin-top:16px">Approve &amp; sign</button>');
  var editing=false;
  if(brief){document.getElementById('medit').onclick=function(){
    var box=document.getElementById('mtxt');
    if(!editing){editing=true;this.textContent='Done';var t=box.textContent;box.outerHTML='<textarea id="mtxt" class="marea">'+esc(t)+'</textarea>';document.getElementById('mtxt').focus();}
    else{editing=false;this.textContent='Edit';var v=document.getElementById('mtxt').value;box.outerHTML='<div id="mtxt" class="mtxt">'+esc(v)+'</div>';}
  };}
  function briefValue(){var el=document.getElementById('mtxt');if(!el)return null;return editing?el.value:el.textContent;}
  var taps=document.querySelectorAll('.cell.tap');
  for(var ti=0;ti<taps.length;ti++){(function(el){el.onclick=function(){var d=document.getElementById('d'+el.getAttribute('data-i'));var open=d.style.display!=='none';d.style.display=open?'none':'block';var car=el.querySelector('.caret');if(car)car.textContent=open?'▸':'▾';};})(taps[ti]);}
  document.getElementById('go').onclick=async function(){
    try{
      var sec=await getSecret(key);
      setStatus('Signing…');
      var toSign=sess.approval;
      var mv=briefValue();
      if(brief&&mv!=null){mv=String(mv).trim();toSign=JSON.parse(JSON.stringify(sess.approval));toSign.brief.text=mv;}
      var sig=signStr(sec,canonical(toSign));
      var res=await api('/api/submit',brief?{signature:sig,brief:(mv!=null?String(mv).trim():brief.text)}:{signature:sig});
      if(res.error){ setStatus('Rejected: '+res.error,'err'); return; }
      okScreen('Signed','The seal is on your laptop. Leave this open — the next request appears here automatically.');
      setStatus('Signed','ok');
    }catch(e){ setStatus('Signing failed: '+e,'err'); }
  };
}
// Owner authorizes a roster/governance change (enroll, revoke, reroot) from the phone.
function authorizeFlow(sess){
  var key=loadKey();
  if(!key){ h('<div class="msg">This phone has no key on this page yet — restore it from your recovery phrase (an existing owner’s phrase is required to authorize).</div><button id="rst" class="btn">Restore from recovery phrase</button>'); document.getElementById('rst').onclick=function(){restoreFlow(sess);}; return; }
  var s=sess.summary||{};
  var rows=(s.rows||[]).map(function(r){return '<div class="cell"><div><div class="cid">'+esc(r.k||'')+'</div><div class="cin">'+esc(r.v||'')+'</div></div></div>';}).join('');
  var warn=s.warn?'<div class="warn">'+esc(s.warn)+'</div>':'';
  h('<div class="msg">'+esc(s.title||'Authorize this change')+'</div>'+rows+warn+'<button id="go" class="btn" style="margin-top:16px">Authorize &amp; sign</button>');
  document.getElementById('go').onclick=async function(){
    try{
      var sec=await getSecret(key);
      setStatus('Signing…');
      var sig=signStr(sec,canonical(sess.event));
      var res=await api('/api/submit',{signature:sig});
      if(res.error){ setStatus('Rejected: '+res.error,'err'); return; }
      okScreen('Authorized','Done — the laptop has the signed event.');
      setStatus('Authorized','ok');
    }catch(e){ setStatus('Signing failed: '+e,'err'); }
  };
}
// ── Join flow: a new teammate makes their key and requests to join. The owner
// approves on their phone; nothing here is trust-critical (only the PUBLIC key is
// sent — the private key and 24 words never leave this device).
async function joinFlow(){
  var info; try{ info=await api('/api/invite/info?t='+encodeURIComponent(TOKEN)); }catch(e){ info=null; }
  if(!info || !info.valid){ h('<div class="msg">This invite link is invalid or has expired.</div><div class="help" style="margin:0">Ask a project owner to send you a fresh <b>yay invite</b> link.</div>'); setStatus('Invite expired','err'); return; }
  if(info.used){ h('<div class="msg">This invite has already been used.</div><div class="help" style="margin:0">Ask for a new one if you still need to join.</div>'); setStatus('Already used','err'); return; }
  var roleLbl=info.role==='owner'?'owner — can manage the team':'signer';
  var key=loadKey();
  var head='<div class="help">You’re joining <b>'+esc(info.project||PROJECT)+'</b> as <b>'+esc(info.name)+'</b> ('+esc(roleLbl)+'). Your signing key is made here and never leaves this phone.</div>';
  if(key){ h(head+'<div class="msg">A key already exists on this phone for <b>'+esc(key.name)+'</b>.</div><button id="go" class="btn">Use this key &amp; request to join</button>'); document.getElementById('go').onclick=function(){ doJoin(info,key); }; return; }
  h(head+'<button id="go" class="btn">Create my key &amp; request to join</button><span id="rst" class="link">Restore from recovery phrase</span>');
  document.getElementById('go').onclick=function(){
    setStatus('Generating your key…');
    try{ var k=newIdentity(info.name); joinBackup(info,k); setStatus(''); }catch(e){ setStatus('Key generation failed: '+e,'err'); }
  };
  document.getElementById('rst').onclick=function(){ joinRestore(info); };
}
function joinBackup(info,k){
  var words=k.mnemonic.split(' ');
  var grid=words.map(function(w,i){return '<div class="word"><i>'+(i+1)+'</i>'+esc(w)+'</div>';}).join('');
  h('<div class="lab">Recovery phrase</div><div class="msg">Write these 24 words down on paper, in order.</div><div class="words">'+grid+'</div>'
    +'<div class="warn">This is the ONLY way to restore your key if you lose this phone. Anyone who has it can sign as you. Never photograph it or store it online.</div>'
    +'<label class="chk"><input type="checkbox" id="ack"><span>I have written down my recovery phrase and stored it safely.</span></label>'
    +'<button id="go" class="btn">Continue</button>');
  document.getElementById('go').onclick=function(){ if(!document.getElementById('ack').checked){setStatus('Confirm you saved your phrase','err');return;} joinVerify(info,k,words); };
}
function joinVerify(info,k,words){
  var pos=(window.crypto.getRandomValues(new Uint32Array(1))[0])%words.length;
  h('<div class="msg">Quick check — type word <b>#'+(pos+1)+'</b> of your recovery phrase.</div><input id="wv" class="inp" autocapitalize="none" autocomplete="off" placeholder="word #'+(pos+1)+'"><button id="go" class="btn">Confirm</button><span id="sk" class="link">Show my phrase again</span>');
  document.getElementById('go').onclick=async function(){
    var v=(document.getElementById('wv').value||'').trim().toLowerCase();
    if(v!==words[pos]){setStatus('That word doesn’t match #'+(pos+1),'err');return;}
    setStatus(''); delete k.mnemonic; await setPinAndSave(k); await doJoin(info,{name:k.name,sec:k.sec,pub:k.pub});
  };
  document.getElementById('sk').onclick=function(){ joinBackup(info,k); };
}
function joinRestore(info){
  h('<div class="lab">Restore your key</div><div class="msg">Paste your 24-word recovery phrase.</div><textarea id="ph" class="inp" autocapitalize="none" autocomplete="off" placeholder="word1 word2 … word24"></textarea><button id="go" class="btn">Restore &amp; request to join</button><span id="bk" class="link">Back</span>');
  document.getElementById('go').onclick=async function(){
    var phrase=(document.getElementById('ph').value||'').trim(); if(!phrase){setStatus('Paste your phrase','err');return;}
    setStatus('Restoring…');
    try{ var k=restoreIdentity(info.name,phrase); await setPinAndSave(k); await doJoin(info,k); }
    catch(e){ setStatus(String(e&&e.message||e).replace(/^Error:\s*/,''),'err'); }
  };
  document.getElementById('bk').onclick=function(){ joinFlow(); };
}
async function doJoin(info,key){
  try{
    var sec=await getSecret(key);
    setStatus('Sending your request…');
    var proof=signStr(sec, TOKEN);
    var res=await api('/api/invite/join',{token:TOKEN,name:info.name,pubB64:key.pub,proof:proof});
    if(res.error){ h('<div class="msg">Couldn’t join: '+esc(res.error)+'</div>'); setStatus('Not joined','err'); return; }
    h('<div class="lab" style="text-align:center">Read this code to the approver</div><div class="code">'+esc(res.code)+'</div><div class="help" style="text-align:center;margin:0">They’ll see the same code on their phone and approve you.</div>');
    setStatus('Waiting for approval…','ok');
    pollJoin();
  }catch(e){ setStatus('Join failed: '+e,'err'); }
}
async function pollJoin(){
  for(var i=0;i<800;i++){
    try{
      var s=await api('/api/invite/status?t='+encodeURIComponent(TOKEN));
      if(s&&s.done){
        if(s.result&&s.result.ok){ okScreen('You’re in!','You’re now a signer on this project. Keep this phone — your approvals will appear here.'); setStatus('Joined','ok'); }
        else { h('<div class="msg">Not approved'+(s.result&&s.result.error?': '+esc(s.result.error):'')+'.</div><div class="help" style="margin:0">Ask the owner to try again, or for a fresh invite.</div>'); setStatus('Not approved','err'); }
        return;
      }
    }catch(e){ /* keep waiting */ }
    await sleep(1500);
  }
}
main();
})();
</script></body></html>`;
}

module.exports = { signerHTML };
