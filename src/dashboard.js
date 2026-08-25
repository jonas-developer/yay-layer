'use strict';
// `yay dashboard` — a persistent local control panel. Serves the map LIVE
// (auto-refresh + Refresh button) and hosts on-demand ACTIONS that a static map
// can't: run the project's test suite, and regenerate the System Plan (an LLM call,
// so never automatic). Mutating/executing actions are gated to localhost — anyone
// on the Wi-Fi can VIEW the map, but only this machine can run tests / spend LLM
// tokens. (v-next: route phone pair/sign through here too, for one origin.)

const http = require('http');
const os = require('os');

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

// Inject the live controls (Refresh + Run tests + Regenerate plan) + a results panel
// + an auto-poller that reloads the page when the underlying state version changes.
function withLiveControls(mapHTML, version) {
  const bar = '<div id="yd-bar" style="position:fixed;right:14px;bottom:14px;z-index:99999;display:flex;gap:8px;align-items:center;font-family:ui-monospace,Menlo,monospace;font-size:12px">'
    + '<span id="yd-live" style="padding:5px 11px;border-radius:100px;background:#1f9d57;color:#fff;box-shadow:0 6px 20px -8px rgba(0,0,0,.4)">● live</span>'
    + '<button class="yd-btn" id="yd-diffs">≷ Changes</button>'
    + '<button class="yd-btn" id="yd-tests">▶ Run tests</button>'
    + '<button class="yd-btn" id="yd-adv">⚔ Adversary</button>'
    + '<button class="yd-btn" id="yd-plan">⟲ System Plan</button>'
    + '<button class="yd-btn yd-primary" id="yd-refresh">⟳ Refresh</button></div>'
    + '<div id="yd-panel" style="display:none;position:fixed;left:14px;right:14px;bottom:60px;max-height:52vh;overflow:auto;z-index:99999;background:#0f1115;color:#e6e6e6;border:1px solid #2b2b2b;border-radius:12px;box-shadow:0 24px 60px -20px rgba(0,0,0,.6);font-family:ui-monospace,Menlo,monospace;font-size:12.5px">'
    + '<div id="yd-phead" style="display:flex;justify-content:space-between;align-items:center;padding:10px 14px;border-bottom:1px solid #2b2b2b;position:sticky;top:0;background:#0f1115"><b id="yd-ptitle">Output</b><button class="yd-btn" id="yd-close" style="padding:3px 10px">✕ close</button></div>'
    + '<pre id="yd-pout" style="margin:0;padding:12px 14px;white-space:pre-wrap;word-break:break-word"></pre></div>'
    + '<style>.yd-btn{padding:6px 12px;border-radius:100px;border:1px solid #3ecf8e;background:transparent;color:#159a63;font-weight:700;cursor:pointer;font-family:inherit;font-size:12px;box-shadow:0 6px 20px -10px rgba(0,0,0,.4)}.yd-btn.yd-primary{background:#3ecf8e;color:#04231a;border-color:#3ecf8e}.yd-btn:active{filter:brightness(.93)}</style>';
  const js = '<script>(function(){var V=' + JSON.stringify(version) + ';'
    + 'var live=document.getElementById("yd-live"),panel=document.getElementById("yd-panel"),pout=document.getElementById("yd-pout"),ptitle=document.getElementById("yd-ptitle");'
    + 'function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(m){return m==="&"?"&amp;":m==="<"?"&lt;":"&gt;";});}'
    + 'function show(t,txt,cls){ptitle.textContent=t;pout.textContent=txt;pout.style.color=cls==="ok"?"#3fbf77":cls==="err"?"#ff6b6b":"#e6e6e6";panel.style.display="block";}'
    + 'document.getElementById("yd-close").onclick=function(){panel.style.display="none";};'
    + 'document.getElementById("yd-refresh").onclick=function(){location.reload();};'
    + 'document.getElementById("yd-diffs").onclick=async function(){ptitle.textContent="Spec changes since last commit";pout.style.color="#e6e6e6";pout.textContent="loading…";panel.style.display="block";try{var j=await fetch("/api/diffs").then(function(r){return r.json();});if(!j.diffs||!j.diffs.length){pout.textContent="No spec changes since the last commit (working tree matches HEAD).";return;}pout.innerHTML=j.diffs.map(function(c){var lines=c.diff.map(function(d){var col=d.t==="+"?"#3fbf77":d.t==="-"?"#ff6b6b":"#8a8a8a";var pre=d.t==="+"?"+ ":d.t==="-"?"- ":"  ";return "<div style=\\"color:"+col+"\\">"+esc(pre+d.text)+"</div>";}).join("");return "<div style=\\"margin:0 0 16px\\"><div style=\\"color:#e6e6e6;font-weight:700;margin-bottom:5px\\">"+esc(c.id+(c.unit?" · "+c.unit:"")+"   "+c.file)+"</div>"+lines+"</div>";}).join("");}catch(e){pout.textContent="Could not load diffs: "+e;}};'
    + 'document.getElementById("yd-adv").onclick=async function(){if(!confirm("Run the spec-only adversary? An LLM writes probes from the specs (never the code) and runs them — costs tokens."))return;show("Adversary","Writing probes from the specs and running them… (a few seconds)");try{var r=await fetch("/api/adversary/run",{method:"POST"});if(r.status===403){show("Adversary","Run this on THIS computer (localhost).","err");return;}var j=await r.json();if(j.error){show("Adversary","✗ "+j.error,"err");return;}var rows=(j.results||[]);var broke=rows.filter(function(x){return x.status==="broke";});var html=rows.map(function(x){var col=x.status==="broke"?"#ff6b6b":x.status==="survived"?"#3fbf77":"#c9860f";var msg=x.status==="broke"?("BROKE: "+x.counterexample):x.status==="survived"?"survived":(x.reason||x.status);return "<div style=\\"color:"+col+"\\">"+esc((x.status==="broke"?"✗ ":x.status==="survived"?"✓ ":"– ")+x.id+" "+(x.unit||"")+" — "+msg)+"</div>";}).join("")||"No eligible Cells (need a leaf unit with ensures/out/throws).";ptitle.textContent="Adversary — "+broke.length+" broke / "+rows.length+" probed";pout.style.color="#e6e6e6";pout.innerHTML=html;panel.style.display="block";}catch(e){show("Adversary","Could not run: "+e,"err");}};'
    + 'document.getElementById("yd-tests").onclick=async function(){show("Tests","Running the project test suite…");try{var r=await fetch("/api/tests/run",{method:"POST"});if(r.status===403){show("Tests","Run tests from the dashboard on THIS computer (localhost) — not from the phone.","err");return;}var j=await r.json();show("Tests "+(j.configured?(j.ok?"✓ passed":"✗ failed (exit "+j.code+")"):""),(j.cmd?("$ "+j.cmd+"\\n\\n"):"")+(j.output||""),j.configured?(j.ok?"ok":"err"):"");}catch(e){show("Tests","Could not run: "+e,"err");}};'
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
  const handler = async (req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/api/ping') return sendJSON(res, 200, { yay: 'dashboard' });
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
    if (req.method === 'GET' && (url === '/' || url === '/index.html' || url === '/map')) {
      try { const m = deps.buildMapHTML(); return sendHTML(res, withLiveControls(m.html, deps.version())); }
      catch (e) { return sendHTML(res, '<pre style="font-family:monospace;padding:24px;color:#d92d20">map build error:\n' + String((e && e.stack) || e).replace(/[<&]/g, '_') + '</pre>'); }
    }
    sendJSON(res, 404, { error: 'not found' });
  };
  const tls = opts.tls;
  const server = tls ? require('https').createServer({ key: tls.key, cert: tls.cert }, handler) : http.createServer(handler);
  const scheme = tls ? 'https' : 'http';
  const port = opts.port || 48757;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => resolve({ url: `${scheme}://${lanIP()}:${port}`, local: `${scheme}://localhost:${port}`, port, close: () => server.close() }));
  });
}

module.exports = { startDashboard, withLiveControls, lanIP };
