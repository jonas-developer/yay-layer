'use strict';
// Generate the flowchart — a self-contained, theme-aware HTML page painted from
// the manifest + verify results. Green = proven, Yellow = flagged, Red = mismatch,
// Unsigned = awaiting signature.
//
// Click any Cell to open a popup with its sealed spec block, the code it governs
// (or, for a module, what it contains), and the exact verify checks. Click the
// sides or press Esc to close; click another Cell to swap. Light/dark toggle top-right.

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const COLORS = {
  GREEN: ['#1f9d57', 'Green'], YELLOW: ['#c9860f', 'Yellow'],
  RED: ['#cf4436', 'Red'], UNSIGNED: ['#7f8796', 'Unsigned'],
};

function detailInner(cell, res) {
  const [col, label] = COLORS[res.state];
  const isModule = !!(cell.contains && cell.contains.length);
  const meta = [];
  meta.push(res.trust && res.trust.signed ? (res.trust.auto ? `AUTO · ${esc(res.trust.grant || 'grant')}` : `signed by ${esc(res.trust.signer)}`) : 'unsigned');
  meta.push(`spec ${esc(cell.specHash.slice(0, 12))}…`);
  if (cell.feeds && cell.feeds.length) meta.push(`feeds → ${esc(cell.feeds.join(', '))}`);
  meta.push(esc(`${cell.file}:${cell.line}`));

  const body = isModule
    ? `<div class="dh">Contains</div><pre class="code">${esc(cell.contains.join('\n'))}</pre>`
    : (cell.unitBody
        ? `<div class="dh">Code</div><pre class="code">${esc(cell.unitBody)}</pre>`
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
  const byLang = {};
  for (const id of Object.keys(manifest.cells)) {
    const cell = manifest.cells[id];
    const lang = cell.lang || 'other';
    (byLang[lang] = byLang[lang] || []).push({ cell, res: verified.results[id] });
  }

  const card = ({ cell, res }) => {
    const [col, label] = COLORS[res.state];
    const who = res.trust && res.trust.signed ? (res.trust.auto ? 'AUTO' : 'by ' + res.trust.signer) : 'unsigned';
    const feeds = (cell.feeds || []).length ? `feeds → ${esc(cell.feeds.join(', '))}` : '';
    const kind = (cell.contains && cell.contains.length) ? ' · module' : '';
    return `<button class="node" style="border-left-color:${col}" data-id="${esc(cell.id)}">
        <div class="top"><span class="id">${esc(cell.id)}${kind}</span><span class="tr"><span class="pill" style="color:${col}">${label}</span><span class="chev">⤢</span></span></div>
        <div class="nm">${esc(cell.unitName || cell.spec.unit || cell.id)}</div>
        <div class="ds">${esc(cell.spec.intent || '')}</div>
        <div class="fe">${feeds}${feeds && who ? ' · ' : ''}${esc(who)}</div>
      </button>
      <div class="detail-src" id="d-${esc(cell.id)}" hidden>${detailInner(cell, res)}</div>`;
  };

  const layers = Object.keys(byLang).sort().map((lang) => `
    <div class="layer"><div class="ll">${esc(lang)}</div>
      <div class="nodes">${byLang[lang].map(card).join('')}</div></div>`).join('');

  const c = verified.counts;
  const legend = Object.entries(COLORS).map(([k, [col, label]]) =>
    `<span class="lg" style="color:${col}">${label} ${c[k]}</span>`).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YayLayer map · ${esc(project || 'project')}</title>
<style>
:root{--paper:#F4F1EA;--card:#FBFAF6;--ink:#1a1a21;--ink2:#4c4c58;--mut:#6f6f7a;--rule:#ddd8cd;--accent:#3d38a8;--code:#f3efe6;--red:#cf4436;--amber:#c9860f;
--mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}
@media(prefers-color-scheme:dark){:root{--paper:#131318;--card:#1b1b23;--ink:#ECEAE3;--ink2:#b6b4c0;--mut:#8a8a96;--rule:#2b2b36;--accent:#9b96f6;--code:#15151c;--red:#e5695c;--amber:#e0a437;}}
:root[data-theme="light"]{--paper:#F4F1EA;--card:#FBFAF6;--ink:#1a1a21;--ink2:#4c4c58;--mut:#6f6f7a;--rule:#ddd8cd;--accent:#3d38a8;--code:#f3efe6;--red:#cf4436;--amber:#c9860f;}
:root[data-theme="dark"]{--paper:#131318;--card:#1b1b23;--ink:#ECEAE3;--ink2:#b6b4c0;--mut:#8a8a96;--rule:#2b2b36;--accent:#9b96f6;--code:#15151c;--red:#e5695c;--amber:#e0a437;}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.55}
.themebtn{position:fixed;top:14px;right:14px;font-family:var(--mono);font-size:.72rem;background:var(--card);color:var(--ink);border:1px solid var(--rule);border-radius:100px;padding:6px 12px;cursor:pointer;z-index:60}
.themebtn:hover{border-color:var(--accent)}
.wrap{max-width:1080px;margin:0 auto;padding:28px 22px}
h1{font-family:var(--mono);font-size:1.3rem;margin:0 0 4px}.sub{color:var(--mut);font-family:var(--mono);font-size:.8rem;margin:0 0 6px}
.hint{color:var(--mut);font-size:.82rem;margin:0 0 18px}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-family:var(--mono);font-size:.78rem;margin-bottom:22px}
.lg::before{content:"●";margin-right:6px}
.layer{display:grid;grid-template-columns:120px 1fr;gap:14px;margin-bottom:14px}
.ll{font-family:var(--mono);font-size:.74rem;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);padding-top:10px;border-right:1px solid var(--rule)}
.nodes{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:11px;align-items:start}
@media(max-width:620px){.layer{grid-template-columns:1fr}.ll{border-right:none;border-bottom:1px solid var(--rule);padding:0 0 6px}}
.node{width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer;background:var(--card);border:1px solid var(--rule);border-left:3px solid var(--mut);border-radius:6px;padding:11px 13px;transition:border-color .12s,transform .05s}
.node:hover{border-color:var(--accent)}.node:active{transform:translateY(1px)}
.top{display:flex;justify-content:space-between;align-items:center}
.tr{display:flex;align-items:center;gap:8px}
.chev{font-family:var(--mono);color:var(--mut);font-size:.8rem}
.node:hover .chev{color:var(--accent)}
.id{font-family:var(--mono);font-size:.72rem;color:var(--accent);font-weight:600}
.pill{font-family:var(--mono);font-size:.64rem;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.nm{font-family:var(--mono);font-size:.9rem;font-weight:600;margin-top:5px}
.ds{font-size:.82rem;color:var(--ink2);margin-top:2px}
.fe{font-family:var(--mono);font-size:.66rem;color:var(--mut);margin-top:6px}
.detail-src{display:none}
.foot{margin-top:26px;font-family:var(--mono);font-size:.72rem;color:var(--mut)}
/* modal */
.modal{position:fixed;inset:0;z-index:50;display:none;padding:40px 16px;overflow:auto;background:rgba(10,10,15,.5)}
.modal.open{display:flex;align-items:flex-start;justify-content:center}
.modal-panel{position:relative;background:var(--paper);border:1px solid var(--rule);border-radius:12px;max-width:820px;width:100%;padding:22px 24px 26px;box-shadow:0 30px 90px -25px rgba(0,0,0,.6);max-height:calc(100vh - 80px);overflow:auto}
.modal-close{position:absolute;top:12px;right:12px;background:var(--card);border:1px solid var(--rule);border-radius:7px;color:var(--ink);width:30px;height:30px;cursor:pointer;font-size:.85rem;line-height:1}
.modal-close:hover{border-color:var(--accent)}
.mhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;padding-right:34px}
.mid{font-family:var(--mono);font-size:.8rem;color:var(--accent);font-weight:600}
.mname{font-family:var(--mono);font-size:1.05rem;font-weight:600}
.mpill{font-family:var(--mono);font-size:.64rem;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.dmeta{display:flex;gap:6px 12px;flex-wrap:wrap;font-family:var(--mono);font-size:.68rem;color:var(--mut);margin-bottom:6px}
.dh{font-family:var(--mono);font-size:.62rem;text-transform:uppercase;letter-spacing:.07em;color:var(--accent);margin:14px 0 5px}
pre.code{margin:0;background:var(--code);border:1px solid var(--rule);border-radius:6px;padding:11px 12px;overflow-x:auto;font-family:var(--mono);font-size:.78rem;line-height:1.6;white-space:pre;color:var(--ink)}
.checks{margin:0;padding:0;list-style:none;font-size:.82rem}
.checks li{margin:4px 0;line-height:1.45}
.ck-red{color:var(--red);font-weight:600}
.ck-yellow{color:var(--amber)}
.ck-info{color:var(--mut)}
.allok{font-size:.82rem;color:var(--mut)}
</style></head><body>
<button id="themebtn" class="themebtn" aria-label="Toggle light or dark theme">☾ Dark</button>
<div class="wrap">
<h1>YayLayer map · ${esc(project || 'project')}</h1>
<p class="sub">${Object.keys(manifest.cells).length} Cells · ${verified.passed ? 'gate PASS' : 'gate BLOCKED'}</p>
<p class="hint">Click any Cell to open its sealed spec, code, and checks. Click the sides or press Esc to close.</p>
<div class="legend">${legend}</div>
${layers}
<div class="foot">Generated by <code>yay map</code> · green = code proven to match a signed spec.</div>
</div>
<div id="modal" class="modal" role="dialog" aria-modal="true"><div class="modal-panel"><button class="modal-close" aria-label="Close">✕</button><div class="modal-body"></div></div></div>
<script>
(function(){
  var modal=document.getElementById('modal'), body=modal.querySelector('.modal-body');
  function open(id){ var s=document.getElementById('d-'+id); if(!s) return; body.innerHTML=s.innerHTML; modal.classList.add('open'); document.body.style.overflow='hidden'; }
  function close(){ modal.classList.remove('open'); document.body.style.overflow=''; }
  document.querySelectorAll('.node[data-id]').forEach(function(n){ n.addEventListener('click',function(){ open(this.getAttribute('data-id')); }); });
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
