'use strict';
// Generate the flowchart — a self-contained, theme-aware HTML page painted from
// the manifest + verify results.
//
// Structure & flow (auto-derived from code, works for any project):
//  - Cells nest into MODULES (the exposed namespace: ES export / CommonJS / UMD
//    global / IIFE return — else the filename), then SUB-GROUPS (Public API vs
//    Internal, and each class / object literal), then units. Every level is
//    collapsible with a rolled-up health color — true zoom in/out.
//  - Module→module FLOW arrows come from the real call graph.
//  - Click a unit for its spec, code (offending lines red), and checks.

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function base(f) { return String(f || 'other').split('/').pop(); }

const COLORS = {
  GREEN: ['#1f9d57', 'Green'], YELLOW: ['#c9860f', 'Yellow'],
  RED: ['#cf4436', 'Red'], UNSIGNED: ['#7f8796', 'Unsigned'], PINK: ['#e0559b', 'Pink'],
};
const SEV = { GREEN: 1, YELLOW: 2, UNSIGNED: 3, PINK: 4, RED: 5 };
function rollup(items) { let s = 'GREEN'; for (const it of items) if (SEV[it.res.state] > SEV[s]) s = it.res.state; return s; }
function subOrder(s) { return s === 'Public API' ? 0 : s === 'Modules' ? 1 : s === 'Internal' ? 3 : s === 'module-level' ? 4 : 2; }

function detailInner(cell, res) {
  const [col, label] = COLORS[res.state];
  if (res.untracked) {
    return `<div class="mhead"><span class="mid">${esc(cell.id)}</span><span class="mname">${esc(res.name || cell.unitName || '')}</span><span class="mpill" style="color:${col}">${label}</span></div>
      <div class="dmeta"><span>untracked</span><span>${esc(res.file)}:${esc(res.line)}</span></div>
      <div class="dh" style="color:${col}">No formal specification</div>
      <div class="allok" style="color:${col};font-weight:600">◆ This code was never described in YayLayer or signed — it sits <em>outside</em> the system, where silent bugs hide.</div>
      <div class="allok" style="margin-top:8px">Run <code>yay adopt</code> to scaffold a spec above it, then prune &amp; sign it.</div>`;
  }
  const isModule = !!(cell.contains && cell.contains.length);
  const meta = [];
  meta.push(res.trust && res.trust.signed ? (res.trust.auto ? `AUTO · ${esc(res.trust.grant || 'grant')}` : `signed by ${esc(res.trust.signer)}`) : 'unsigned');
  meta.push(`spec ${esc((cell.specHash || '').slice(0, 12))}…`);
  if (cell.feeds && cell.feeds.length) meta.push(`feeds → ${esc(cell.feeds.join(', '))}`);
  meta.push(esc(`${cell.file}:${cell.line}`));
  const bad = new Set((res.badLines || []).map((s) => s.trim()));
  const codeHtml = (cell.unitBody || '').split('\n').map((l) => {
    const t = l.trim();
    return (t && bad.has(t)) ? `<span class="badline">${esc(l)}</span>` : esc(l);
  }).join('\n');
  const body = isModule
    ? `<div class="dh">Contains</div><pre class="code">${esc(cell.contains.join('\n'))}</pre>`
    : (cell.unitBody ? `<div class="dh">Code</div><pre class="code">${codeHtml}</pre>`
        : `<div class="dh">Code</div><div class="allok">no unit body found below the spec</div>`);
  const sym = { red: '✗', yellow: '⚠', info: '•' };
  const checks = (res.notes || []).length
    ? `<div class="dh">Checks</div><ul class="checks">${res.notes.map((n) => `<li class="ck-${n.level}">${sym[n.level] || '•'} ${esc(n.text)}</li>`).join('')}</ul>`
    : `<div class="dh">Checks</div><div class="allok" style="color:${col}">✓ all checks passed</div>`;
  return `<div class="mhead"><span class="mid">${esc(cell.id)}</span><span class="mname">${esc(cell.unitName || cell.spec.unit || cell.id)}</span><span class="mpill" style="color:${col}">${label}</span></div>
    <div class="dmeta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>
    <div class="dh">Sealed spec</div><pre class="code">${esc(cell.specBlock || '')}</pre>
    ${body}
    ${checks}`;
}

