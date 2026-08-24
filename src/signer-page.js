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
</style></head><body>
<div class="top"><div class="brandrow"><span class="logo"><svg width="24" height="24" viewBox="0 0 26 26" aria-hidden="true"><rect width="26" height="26" rx="7" fill="#3ecf8e"/><path d="M6.5 13.5l4 4L20 7.5" fill="none" stroke="#04231a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="brand">YayLayer Signer</span></div><h1 id="ttl">Sign</h1><div class="sub" id="proj"></div></div>
<div id="app"><div class="msg">Loading…</div></div>
<div id="status"></div>
<script>${NACL}</script>
<script>
(function(){
var MODE=${M}, PROJECT=${P};
var app=document.getElementById('app'), statusEl=document.getElementById('status');
document.getElementById('proj').textContent=PROJECT;
document.getElementById('ttl').textContent=(MODE==='pair'?'Pair this phone':'Approve changes');
function setStatus(t,cls){statusEl.textContent=t;statusEl.className=cls||'';}
function h(html){app.innerHTML=html;}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
var SPKI=new Uint8Array([48,42,48,5,6,3,43,101,112,3,33,0]); // ed25519 SPKI header (so the raw key matches Node's SPKI-DER)
function b64(buf){var b=new Uint8Array(buf),s='';for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s);}
function unb64(s){var bin=atob(s),a=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return a;}
function ebytes(str){return new TextEncoder().encode(str);}
function canonical(o){if(o===null||typeof o!=='object')return JSON.stringify(o);if(Array.isArray(o))return '['+o.map(canonical).join(',')+']';var k=Object.keys(o).sort(),p=[];for(var i=0;i<k.length;i++)p.push(JSON.stringify(k[i])+':'+canonical(o[k[i]]));return '{'+p.join(',')+'}';}
function hasCrypto(){return typeof nacl!=='undefined' && window.crypto && typeof window.crypto.getRandomValues==='function';}
function loadKey(){try{return JSON.parse(localStorage.getItem('yay.key')||'null');}catch(e){return null;}}
function saveKey(o){localStorage.setItem('yay.key',JSON.stringify(o));}
function genKeypair(){var kp=nacl.sign.keyPair();var spki=new Uint8Array(SPKI.length+kp.publicKey.length);spki.set(SPKI);spki.set(kp.publicKey,SPKI.length);return {pub:b64(spki),sec:b64(kp.secretKey)};}
function signStr(secB64,str){return b64(nacl.sign.detached(ebytes(str),unb64(secB64)));}
async function api(path,body){var r=await fetch(path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return r.json();}

async function main(){
  if(!hasCrypto()){ h('<div class="msg">This browser is too old to sign here — it lacks <b>crypto.getRandomValues</b>. Try a current mobile browser.</div>'); return; }
  try{
    var sess=await api('/api/session');
    if(sess.mode==='pair') return pairFlow(sess);
    if(sess.mode==='approve') return approveFlow(sess);
    h('<div class="msg">Nothing to do right now.</div>');
  }catch(e){ setStatus('Could not reach the laptop — still waiting? '+e,'err'); }
}
function pairFlow(sess){
  var key=loadKey();
  if(key){ h('<div class="msg">Key ready for <b>'+esc(key.name)+'</b> on this device.</div><button id="go" class="btn">Pair this device</button>'); document.getElementById('go').onclick=function(){doPair(sess,key);}; return; }
  h('<label class="lbl">Your name (shown on every signature)</label><input id="nm" class="inp" placeholder="e.g. Alex Doe" autocapitalize="words"><button id="go" class="btn">Create key &amp; pair</button>');
  document.getElementById('go').onclick=async function(){
    var name=(document.getElementById('nm').value||'').trim(); if(!name){setStatus('Enter a name','err');return;}
    setStatus('Generating your key…');
    try{ var k=genKeypair(); k.name=name; saveKey(k); await doPair(sess,k); }catch(e){ setStatus('Key generation failed: '+e,'err'); }
  };
}
async function doPair(sess,key){
  setStatus('Pairing…');
  try{
    var proof=signStr(key.sec,sess.challenge);
    var res=await api('/api/submit',{name:key.name,pubB64:key.pub,proof:proof});
    if(res.error){ setStatus('Rejected: '+res.error,'err'); return; }
    h('<div class="msg">Confirm this code matches the one on your laptop:</div><div class="code">'+esc(res.code)+'</div><div class="msg">Then approve it on the laptop.</div>');
    setStatus('Waiting for the laptop…','ok');
  }catch(e){ setStatus('Pairing failed: '+e,'err'); }
}
function approveFlow(sess){
  var key=loadKey();
  if(!key){ h('<div class="msg">This phone has no key yet — run <b>yay pair</b> first.</div>'); return; }
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
main();
})();
</script></body></html>`;
}

module.exports = { signerHTML };
