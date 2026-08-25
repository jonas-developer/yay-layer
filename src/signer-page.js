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

const fs = require('fs');
const path = require('path');
const NACL = fs.readFileSync(path.join(__dirname, 'vendor', 'tweetnacl.min.js'), 'utf8');
const RECOVERY = fs.readFileSync(path.join(__dirname, 'vendor', 'recovery.js'), 'utf8');

function signerHTML({ mode, project }) {
  const M = JSON.stringify(mode || 'pair');
  const P = JSON.stringify(project || 'project');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>YayLayer Signer</title>
<style>
:root{--bg:#ffffff;--card:#ffffff;--card2:#f7f8f9;--ink:#141414;--mut:#8a939b;--rule:#e6e8eb;--accent:#1a8f5f;--brand:#3ecf8e;--green:#1f9d57;--red:#d92d20;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
@media(prefers-color-scheme:dark){:root{--bg:#171717;--card:#1e1e1e;--card2:#212121;--ink:#ededed;--mut:#8a8a8a;--rule:#2b2b2b;--accent:#3ecf8e;--green:#3fbf77;--red:#ff6b6b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.5;
  min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 18px}
.top{width:100%;max-width:460px;margin-bottom:16px}
.brandrow{display:flex;align-items:center;gap:8px;margin-bottom:2px}
.logo{display:inline-flex;flex:none}
.brand{font-weight:700;font-size:.98rem;color:var(--ink)}
h1{font-size:1.3rem;margin:4px 0 0}.sub{color:var(--mut);font-size:.85rem;font-family:var(--mono)}
#app{width:100%;max-width:460px;background:var(--card);border:1px solid var(--rule);border-radius:16px;padding:20px}
.lbl{display:block;font-size:.8rem;color:var(--mut);margin:0 0 6px}
.inp{width:100%;font-size:1.05rem;padding:13px 14px;border-radius:11px;border:1px solid var(--rule);background:var(--bg);color:var(--ink);margin-bottom:14px}
.btn{width:100%;font-size:1.05rem;font-weight:700;padding:15px;border:none;border-radius:12px;background:var(--brand);color:#04231a;cursor:pointer}
.btn:active{filter:brightness(.92)}
.msg{color:var(--ink);font-size:.95rem;margin:0 0 14px}
.code{font-family:var(--mono);font-size:2.6rem;font-weight:700;letter-spacing:.12em;text-align:center;margin:6px 0 12px;color:var(--accent)}
.ok-big{font-size:1.6rem;font-weight:700;color:var(--green);text-align:center;margin:8px 0}
.cell{display:flex;align-items:flex-start;gap:10px;padding:11px 0;border-top:1px solid var(--rule)}
.cell:first-of-type{border-top:none}
.dot{width:10px;height:10px;border-radius:50%;flex:none;margin-top:5px}
.cid{font-family:var(--mono);font-size:.82rem;font-weight:600}
.cin{color:var(--mut);font-size:.85rem}
.col{margin-left:auto;font-family:var(--mono);font-size:.62rem;text-transform:uppercase;color:var(--mut)}
#status{width:100%;max-width:460px;margin-top:14px;font-family:var(--mono);font-size:.8rem;color:var(--mut);text-align:center;min-height:1.2em}
#status.ok{color:var(--green)}#status.err{color:var(--red)}
.btn.alt{background:transparent;color:var(--accent);border:1px solid var(--rule);margin-top:10px}
.link{display:inline-block;margin-top:14px;color:var(--accent);text-decoration:underline;cursor:pointer;font-size:.9rem}
.words{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px;margin:12px 0}
.word{font-family:var(--mono);font-size:.95rem;padding:9px 11px;background:var(--card2);border:1px solid var(--rule);border-radius:9px}
.word i{color:var(--mut);font-style:normal;margin-right:8px;display:inline-block;min-width:1.4em;text-align:right}
.warn{color:var(--red);font-size:.85rem;line-height:1.45;margin:10px 0}
.chk{display:flex;align-items:flex-start;gap:9px;font-size:.9rem;margin:12px 0}
.chk input{margin-top:3px;width:18px;height:18px;flex:none}
textarea.inp{min-height:96px;resize:vertical;font-family:var(--mono);font-size:.98rem}
</style></head><body>
<div class="top"><div class="brandrow"><span class="logo"><svg width="24" height="24" viewBox="0 0 26 26" aria-hidden="true"><rect width="26" height="26" rx="7" fill="#3ecf8e"/><path d="M6.5 13.5l4 4L20 7.5" fill="none" stroke="#04231a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="brand">YayLayer Signer</span></div><h1 id="ttl">Sign</h1><div class="sub" id="proj"></div></div>
<div id="app"><div class="msg">Loading…</div></div>
<div id="status"></div>
<script>${NACL}</script>
<script>${RECOVERY}</script>
<script>
(function(){
var MODE=${M}, PROJECT=${P};
var app=document.getElementById('app'), statusEl=document.getElementById('status');
document.getElementById('proj').textContent=PROJECT;
document.getElementById('ttl').textContent=(MODE==='pair'?'Pair this phone':MODE==='authorize'?'Authorize change':'Approve changes');
function setStatus(t,cls){statusEl.textContent=t;statusEl.className=cls||'';}
function h(html){app.innerHTML=html;}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
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
function signStr(secB64,str){return b64(nacl.sign.detached(ebytes(str),unb64(secB64)));}
async function api(path,body){var r=await fetch(path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return r.json();}

async function main(){
  if(!hasCrypto()){ h('<div class="msg">This browser is too old to sign here — it lacks <b>crypto.getRandomValues</b>. Try a current mobile browser.</div>'); return; }
  try{
    var sess=await api('/api/session');
    if(sess.mode==='pair') return pairFlow(sess);
    if(sess.mode==='approve') return approveFlow(sess);
    if(sess.mode==='authorize') return authorizeFlow(sess);
    h('<div class="msg">Nothing to do right now.</div>');
  }catch(e){ setStatus('Could not reach the laptop — still waiting? '+e,'err'); }
}
function pairFlow(sess){
  var key=loadKey();
  var note=sess.genesis?'<div class="msg" style="color:var(--accent)">This phone will become the project’s <b>trust root</b> — no key is stored on the computer.</div>':'';
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
  h('<div class="msg"><b>Your recovery phrase</b> — write these 24 words down on paper, in order.</div>'
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
    setStatus(''); delete k.mnemonic; saveKey({name:k.name,sec:k.sec,pub:k.pub}); await doPair(sess,{name:k.name,sec:k.sec,pub:k.pub});
  };
  document.getElementById('sk').onclick=function(){showBackup(sess,k);};
}
// Re-enter the flow for the current mode after the key is available.
function dispatch(sess){ if(sess.mode==='approve') return approveFlow(sess); if(sess.mode==='authorize') return authorizeFlow(sess); return pairFlow(sess); }
// Restore an existing identity by pasting its written-down phrase. Works from ANY
// mode (pair / approve / authorize) — after restoring it continues that flow.
function restoreFlow(sess){
  h('<div class="msg"><b>Restore your key</b> — paste your 24-word recovery phrase.</div>'
    +'<label class="lbl">Your name (as shown on your signatures)</label><input id="nm" class="inp" placeholder="e.g. Alex Doe" autocapitalize="words">'
    +'<label class="lbl">Recovery phrase</label><textarea id="ph" class="inp" autocapitalize="none" autocomplete="off" placeholder="word1 word2 … word24"></textarea>'
    +'<button id="go" class="btn">Restore key</button><span id="bk" class="link">Back</span>');
  document.getElementById('go').onclick=async function(){
    var name=(document.getElementById('nm').value||'').trim(); if(!name){setStatus('Enter your name','err');return;}
    var phrase=(document.getElementById('ph').value||'').trim(); if(!phrase){setStatus('Paste your phrase','err');return;}
    setStatus('Restoring your key…');
    try{ var k=restoreIdentity(name,phrase); saveKey(k); setStatus('Key restored','ok'); if(sess.mode==='pair'){ await doPair(sess,k); } else { dispatch(sess); } }
    catch(e){ setStatus(String(e&&e.message||e).replace(/^Error:\\s*/,''),'err'); }
  };
  document.getElementById('bk').onclick=function(){dispatch(sess);};
}
async function doPair(sess,key){
  setStatus('Pairing…');
  try{
    var proof;
    if(sess.genesis){
      // No trust root yet → this phone BECOMES it. Self-sign the genesis event
      // (canonical() here matches the laptop's eventBytes exactly).
      var g=sess.genesis;
      var ev={id:g.id,type:g.type,name:key.name,pub:key.pub,role:g.role,by:key.name,prev:g.prev,nonce:g.nonce,at:g.at};
      proof=signStr(key.sec,canonical(ev));
    }else{
      proof=signStr(key.sec,sess.challenge);
    }
    var res=await api('/api/submit',{name:key.name,pubB64:key.pub,proof:proof});
    if(res.error){ setStatus('Rejected: '+res.error,'err'); return; }
    h('<div class="msg">Confirm this code matches the one on your laptop:</div><div class="code">'+esc(res.code)+'</div><div class="msg">Then approve it on the laptop.</div>');
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
        if(s.final.ok){ h('<div class="ok-big">✓ Paired</div><div class="msg">'+esc(s.final.message||'Done — you can close this.')+'</div>'); setStatus('Paired','ok'); }
        else { h('<div class="msg">Pairing wasn’t completed'+(s.final.reason?': '+esc(s.final.reason):'')+'.</div><div class="msg">Start again with <b>yay pair</b> on the laptop.</div>'); setStatus('Not paired','err'); }
        return;
      }
    }catch(e){ return; } // server closed after finishing — stop quietly
    await sleep(1500);
  }
}
function approveFlow(sess){
  var key=loadKey();
  if(!key){ h('<div class="msg">This phone has no key on this page yet — restore it from your recovery phrase, or run <b>yay pair</b>.</div><button id="rst" class="btn">Restore from recovery phrase</button>'); document.getElementById('rst').onclick=function(){restoreFlow(sess);}; return; }
  var rows=(sess.summary||[]).map(function(c){return '<div class="cell"><span class="dot" style="background:'+(c.color||'#888')+'"></span><div><div class="cid">'+esc(c.id)+' · '+esc(c.unit||'')+'</div><div class="cin">'+esc(c.intent||'')+'</div></div><span class="col">'+esc(c.state||'')+'</span></div>';}).join('');
  h('<div class="msg">Approve these <b>'+((sess.summary||[]).length)+'</b> change(s):</div>'+rows+'<button id="go" class="btn" style="margin-top:16px">Approve &amp; sign</button>');
  document.getElementById('go').onclick=async function(){
    setStatus('Signing…');
    try{
      var sig=signStr(key.sec,canonical(sess.approval));
      var res=await api('/api/submit',{signature:sig});
      if(res.error){ setStatus('Rejected: '+res.error,'err'); return; }
      h('<div class="ok-big">✓ Signed</div><div class="msg">Done — you can close this. The laptop has the seal.</div>');
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
    setStatus('Signing…');
    try{
      var sig=signStr(key.sec,canonical(sess.event));
      var res=await api('/api/submit',{signature:sig});
      if(res.error){ setStatus('Rejected: '+res.error,'err'); return; }
      h('<div class="ok-big">✓ Authorized</div><div class="msg">Done — you can close this. The laptop has the signed event.</div>');
      setStatus('Authorized','ok');
    }catch(e){ setStatus('Signing failed: '+e,'err'); }
  };
}
main();
})();
</script></body></html>`;
}

module.exports = { signerHTML };