function renderMap(manifest, verified, project) {
  // tree: module → sub-group → items
  const tree = {}, modItems = {}, modFiles = {};
  for (const id of Object.keys(verified.results)) {
    const res = verified.results[id];
    const mc = manifest.cells[id];
    const cell = mc || {
      id, unitName: res.name || id, file: res.file, line: res.line, lang: res.lang,
      spec: { intent: res.untracked ? 'No formal specification — untracked code.' : '' },
      feeds: [], contains: [], specHash: '', specBlock: '', unitBody: null,
    };
    const file = res.file || cell.file || 'other';
    const module = (mc && mc.module) || res.module || base(file);
    const sub = (mc && mc.group) || res.group || 'Internal';
    (tree[module] = tree[module] || {});
    (tree[module][sub] = tree[module][sub] || []).push({ cell, res });
    (modItems[module] = modItems[module] || []).push({ cell, res });
    (modFiles[module] = modFiles[module] || new Set()).add(base(file));
  }
  const modules = Object.keys(tree).sort();
  const total = Object.keys(verified.results).length;
  const openMods = total <= 14;
  const modState = {}; modules.forEach((m) => { modState[m] = rollup(modItems[m]); });

  let idx = 0;
  const unitCard = ({ cell, res }) => {
    const [col, label] = COLORS[res.state];
    const domId = 'u' + (idx++);
    const who = res.untracked ? 'untracked' : (res.trust && res.trust.signed ? (res.trust.auto ? 'AUTO' : 'by ' + res.trust.signer) : 'unsigned');
    return `<button class="node" style="border-left-color:${col}" data-id="${domId}">
        <div class="top"><span class="id">${esc(cell.id)}</span><span class="pill" style="color:${col}">${label}</span></div>
        <div class="nm">${esc(cell.unitName || cell.spec.unit || cell.id)}</div>
        <div class="ds">${esc(cell.spec.intent || '')}</div>
        <div class="fe">${esc(who)}</div>
      </button>
      <div class="detail-src" id="${domId}" hidden>${detailInner(cell, res)}</div>`;
  };

  const moduleHtml = modules.map((m) => {
    const [mcol, mlabel] = COLORS[modState[m]];
    const subs = Object.keys(tree[m]).sort((a, b) => subOrder(a) - subOrder(b) || a.localeCompare(b));
    const fileList = [...modFiles[m]].join(', ');
    const count = modItems[m].length;
    const subHtml = subs.map((s) => {
      const items = tree[m][s];
      const [scol, slabel] = COLORS[rollup(items)];
      return `<div class="subgroup open">
        <button class="sub-head" style="border-left-color:${scol}">
          <span class="chev">▸</span><span class="sub-name">${esc(s)}</span>
          <span class="mod-spacer"></span><span class="sub-count">${items.length}</span>
          <span class="pill" style="color:${scol}">${slabel}</span>
        </button>
        <div class="sub-body">${items.map(unitCard).join('')}</div>
      </div>`;
    }).join('');
    return `<div class="module${openMods ? ' open' : ''}">
      <button class="mod-head" style="border-left-color:${mcol}">
        <span class="chev">▸</span>
        <span class="mod-name">${esc(m)}</span>
        <span class="mod-path">${esc(fileList)}</span>
        <span class="mod-spacer"></span>
        <span class="mod-count">${count} unit${count === 1 ? '' : 's'}</span>
        <span class="pill" style="color:${mcol}">${mlabel}</span>
      </button>
      <div class="mod-body">${subHtml}</div>
    </div>`;
  }).join('');

  const edges = (manifest.moduleEdges || []).filter(([a, b]) => tree[a] && tree[b]);
  const flow = edges.length ? `
    <div class="flow">
      <div class="flow-h">Module flow <span class="dim">— who calls whom (from the code)</span></div>
      <div class="flow-rows">${edges.map(([a, b]) => {
        const ca = COLORS[modState[a] || 'GREEN'][0], cb = COLORS[modState[b] || 'GREEN'][0];
        return `<div class="edge"><span class="fl" style="border-color:${ca}">${esc(a)}</span><span class="arr">→</span><span class="fl" style="border-color:${cb}">${esc(b)}</span></div>`;
      }).join('')}</div>
    </div>` : '';

  const c = verified.counts;
  const legend = Object.entries(COLORS).map(([k, [col, label]]) => `<span class="lg" style="color:${col}">${label} ${c[k] || 0}</span>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YayLayer map · ${esc(project || 'project')}</title>
<style>
:root{--paper:#F4F1EA;--card:#FBFAF6;--card2:#f1ede3;--ink:#1a1a21;--ink2:#4c4c58;--mut:#6f6f7a;--rule:#ddd8cd;--accent:#3d38a8;--code:#f3efe6;--red:#cf4436;--amber:#c9860f;
--mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}
@media(prefers-color-scheme:dark){:root{--paper:#131318;--card:#1b1b23;--card2:#20202a;--ink:#ECEAE3;--ink2:#b6b4c0;--mut:#8a8a96;--rule:#2b2b36;--accent:#9b96f6;--code:#15151c;--red:#e5695c;--amber:#e0a437;}}
:root[data-theme="light"]{--paper:#F4F1EA;--card:#FBFAF6;--card2:#f1ede3;--ink:#1a1a21;--ink2:#4c4c58;--mut:#6f6f7a;--rule:#ddd8cd;--accent:#3d38a8;--code:#f3efe6;--red:#cf4436;--amber:#c9860f;}
:root[data-theme="dark"]{--paper:#131318;--card:#1b1b23;--card2:#20202a;--ink:#ECEAE3;--ink2:#b6b4c0;--mut:#8a8a96;--rule:#2b2b36;--accent:#9b96f6;--code:#15151c;--red:#e5695c;--amber:#e0a437;}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.55}
.themebtn{position:fixed;top:14px;right:14px;font-family:var(--mono);font-size:.72rem;background:var(--card);color:var(--ink);border:1px solid var(--rule);border-radius:100px;padding:6px 12px;cursor:pointer;z-index:60}
.themebtn:hover{border-color:var(--accent)}
.wrap{max-width:1080px;margin:0 auto;padding:28px 22px}
h1{font-family:var(--mono);font-size:1.3rem;margin:0 0 4px}.sub{color:var(--mut);font-family:var(--mono);font-size:.8rem;margin:0 0 6px}
.hint{color:var(--mut);font-size:.82rem;margin:0 0 16px}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-family:var(--mono);font-size:.78rem;margin-bottom:18px}
.lg::before{content:"●";margin-right:6px}
.toolbar{display:flex;gap:10px;margin-bottom:16px}
.toolbar button{font-family:var(--mono);font-size:.72rem;background:var(--card);color:var(--ink2);border:1px solid var(--rule);border-radius:6px;padding:5px 10px;cursor:pointer}
.toolbar button:hover{border-color:var(--accent);color:var(--ink)}
.flow{background:var(--card2);border:1px solid var(--rule);border-radius:8px;padding:14px 16px;margin-bottom:20px}
.flow-h{font-family:var(--mono);font-size:.74rem;color:var(--ink);margin-bottom:10px}.flow-h .dim{color:var(--mut)}
.flow-rows{display:flex;gap:8px 16px;flex-wrap:wrap}
.edge{display:flex;align-items:center;gap:8px;font-family:var(--mono);font-size:.74rem}
.fl{border:1px solid var(--rule);border-left-width:3px;border-radius:5px;padding:3px 9px;background:var(--card)}
.arr{color:var(--accent)}
.module{border:1px solid var(--rule);border-radius:8px;margin-bottom:10px;overflow:hidden;background:var(--card)}
.mod-head{width:100%;display:flex;align-items:center;gap:10px;text-align:left;font:inherit;color:inherit;cursor:pointer;background:var(--card2);border:none;border-left:3px solid var(--mut);padding:12px 14px}
.mod-head:hover{filter:brightness(1.03)}
.chev{font-family:var(--mono);color:var(--mut);transition:transform .12s;display:inline-block}
.module.open>.mod-head .chev,.subgroup.open>.sub-head .chev{transform:rotate(90deg);color:var(--accent)}
.mod-name{font-family:var(--mono);font-weight:700;font-size:.95rem}
.mod-path{font-family:var(--mono);font-size:.66rem;color:var(--mut)}
.mod-spacer{flex:1}
.mod-count,.sub-count{font-family:var(--mono);font-size:.68rem;color:var(--mut)}
.pill{font-family:var(--mono);font-size:.62rem;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.mod-body{display:none;padding:8px 10px}.module.open>.mod-body{display:block}
.subgroup{border:1px solid var(--rule);border-radius:7px;margin:6px 0;overflow:hidden;background:var(--paper)}
.sub-head{width:100%;display:flex;align-items:center;gap:9px;text-align:left;font:inherit;color:inherit;cursor:pointer;background:var(--card);border:none;border-left:3px solid var(--mut);padding:8px 12px}
.sub-head:hover{filter:brightness(1.03)}
.sub-name{font-family:var(--mono);font-weight:600;font-size:.84rem}
.sub-body{display:none;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:9px;padding:10px}
.subgroup.open>.sub-body{display:grid}
.node{width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer;background:var(--card2);border:1px solid var(--rule);border-left:3px solid var(--mut);border-radius:6px;padding:9px 11px;transition:border-color .12s}
.node:hover{border-color:var(--accent)}
.top{display:flex;justify-content:space-between;align-items:center;gap:6px}
.id{font-family:var(--mono);font-size:.68rem;color:var(--accent);font-weight:600}
.nm{font-family:var(--mono);font-size:.84rem;font-weight:600;margin-top:4px;word-break:break-word}
.ds{font-size:.78rem;color:var(--ink2);margin-top:2px}
.fe{font-family:var(--mono);font-size:.64rem;color:var(--mut);margin-top:5px}
.detail-src{display:none}
.foot{margin-top:24px;font-family:var(--mono);font-size:.72rem;color:var(--mut)}
.dim{color:var(--mut)}
.modal{position:fixed;inset:0;z-index:50;display:none;padding:40px 16px;overflow:auto;background:rgba(10,10,15,.5)}
.modal.open{display:flex;align-items:flex-start;justify-content:center}
.modal-panel{position:relative;background:var(--paper);border:1px solid var(--rule);border-radius:12px;max-width:820px;width:100%;padding:22px 24px 26px;box-shadow:0 30px 90px -25px rgba(0,0,0,.6);max-height:calc(100vh - 80px);overflow:auto}
.modal-close{position:absolute;top:12px;right:12px;background:var(--card);border:1px solid var(--rule);border-radius:7px;color:var(--ink);width:30px;height:30px;cursor:pointer;font-size:.85rem}
.modal-close:hover{border-color:var(--accent)}
.mhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;padding-right:34px}
.mid{font-family:var(--mono);font-size:.8rem;color:var(--accent);font-weight:600}
.mname{font-family:var(--mono);font-size:1.05rem;font-weight:600;word-break:break-word}
.mpill{font-family:var(--mono);font-size:.64rem;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.dmeta{display:flex;gap:6px 12px;flex-wrap:wrap;font-family:var(--mono);font-size:.68rem;color:var(--mut);margin-bottom:6px}
.dh{font-family:var(--mono);font-size:.62rem;text-transform:uppercase;letter-spacing:.07em;color:var(--accent);margin:14px 0 5px}
pre.code{margin:0;background:var(--code);border:1px solid var(--rule);border-radius:6px;padding:11px 12px;overflow-x:auto;font-family:var(--mono);font-size:.78rem;line-height:1.6;white-space:pre;color:var(--ink)}
.badline{display:block;background:color-mix(in srgb,var(--red) 20%,transparent);color:var(--red);font-weight:700;border-radius:3px;margin:0 -4px;padding:0 4px}
.checks{margin:0;padding:0;list-style:none;font-size:.82rem}.checks li{margin:4px 0;line-height:1.45}
.ck-red{color:var(--red);font-weight:600}.ck-yellow{color:var(--amber)}.ck-info{color:var(--mut)}
.allok{font-size:.82rem;color:var(--mut)}
</style></head><body>
<button id="themebtn" class="themebtn" aria-label="Toggle light or dark theme">☾ Dark</button>
<div class="wrap">
<h1>YayLayer map · ${esc(project || 'project')}</h1>
<p class="sub">${total} units · ${modules.length} module${modules.length === 1 ? '' : 's'} · ${verified.passed ? 'gate PASS' : 'gate BLOCKED'}</p>
<p class="hint">Zoom: click a <b>module</b> to open its sub-groups (Public API / Internal / classes), and a <b>unit</b> for its spec, code &amp; checks. Arrows show module-to-module flow from the call graph.</p>
<div class="legend">${legend}</div>
${flow}
<div class="toolbar"><button id="expandAll">Expand all</button><button id="collapseAll">Collapse all</button></div>
${moduleHtml}
<div class="foot">Generated by <code>yay map</code> · modules → sub-groups → units, flow from the call graph · green = proven, pink = no spec.</div>
</div>
<div id="modal" class="modal" role="dialog" aria-modal="true"><div class="modal-panel"><button class="modal-close" aria-label="Close">✕</button><div class="modal-body"></div></div></div>
<script>
(function(){
  document.querySelectorAll('.mod-head').forEach(function(h){ h.addEventListener('click',function(){ h.parentNode.classList.toggle('open'); }); });
  document.querySelectorAll('.sub-head').forEach(function(h){ h.addEventListener('click',function(){ h.parentNode.classList.toggle('open'); }); });
  document.getElementById('expandAll').addEventListener('click',function(){ document.querySelectorAll('.module,.subgroup').forEach(function(m){m.classList.add('open');}); });
  document.getElementById('collapseAll').addEventListener('click',function(){ document.querySelectorAll('.module').forEach(function(m){m.classList.remove('open');}); });
})();
(function(){
  var modal=document.getElementById('modal'), body=modal.querySelector('.modal-body');
  function open(id){ var s=document.getElementById(id); if(!s) return; body.innerHTML=s.innerHTML; modal.classList.add('open'); document.body.style.overflow='hidden'; }
  function close(){ modal.classList.remove('open'); document.body.style.overflow=''; }
  document.querySelectorAll('.node[data-id]').forEach(function(n){ n.addEventListener('click',function(e){ e.stopPropagation(); open(this.getAttribute('data-id')); }); });
  modal.addEventListener('click',function(e){ if(e.target===modal) close(); });
  modal.querySelector('.modal-close').addEventListener('click',close);
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') close(); });
})();
(function(){
  var root=document.documentElement, btn=document.getElementById('themebtn');
  function sys(){ return matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'; }
  function current(){ return root.getAttribute('data-theme') || sys(); }
  function label(){ btn.textContent = current()==='dark' ? '☀ Light' : '☾ Dark'; }
  var saved; try{ saved=localStorage.getItem('yay-theme'); }catch(e){}
  if(saved){ root.setAttribute('data-theme', saved); }
  label();
  btn.addEventListener('click',function(){ var next=current()==='dark'?'light':'dark'; root.setAttribute('data-theme',next); try{localStorage.setItem('yay-theme',next);}catch(e){} label(); });
})();
</script>
</body></html>`;
}

module.exports = { renderMap };
