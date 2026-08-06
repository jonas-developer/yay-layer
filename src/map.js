'use strict';
// Generate the flowchart — a self-contained, theme-aware HTML page painted from
// the manifest + verify results. Green = proven, Yellow = flagged, Red = mismatch,
// Unsigned = awaiting signature.
//
// Click any Cell to drill down to its actual YayLayer structure: the sealed spec
// block, the code it governs, and the exact verify checks that earned its color.

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const COLORS = {
  GREEN: ['#1f9d57', 'Green'], YELLOW: ['#c9860f', 'Yellow'],
  RED: ['#cf4436', 'Red'], UNSIGNED: ['#7f8796', 'Unsigned'],
};

function renderMap(manifest, verified, project) {
  const byLang = {};
  for (const id of Object.keys(manifest.cells)) {
    const cell = manifest.cells[id];
    const lang = cell.lang || 'other';
    (byLang[lang] = byLang[lang] || []).push({ cell, res: verified.results[id] });
  }

  const detail = (cell, res) => {
    const meta = [];
    if (res.trust && res.trust.signed) meta.push(res.trust.auto ? `AUTO · ${esc(res.trust.grant || 'grant')}` : `signed by ${esc(res.trust.signer)}`);
    else meta.push('unsigned');
    meta.push(`spec ${esc(cell.specHash.slice(0, 12))}…`);
    if (cell.contains && cell.contains.length) meta.push(`contains ${esc(cell.contains.join(', '))}`);
    if (cell.feeds && cell.feeds.length) meta.push(`feeds → ${esc(cell.feeds.join(', '))}`);
    meta.push(esc(`${cell.file}:${cell.line}`));

    const checks = (res.notes || []).length
      ? `<div class="dh">Checks</div><ul class="checks">${res.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
      : `<div class="dh">Checks</div><div class="allok">✓ all checks passed</div>`;
    const code = cell.unitBody
      ? `<div class="dh">Code</div><pre class="code">${esc(cell.unitBody)}</pre>`
      : `<div class="dh">Code</div><div class="allok" style="color:var(--mut)">no unit body found below the spec</div>`;

    return `<div class="detail">
      <div class="dmeta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>
      <div class="dh">Sealed spec</div><pre class="code">${esc(cell.specBlock || '')}</pre>
      ${code}
      ${checks}
    </div>`;
  };

  const card = ({ cell, res }) => {
    const [col, label] = COLORS[res.state];
    const who = res.trust && res.trust.signed ? (res.trust.auto ? 'AUTO' : 'by ' + res.trust.signer) : 'unsigned';
    const feeds = (cell.feeds || []).length ? `feeds → ${esc(cell.feeds.join(', '))}` : '';
    return `<div class="cell">
      <button class="node" style="border-left-color:${col}" aria-expanded="false" data-id="${esc(cell.id)}">
        <div class="top"><span class="id">${esc(cell.id)}</span><span class="tr"><span class="pill" style="color:${col}">${label}</span><span class="chev">▸</span></span></div>
        <div class="nm">${esc(cell.unitName || cell.spec.unit || cell.id)}</div>
        <div class="ds">${esc(cell.spec.intent || '')}</div>
        <div class="fe">${feeds}${feeds && who ? ' · ' : ''}${esc(who)}</div>
      </button>
      ${detail(cell, res)}
    </div>`;
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
:root{--paper:#F4F1EA;--card:#FBFAF6;--ink:#1a1a21;--ink2:#4c4c58;--mut:#6f6f7a;--rule:#ddd8cd;--accent:#3d38a8;--code:#f3efe6;
--mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;}
@media(prefers-color-scheme:dark){:root{--paper:#131318;--card:#1b1b23;--ink:#ECEAE3;--ink2:#b6b4c0;--mut:#8a8a96;--rule:#2b2b36;--accent:#9b96f6;--code:#15151c;}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.55}
.wrap{max-width:1080px;margin:0 auto;padding:28px 22px}
h1{font-family:var(--mono);font-size:1.3rem;margin:0 0 4px}.sub{color:var(--mut);font-family:var(--mono);font-size:.8rem;margin:0 0 6px}
.hint{color:var(--mut);font-size:.82rem;margin:0 0 18px}
.legend{display:flex;gap:14px;flex-wrap:wrap;font-family:var(--mono);font-size:.78rem;margin-bottom:22px}
.lg::before{content:"●";margin-right:6px}
.layer{display:grid;grid-template-columns:120px 1fr;gap:14px;margin-bottom:14px}
.ll{font-family:var(--mono);font-size:.74rem;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);padding-top:10px;border-right:1px solid var(--rule)}
.nodes{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:11px;align-items:start}
@media(max-width:620px){.layer{grid-template-columns:1fr}.ll{border-right:none;border-bottom:1px solid var(--rule);padding:0 0 6px}}
.cell{display:flex;flex-direction:column}
.node{width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer;background:var(--card);border:1px solid var(--rule);border-left:3px solid var(--mut);border-radius:6px 6px 0 0;padding:11px 13px;transition:border-color .12s}
.node:hover{border-color:var(--accent)}
.node[aria-expanded=true]{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--accent) 30%,transparent)}
.top{display:flex;justify-content:space-between;align-items:center}
.tr{display:flex;align-items:center;gap:8px}
.chev{font-family:var(--mono);color:var(--mut);transition:transform .12s;display:inline-block}
.node[aria-expanded=true] .chev{transform:rotate(90deg);color:var(--accent)}
.id{font-family:var(--mono);font-size:.72rem;color:var(--accent);font-weight:600}
.pill{font-family:var(--mono);font-size:.64rem;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.nm{font-family:var(--mono);font-size:.9rem;font-weight:600;margin-top:5px}
.ds{font-size:.82rem;color:var(--ink2);margin-top:2px}
.fe{font-family:var(--mono);font-size:.66rem;color:var(--mut);margin-top:6px}
.detail{display:none;border:1px solid var(--rule);border-top:none;border-radius:0 0 6px 6px;padding:12px 13px;background:var(--card)}
.detail.open{display:block}
.dmeta{display:flex;gap:6px 12px;flex-wrap:wrap;font-family:var(--mono);font-size:.66rem;color:var(--mut);margin-bottom:10px}
.dh{font-family:var(--mono);font-size:.62rem;text-transform:uppercase;letter-spacing:.07em;color:var(--accent);margin:10px 0 4px}
.detail .dh:first-of-type{margin-top:0}
pre.code{margin:0;background:var(--code);border:1px solid var(--rule);border-radius:5px;padding:10px 11px;overflow-x:auto;font-family:var(--mono);font-size:.74rem;line-height:1.55;white-space:pre;color:var(--ink)}
.checks{margin:0;padding-left:16px;font-size:.76rem;color:var(--ink2)}
.allok{font-size:.76rem;color:var(--mut)}
.foot{margin-top:26px;font-family:var(--mono);font-size:.72rem;color:var(--mut)}
</style></head><body><div class="wrap">
<h1>YayLayer map · ${esc(project || 'project')}</h1>
<p class="sub">${Object.keys(manifest.cells).length} Cells · ${verified.passed ? 'gate PASS' : 'gate BLOCKED'}</p>
<p class="hint">Click any Cell to open its sealed spec, the code it governs, and the verify checks.</p>
<div class="legend">${legend}</div>
${layers}
<div class="foot">Generated by <code>yay map</code> · green = code proven to match a signed spec.</div>
</div>
<script>
document.querySelectorAll('.node[data-id]').forEach(function(n){
  n.addEventListener('click',function(){
    var d=this.parentNode.querySelector('.detail');
    var open=d.classList.toggle('open');
    this.setAttribute('aria-expanded',open?'true':'false');
  });
});
</script>
</body></html>`;
}

module.exports = { renderMap };
