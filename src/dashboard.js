'use strict';
// `yay dashboard` — a persistent local control panel that serves the map LIVE:
// it re-reads the repo on every load, auto-refreshes when anything changes, and
// has a Refresh button. One long-running address instead of re-exporting a static
// file. (v2 will also route phone pair/sign through this same server so there's a
// single origin for everything; v1 is the live map.)

const http = require('http');
const os = require('os');

function lanIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) for (const i of ifaces[name] || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  return '127.0.0.1';
}
function sendJSON(res, status, obj) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); }
function sendHTML(res, html) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(html); }

// Inject an always-visible Refresh button + an auto-poller that reloads the page
// when the underlying state version changes.
function withLiveControls(mapHTML, version) {
  const bar = '<div id="yd-bar" style="position:fixed;right:14px;bottom:14px;z-index:99999;display:flex;gap:8px;align-items:center;font-family:ui-monospace,Menlo,monospace;font-size:12px">'
    + '<span id="yd-live" style="padding:5px 11px;border-radius:100px;background:#1f9d57;color:#fff;box-shadow:0 6px 20px -8px rgba(0,0,0,.4)">● live</span>'
    + '<button id="yd-refresh" style="padding:6px 13px;border-radius:100px;border:1px solid #3ecf8e;background:#3ecf8e;color:#04231a;font-weight:700;cursor:pointer;box-shadow:0 6px 20px -8px rgba(0,0,0,.4)">⟳ Refresh</button></div>';
  const js = '<script>(function(){var V=' + JSON.stringify(version) + ';'
    + 'document.getElementById("yd-refresh").onclick=function(){location.reload();};'
    + 'async function poll(){try{var r=await fetch("/api/version",{cache:"no-store"});var j=await r.json();'
    + 'if(j.v&&j.v!==V){var e=document.getElementById("yd-live");e.textContent="● updated — refreshing";e.style.background="#c9860f";setTimeout(function(){location.reload();},500);}'
    + '}catch(_){var e2=document.getElementById("yd-live");if(e2){e2.textContent="● server stopped";e2.style.background="#d92d20";}}}'
    + 'setInterval(poll,3000);})();</script>';
  return mapHTML.indexOf('</body>') >= 0 ? mapHTML.replace('</body>', bar + js + '</body>') : mapHTML + bar + js;
}

// deps: { buildMapHTML(): {html,count}, version(): string }
function startDashboard(deps, opts) {
  opts = opts || {};
  const handler = (req, res) => {
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && url === '/api/ping') return sendJSON(res, 200, { yay: 'dashboard' });
    if (req.method === 'GET' && url === '/api/version') { try { return sendJSON(res, 200, { v: deps.version() }); } catch (e) { return sendJSON(res, 200, { v: 'err' }); } }
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
    server.listen(port, '0.0.0.0', () => {
      resolve({ url: `${scheme}://${lanIP()}:${port}`, local: `${scheme}://localhost:${port}`, port, close: () => server.close() });
    });
  });
}

module.exports = { startDashboard, withLiveControls, lanIP };
