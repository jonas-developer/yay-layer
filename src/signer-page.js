'use strict';
// The phone signer — a self-contained page served by `yay pair` / `yay sign --phone`.
// The key is generated and kept ON THE PHONE (WebCrypto Ed25519, stored locally);
// the laptop only receives the public key and signatures. Formats match
// src/crypto.js: public key = base64 SPKI-DER, signature = base64 raw ed25519 over
// canonical(approval) — so `yay verify` checks it like any other seal.
//
// NOTE: WebCrypto signing needs a secure context (https or localhost). Over a plain
// http LAN address `crypto.subtle` is undefined; the page detects that and says so.

function signerHTML({ mode, project }) {
  const M = JSON.stringify(mode || 'pair');
  const P = JSON.stringify(project || 'project');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>YayLayer Signer</title>
<style>
:root{--bg:#111218;--card:#1b1c25;--ink:#ECEAE3;--mut:#9a9aa6;--rule:#2c2d3a;--accent:#9b96f6;--green:#3fbf77;--red:#e5695c;--mono:ui-monospace,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media(prefers-color-scheme:light){:root{--bg:#F4F1EA;--card:#fff;--ink:#1a1a21;--mut:#6f6f7a;--rule:#e3ded3;--accent:#3d38a8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.5;
  min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px 18px}
.top{width:100%;max-width:460px;margin-bottom:16px}
.brand{font-family:var(--mono);font-size:.72rem;letter-spacing:.18em;text-transform:uppercase;color:var(--accent)}
h1{font-size:1.3rem;margin:4px 0 0}.sub{color:var(--mut);font-size:.85rem;font-family:var(--mono)}
#app{width:100%;max-width:460px;background:var(--card);border:1px solid var(--rule);border-radius:16px;padding:20px}
.lbl{display:block;font-size:.8rem;color:var(--mut);margin:0 0 6px}
.inp{width:100%;font-size:1.05rem;padding:13px 14px;border-radius:11px;border:1px solid var(--rule);background:var(--bg);color:var(--ink);margin-bottom:14px}
.btn{width:100%;font-size:1.05rem;font-weight:600;padding:15px;border:none;border-radius:12px;background:var(--accent);color:#fff;cursor:pointer}
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
<div class="top"><div class="brand">YayLayer · Signer</div><h1 id="ttl">Sign</h1><div class="sub" id="proj"></div></div>
<div id="app"><div class="msg">Loading…</div></div>
<div id="status"></div>
<script>
(function(){
var MODE=${M}, PROJECT=${P};
var app=document.getElementById('app'), statusEl=document.getElementById('status');
document.getElementById('proj').textContent=PROJECT;
document.getElementById('ttl').textContent=(MODE==='pair'?'Pair this phone':'Approve changes');
function setStatus(t,cls){statusEl.textContent=t;statusEl.className=cls||'';}
function h(html){app.innerHTML=html;}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function b64(buf){var b=new Uint8Array(buf),s='';for(var i=0;i<b.length;i++)s+=String.fromCharCode(b[i]);return btoa(s);}
function unb64(s){var bin=atob(s),a=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)a[i]=bin.charCodeAt(i);return a.buffer;}
function ebytes(str){return new TextEncoder().encode(str);}
function canonical(o){if(o===null||typeof o!=='object')return JSON.stringify(o);if(Array.isArray(o))return '['+o.map(canonical).join(',')+']';var k=Object.keys(o).sort(),p=[];for(var i=0;i<k.length;i++)p.push(JSON.stringify(k[i])+':'+canonical(o[k[i]]));return '{'+p.join(',')+'}';}
function hasCrypto(){return !!(window.crypto&&window.crypto.subtle&&window.isSecureContext);}
function loadKey(){try{return JSON.parse(localStorage.getItem('yay.key')||'null');}catch(e){return null;}}
function saveKey(o){localStorage.setItem('yay.key',JSON.stringify(o));}
async function genKeypair(){var kp=await crypto.subtle.generateKey({name:'Ed25519'},true,['sign','verify']);return {pub:b64(await crypto.subtle.exportKey('spki',kp.publicKey)),priv:b64(await crypto.subtle.exportKey('pkcs8',kp.privateKey))};}
async function signStr(privB64,str){var pk=await crypto.subtle.importKey('pkcs8',unb64(privB64),{name:'Ed25519'},false,['sign']);return b64(await crypto.subtle.sign('Ed25519',pk,ebytes(str)));}
async function api(path,body){var r=await fetch(path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return r.json();}

async function main(){
  if(!hasCrypto()){ h('<div class="msg">This page can\\'t sign here because the browser only allows the signing API over a <b>secure connection</b>.<br><br>Open it via <b>https</b>, or on this same computer at <b>http://localhost</b>. A plain http LAN address disables it.</div>'); return; }
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
  h('<label class="lbl">Your name (shown on every signature)</label><input id="nm" class="inp" placeholder="e.g. Jonas" autocapitalize="words"><button id="go" class="btn">Create key &amp; pair</button>');
  document.getElementById('go').onclick=async function(){
    var name=(document.getElementById('nm').value||'').trim(); if(!name){setStatus('Enter a name','err');return;}
    setStatus('Generating your key…');
    try{ var k=await genKeypair(); k.name=name; saveKey(k); await doPair(sess,k); }catch(e){ setStatus('Key generation failed: '+e,'err'); }
  };
}
async function doPair(sess,key){
  setStatus('Pairing…');
  try{
    var proof=await signStr(key.priv,sess.challenge);
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
      var sig=await signStr(key.priv,canonical(sess.approval));
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
