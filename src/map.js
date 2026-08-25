'use strict';
// Generate the flowchart — a self-contained, theme-aware, ZOOMABLE mind-map.
//
// It's a drill-down hierarchy explorer: the mind-map shows one level at a time —
// System → Modules → sub-groups (Public API / Internal / classes) → units.
// Click a node to ZOOM IN (its children become the new mind-map); use the
// breadcrumb to zoom back out; click a unit to open its spec, code (offending
// lines in red) and checks — the place the spec must match the code.
//
// Structure is derived generally (ES export / CommonJS / UMD / IIFE / classes /
// objects) via @babel/parser; module-to-module flow comes from the call graph.
// No external libraries — one self-contained file.

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function base(f) { return String(f || 'other').split('/').pop(); }

// Tint the two fields a non-coder architect reads first: `intent` (blue) and
// `ensures` (purple). Colours the field line AND its continuation lines, until
// the next field or marker. Everything else stays default.
function colorizeSpec(block) {
  let cur = null;
  return String(block || '').split('\n').map((l) => {
    const e = esc(l);
    if (/∷YAY/.test(l)) { cur = null; return e; }
    const m = l.match(/^\s*(?:\/\/|#)\s*([A-Za-z_]+)\s*:/);
    if (m) cur = m[1].toLowerCase();
    else if (!/^\s*(?:\/\/|#)/.test(l)) cur = null; // not a comment line → end of field
    if (cur === 'intent') return `<span class="sp-intent">${e}</span>`;
    if (cur === 'ensures') return `<span class="sp-ensures">${e}</span>`;
    return e;
  }).join('\n');
}

const COMMANDS = [
  { cmd: 'yay init [dir]', desc: 'Guided setup: files → signing key → adopt → Constitution → optional System Plan.', flags: [['--key local|mobile', 'signing-key type (mobile = pair your phone)'], ['--name <you>', 'signer name on every seal'], ['--adopt / --no-adopt', 'scaffold specs over existing code'], ['--constitution <keys|all>', 'write the Constitution into AI-harness files'], ['--plan / --no-plan', 'enable AI System Plan'], ['--provider anthropic|openai|custom', 'plan LLM (+ --base-url, --model, --api-key)']] },
  { cmd: 'yay keygen --name <you>', desc: 'Create your ed25519 signing key (public → roster, private → encrypted keystore).', flags: [['--passphrase <p>', 'or the YAY_PASSPHRASE env var']] },
  { cmd: 'yay pair [--name you]', desc: 'Pair your phone as the signer — scan the QR; the private key stays on the phone. The FIRST pairing (no roster yet) makes the phone the trust root itself, so no local key is ever needed.', flags: [['--name <you>', 'attach the phone key to this identity'], ['--https', 'serve over self-signed TLS (encrypted; one-time cert tap)']] },
  { cmd: 'yay enroll --name X --pubkey <b64>', desc: 'Enroll another signer via an OWNER-signed roster event.', flags: [['--role owner|signer', 'role to grant (default signer)'], ['--by <owner>', 'which owner authorizes it'], ['--phone', 'authorize on an owner’s phone (no local key needed)']] },
  { cmd: 'yay revoke --name X', desc: 'Revoke a compromised/rotated key (or a whole identity) via an owner-signed event. Past approvals stay attributed; refuses if it would leave no owner.', flags: [['--pubkey <b64>', 'revoke just this key (omit to remove the whole identity)'], ['--phone', 'authorize on an owner’s phone']] },
  { cmd: 'yay reroot', desc: 'Retire the current trust root and establish a new one — recovery for a lost/compromised root key. A trust discontinuity: re-sign specs and repoint the CI pin afterward.', flags: [['--phone', 'root the new key on your phone (phone-as-genesis)'], ['--name <you>', 'new local owner name'], ['--force', 'skip the confirmation prompt']] },
  { cmd: 'yay adopt [path]', desc: 'Scaffold draft (unsigned) spec blocks over existing code.', flags: [['--dry', 'preview what would be added']] },
  { cmd: 'yay sign [--all | --cell IDs]', desc: 'Approve the current specs — appends a signed seal.', flags: [['--phone', 'sign on the paired phone (scan the QR)'], ['--https', 'phone over self-signed TLS'], ['--cell <ids>', 'only these Cells (comma-separated)'], ['--name <signer>', 'which signer']] },
  { cmd: 'yay verify [--strict] [-d]', desc: 'The gate: paint every Cell + run the behavioural prover & mutation grading.', flags: [['--strict', 'non-zero exit if blocked (for CI)'], ['-d, --details', 'print each spec, code & checks'], ['--problems', 'show only non-green Cells'], ['--no-mutate', 'skip mutation grading']] },
  { cmd: 'yay plan', desc: 'AI-synthesize the high-level System Plan → .yaylayer/plan.json.', flags: [['--provider anthropic|openai|custom', 'LLM provider (key from .env)'], ['--base-url <url>', 'custom / OpenAI-compatible endpoint (Ollama, LM Studio, vLLM — key optional)'], ['--model <m>', 'model id']] },
  { cmd: 'yay map [-o file.html]', desc: 'Write this HTML site (Map / Files / System Plan / Signers / Commands).', flags: [['-o <file>', 'output path'], ['--no-plan', 'omit the System Plan entirely'], ['--replan', 'force plan regeneration']] },
  { cmd: 'yay gate [dir]', desc: 'Write the CI gate workflow and print the branch-protection steps.', flags: [['--hook', 'also install a local pre-push gate'], ['--scope <dir>', 'gate only a subfolder'], ['--force', 'overwrite existing files']] },
  { cmd: 'yay constitution --for <keys>', desc: 'Write the Constitution where an AI harness auto-reads it.', flags: [['--for <keys|all>', 'claude, agents, copilot, cursor, windsurf, cline, gemini, generic'], ['--list', 'list the harnesses']] },
  { cmd: 'yay status', desc: 'One-line health summary of the project.', flags: [] },
];
function commandsHTML() {
  return '<h1>Commands</h1><div class="snote" style="margin:0 0 18px">Every <code>yay</code> command and its flags. Passphrases/keys come from your <code>.env</code>; run <code>yay help</code> in the terminal for the terse version.</div>'
    + COMMANDS.map((c) => `<div class="cmdcard"><div class="cmdname">${esc(c.cmd)}</div><div class="cmddesc">${esc(c.desc)}</div>`
      + (c.flags.length ? `<div class="cmdflags">${c.flags.map((f) => `<div class="cmdflag"><code>${esc(f[0])}</code><span>${esc(f[1])}</span></div>`).join('')}</div>` : '')
      + '</div>').join('');
}

const COLORS = {
  GREEN: ['#1f9d57', 'Green'], YELLOW: ['#c9860f', 'Yellow'],
  RED: ['#cf4436', 'Red'], UNSIGNED: ['#7f8796', 'Unsigned'], PINK: ['#e0559b', 'Pink'],
};
const SEV = { GREEN: 1, YELLOW: 2, UNSIGNED: 3, PINK: 4, RED: 5 };
function subOrder(s) { return s === 'Public API' ? 0 : s === 'Modules' ? 1 : s === 'Internal' ? 3 : s === 'module-level' ? 4 : 2; }

function fmtWhen(v) {
  if (!v) return '';
  const d = new Date(v);
  return isNaN(d) ? String(v) : d.toISOString().slice(0, 16).replace('T', ' ');
}
function detailInner(cell, res, t) {
  t = t || {};
  const [col, label] = COLORS[res.state];
  if (res.untracked) {
    return `<div class="mhead"><span class="mid">${esc(cell.id)}</span><span class="mname">${esc(res.name || cell.unitName || '')}</span><span class="mpill" style="color:${col}">${label}</span></div>
      <div class="dmeta"><span>untracked</span><span>${esc(res.file)}:${esc(res.line)}</span></div>
      <div class="dh" style="color:${col}">No formal specification</div>
      <div class="allok" style="color:${col};font-weight:600">◆ This code was never described in YayLayer or signed — it sits outside the system, where silent bugs hide.</div>
      <div class="allok" style="margin-top:8px">Run <code>yay adopt</code> to scaffold a spec above it, then prune &amp; sign it.</div>`;
  }
  const isMod = !!(cell.contains && cell.contains.length);
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
  const body = isMod
    ? `<div class="dh">Contains</div><pre class="code">${esc(cell.contains.join('\n'))}</pre>`
    : (cell.unitBody ? `<div class="dh">Code</div><pre class="code">${codeHtml}</pre>`
        : `<div class="dh">Code</div><div class="allok">no unit body found below the spec</div>`);
  const sym = { red: '✗', yellow: '⚠', info: '•' };
  const checks = (res.notes || []).length
    ? `<div class="dh">Checks</div><ul class="checks">${res.notes.map((n) => `<li class="ck-${n.level}">${sym[n.level] || '•'} ${esc(n.text)}</li>`).join('')}</ul>`
    : `<div class="dh">Checks</div><div class="allok" style="color:${col}">✓ all checks passed</div>`;
  // History — when it was created and signed. Derived (lock + git), not stored in the spec.
  const hist = [];
  if (t.createdCode) hist.push(`created in code · ${fmtWhen(t.createdCode)}`);
  if (res.trust && res.trust.firstAt) hist.push(`first signed · ${fmtWhen(res.trust.firstAt)}`);
  if (res.trust && res.trust.signed && res.trust.at) hist.push(`signed by ${esc(res.trust.signer)} · ${fmtWhen(res.trust.at)}`);
  if (t.changedCode && t.changedCode !== t.createdCode) hist.push(`code last changed · ${fmtWhen(t.changedCode)}`);
  const history = hist.length ? `<div class="dh">History</div><ul class="checks">${hist.map((x) => `<li class="ck-info">• ${x}</li>`).join('')}</ul>` : '';
  // Impact — computed from the call graph, not narrated. "What breaks if this is wrong."
  const impact = isMod ? '' : `<div class="dh">Impact</div><ul class="checks">
    <li>▲ <b>${res.blast || 0}</b> Cell(s) depend on this${res.dependents ? ` — ${res.dependents} directly` : ''}${(res.blast || 0) === 0 ? ' (nothing breaks downstream)' : ''}</li>
    ${res.isEntry ? '<li class="ck-info">• public entry point — external callers expected</li>' : ''}
    ${res.bloat ? '<li class="ck-yellow">⚠ no callers found — possible dead code (or called dynamically)</li>' : ''}</ul>`;
  return `<div class="mhead"><span class="mid">${esc(cell.id)}</span><span class="mname">${esc(cell.unitName || cell.spec.unit || cell.id)}</span><span class="mpill" style="color:${col}">${label}</span></div>
    <div class="dmeta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>
    <div class="dh">Sealed spec</div><pre class="code">${colorizeSpec(cell.specBlock)}</pre>
    ${body}
    ${history}
    ${impact}
    ${checks}`;
}

function renderMap(manifest, verified, project, changes, times, planDoc, gov) {
  // Build the hierarchy: system → module → sub-group → unit.
  const nodes = {}; const details = {};
  const ensure = (id, label, kind, parent) => {
    if (!nodes[id]) nodes[id] = { id, label, kind, parent: parent || null, children: [] };
    return nodes[id];
  };
  ensure('system', project || 'system', 'system', null);

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
    const group = (mc && mc.group) || res.group || 'Internal';
    const modId = 'm:' + module;
    const grpId = 'g:' + module + ' ' + group;
    const unitId = 'u:' + id;
    const m = ensure(modId, module, 'module', 'system');
    if (!nodes.system.children.includes(modId)) nodes.system.children.push(modId);
    const g = ensure(grpId, group, 'group', modId);
    if (!m.children.includes(grpId)) m.children.push(grpId);
    nodes[unitId] = { id: unitId, label: cell.unitName || cell.spec.unit || id, kind: 'unit', parent: grpId, children: [], state: res.state, cellId: cell.id, intent: cell.spec.intent || '', blast: res.blast || 0, bloat: !!res.bloat };
    g.children.push(unitId);
    details[unitId] = detailInner(cell, res, (times && times[id]) || {});
  }

  // roll-up state + counts (post-order)
  const ru = (id) => {
    const n = nodes[id];
    if (n.kind === 'unit') { n.count = 1; return n.state; }
    let s = 'GREEN', c = 0;
    for (const k of n.children) { const cs = ru(k); if (SEV[cs] > SEV[s]) s = cs; c += nodes[k].count; }
    n.state = s; n.count = c; return s;
  };
  ru('system');
  // order children: modules by name; groups by subOrder; units by name
  for (const n of Object.values(nodes)) {
    if (n.kind === 'module') n.children.sort((a, b) => subOrder(nodes[a].label) - subOrder(nodes[b].label) || nodes[a].label.localeCompare(nodes[b].label));
    else if (n.kind === 'unit') { /* leaf */ } else n.children.sort((a, b) => nodes[a].label.localeCompare(nodes[b].label));
  }

  // trim to a light payload
  const YLnodes = {};
  for (const id of Object.keys(nodes)) {
    const n = nodes[id];
    YLnodes[id] = { id, label: n.label, kind: n.kind, color: COLORS[n.state][0], state: n.state, count: n.count || 1, children: n.children, parent: n.parent, intent: n.intent || '', blast: n.blast || 0, bloat: !!n.bloat };
  }
  const modEdges = (manifest.moduleEdges || [])
    .filter(([a, b]) => nodes['m:' + a] && nodes['m:' + b] && a !== b)
    .map(([a, b]) => ['m:' + a, 'm:' + b]);
  // "Needs attention" — the gate-blockers a human must act on, leaf Cells only
  // (containers just roll up). Order: unsigned (needs signing) → red → pink.
  const NEEDSEV = { UNSIGNED: 0, RED: 1, PINK: 2 };
  const needs = Object.keys(verified.results)
    .filter((id) => NEEDSEV[verified.results[id].state] !== undefined
      && !(nodes['u:' + id] && nodes['u:' + id].kind !== 'unit')
      && !(manifest.cells[id] && manifest.cells[id].contains && manifest.cells[id].contains.length))
    .map((id) => ({ id: 'u:' + id, state: verified.results[id].state }))
    .sort((a, b) => NEEDSEV[a.state] - NEEDSEV[b.state]);
  const c = verified.counts;
  const legend = Object.entries(COLORS).map(([k, [col, label]]) => `<span class="lg" style="color:${col}">${label} ${c[k] || 0}</span>`).join('');
  const totalUnits = Object.values(nodes).filter((n) => n.kind === 'unit').length;
  const FILES = [];
  for (const id of Object.keys(verified.results)) {
    const res = verified.results[id];
    const mc = manifest.cells[id];
    if (mc && mc.contains && mc.contains.length) continue; // container Cells aren't file units
    FILES.push({ file: res.file || (mc && mc.file) || 'other', name: (mc && (mc.unitName || (mc.spec && mc.spec.unit))) || res.name || id, id: 'u:' + id, state: res.state, line: res.line || (mc && mc.line) || 0 });
  }
  const meta = { project: project || 'project', counts: verified.counts, passed: verified.passed, totalUnits, plan: planDoc || null, gov: gov || null, files: FILES };
  const payload = JSON.stringify({ root: 'system', nodes: YLnodes, edges: { system: modEdges }, details, changes: changes || [], needs, meta })
    .replace(/</g, '\\u003c');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>YayLayer map · ${esc(project || 'project')}</title>
<style>
:root{
  --paper:#ffffff;--card:#ffffff;--card2:#f7f8f9;--code:#f1f3f5;--codebg:#1c1c1c;--codeink:#e6e6e6;
  --ink:#141414;--ink2:#525c64;--mut:#8a939b;--rule:#e6e8eb;--accent:#1a8f5f;--brand:#3ecf8e;
  --red:#d92d20;--amber:#b7791f;--blue:#6ea8fe;--purple:#c197fb;
  --mono:ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace;
  --sans:"Inter",system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  --shadow:0 1px 2px rgba(16,24,40,.04),0 1px 3px rgba(16,24,40,.06);}
:root[data-theme="dark"]{
  --paper:#171717;--card:#1e1e1e;--card2:#212121;--code:#262626;--codebg:#141414;--codeink:#e6e6e6;
  --ink:#ededed;--ink2:#a6a6a6;--mut:#7a7a7a;--rule:#2b2b2b;--accent:#3ecf8e;--brand:#3ecf8e;
  --red:#ff6b6b;--amber:#e0a437;--blue:#6ea8fe;--purple:#c197fb;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 2px 8px rgba(0,0,0,.25);}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);line-height:1.6;-webkit-font-smoothing:antialiased}
.nav{position:sticky;top:0;z-index:60;background:var(--paper);border-bottom:1px solid var(--rule)}
.nav-in{max-width:1800px;margin:0;padding:0 32px;height:56px;display:flex;align-items:center;justify-content:space-between}
.brand{display:flex;align-items:center;gap:10px;min-width:0}
.brand .logo{width:26px;height:26px;flex:none;display:inline-flex}
.brandname{font-weight:700;font-size:1rem;letter-spacing:-.01em;color:var(--ink)}
.brandsep{color:var(--mut)}
.brandproj{color:var(--ink2);font-family:var(--mono);font-size:.82rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nav-right{display:flex;align-items:center;gap:9px;flex:none}
.themebtn{font-family:var(--sans);font-size:.8rem;font-weight:500;background:var(--card);color:var(--ink);border:1px solid var(--rule);border-radius:8px;padding:7px 13px;cursor:pointer}
.themebtn:hover{border-color:var(--mut)}
.viewbtn{font-family:var(--sans);font-size:.8rem;font-weight:600;background:var(--brand);color:#04231a;border:1px solid transparent;border-radius:8px;padding:7px 15px;cursor:pointer}
.viewbtn:hover{filter:brightness(1.05)}
.tabs{display:flex;gap:2px;background:var(--card2);border:1px solid var(--rule);border-radius:9px;padding:3px}
.tab{font-family:var(--sans);font-size:.8rem;font-weight:500;background:none;border:none;color:var(--ink2);border-radius:6px;padding:6px 13px;cursor:pointer}
.tab:hover{color:var(--ink)}
.tab.active{background:var(--paper);color:var(--ink);box-shadow:var(--shadow);font-weight:600}
.signers{margin-top:4px;max-width:900px}
.rootcard{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;background:var(--card2);border:1px solid var(--rule);border-radius:12px;padding:16px 18px;margin:0 0 20px}
.rootlbl{font-family:var(--sans);font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--ink2)}
.rootfp{font-family:var(--mono);font-size:1.05rem;font-weight:700;color:var(--ink);margin-top:2px}
.srow{display:flex;align-items:flex-start;gap:14px;border:1px solid var(--rule);border-radius:12px;padding:15px 18px;margin:0 0 10px;background:var(--card);box-shadow:var(--shadow)}
.savatar{width:40px;height:40px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;font-weight:700;color:#fff;font-family:var(--sans)}
.sname{font-family:var(--sans);font-weight:700;font-size:1rem}
.srole{font-family:var(--mono);font-size:.58rem;text-transform:uppercase;letter-spacing:.08em;font-weight:700;padding:2px 9px;border-radius:100px;margin-left:8px;vertical-align:middle}
.srole.owner{background:color-mix(in srgb,var(--brand) 22%,transparent);color:var(--accent)}
.srole.signer{background:var(--card2);color:var(--ink2);border:1px solid var(--rule)}
.smeta{font-family:var(--mono);font-size:.72rem;color:var(--mut);margin-top:4px}
.skey{font-family:var(--mono);font-size:.72rem;color:var(--ink2);display:flex;align-items:center;gap:8px;margin-top:6px;flex-wrap:wrap}
.skeykind{font-size:.58rem;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);border:1px solid var(--rule);border-radius:5px;padding:1px 6px}
.swarn{color:var(--amber);font-family:var(--mono);font-size:.82rem;margin:0 0 12px}
.snote{color:var(--mut);font-family:var(--mono);font-size:.82rem}
.signers h1{margin:0 0 16px}
.files{margin-top:4px;max-width:900px}
.files h1{margin:0 0 6px}
.ftree{border:1px solid var(--rule);border-radius:12px;background:var(--card);overflow:hidden;box-shadow:var(--shadow)}
.frow{display:flex;align-items:center;gap:9px;padding:6px 12px;font-family:var(--mono);font-size:.8rem;border-top:1px solid transparent}
.fdir{color:var(--ink2);font-weight:600}
.ffile{color:var(--ink);font-weight:600;border-top:1px solid var(--rule)}
.fcell{cursor:pointer;color:var(--ink2)}
.fcell:hover{background:var(--card2)}
.fcell.bad{color:var(--ink)}
.fdot{width:8px;height:8px;border-radius:50%;flex:none}
.fname{flex:1;min-width:0}
.funit{flex:1;min-width:0}
.fcount{color:var(--mut);font-size:.7rem}
.fstate{font-size:.58rem;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.commands{max-width:840px;margin-top:4px}
.commands h1{margin:0 0 6px}
.cmdcard{border:1px solid var(--rule);border-radius:12px;background:var(--card);box-shadow:var(--shadow);padding:16px 18px;margin:0 0 12px}
.cmdname{font-family:var(--mono);font-size:.95rem;font-weight:700;color:var(--ink)}
.cmddesc{color:var(--ink2);font-size:.9rem;margin:6px 0 0}
.cmdflags{margin-top:12px;border-top:1px solid var(--rule);padding-top:11px;display:flex;flex-direction:column;gap:7px}
.cmdflag{display:flex;gap:12px;align-items:baseline;font-size:.82rem;flex-wrap:wrap}
.cmdflag code{font-family:var(--mono);font-size:.76rem;color:var(--accent);background:var(--card2);border:1px solid var(--rule);border-radius:6px;padding:2px 7px;white-space:nowrap;flex:none;min-width:172px}
.cmdflag span{color:var(--ink2)}
.commands code,.foot code,.snote code{font-family:var(--mono);font-size:.85em;background:var(--card2);border:1px solid var(--rule);border-radius:5px;padding:1px 5px}
.wrap{max-width:1800px;margin:0;padding:28px 32px 80px}
.pagehead{margin:0 0 16px}
h1{font-family:var(--sans);font-size:1.5rem;font-weight:700;letter-spacing:-.02em;margin:0 0 4px}
.sub{color:var(--mut);font-family:var(--mono);font-size:.78rem;margin:0}
.legend{display:flex;gap:9px;flex-wrap:wrap;font-family:var(--mono);font-size:.82rem;font-weight:600;margin:0 0 20px}
.lg{display:inline-flex;align-items:center;gap:7px;background:var(--card2);border:1px solid var(--rule);border-radius:100px;padding:7px 15px}
.lg::before{content:"●";font-size:1.05em}
.crumb{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-family:var(--mono);font-size:.8rem;margin-bottom:10px}
.crumb button{appearance:none;background:none;border:none;color:var(--accent);font:inherit;cursor:pointer;padding:2px 4px;border-radius:6px}
.crumb button:hover{background:var(--card2)}
.crumb .here{color:var(--ink);font-weight:600}
.crumb .sep{color:var(--mut)}
.crumb .upbtn{background:var(--card);border:1px solid var(--rule);color:var(--ink);border-radius:8px;padding:4px 11px;margin-right:4px}
.crumb .upbtn:hover:not(:disabled){border-color:var(--mut)}
.crumb .upbtn:disabled{opacity:.4;cursor:default}
.hint{color:var(--mut);font-size:.82rem;margin:0 0 12px}
.stage{position:relative;border:1px solid var(--rule);border-radius:12px;background:var(--card2);overflow:auto;max-height:660px;box-shadow:var(--shadow)}
#graph{width:100%;display:block;color:var(--mut)}
#graph .gbox{fill:var(--card)}
#graph .rootbox{fill:var(--card)}
#graph .gnode{cursor:pointer}
#graph .gnode:hover .gbox,#graph .gnode:hover .rootbox{filter:brightness(1.03);stroke-width:3}
#graph .glabel{font-family:var(--mono);font-size:12.5px;fill:var(--ink);font-weight:600;pointer-events:none}
#graph .rootlabel{font-size:13.5px;fill:var(--ink)}
#graph .gcount{font-family:var(--mono);font-size:11px;fill:var(--mut);pointer-events:none}
#graph .gchev{font-family:var(--mono);font-size:14px;fill:var(--accent);pointer-events:none}
#graph .gbloat{font-family:var(--mono);font-size:10px;fill:var(--amber);pointer-events:none}
#graph .link{fill:none;stroke:var(--mut);stroke-width:1.6;opacity:.5}
.empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:var(--mut);font-family:var(--mono);font-size:.85rem}
.foot{margin-top:20px;font-family:var(--mono);font-size:.72rem;color:var(--mut);line-height:1.7}
.logwrap{margin-top:24px}
.logh{font-family:var(--sans);font-size:.7rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink2);margin:0 0 10px}
.log{list-style:none;margin:0;padding:0;border:1px solid var(--rule);border-radius:12px;overflow:hidden;background:var(--card);box-shadow:var(--shadow)}
.logrow{display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;border-top:1px solid var(--rule);font-family:var(--mono);font-size:.8rem}
.logrow:first-child{border-top:none}
.logrow:hover{background:var(--card2)}
.logdot{width:9px;height:9px;border-radius:50%;flex:none}
.logtime{color:var(--mut);min-width:120px;white-space:nowrap}
.logname{font-weight:600;color:var(--ink);word-break:break-word}
.logmod{color:var(--mut)}
.logsrc{margin-left:auto;color:var(--mut);font-size:.66rem;text-transform:uppercase;letter-spacing:.04em}
.logempty{padding:14px;color:var(--mut);font-family:var(--mono);font-size:.8rem}
.needs{margin:0 0 18px}
.needsh{font-family:var(--sans);font-size:.72rem;font-weight:600;color:var(--ink2);margin:0 0 8px}
.needlist{display:flex;flex-wrap:wrap;gap:7px}
.needrow{display:flex;align-items:center;gap:7px;padding:6px 12px;border:1px solid var(--rule);border-radius:100px;background:var(--card);cursor:pointer;font-family:var(--mono);font-size:.76rem;box-shadow:var(--shadow)}
.needrow:hover{border-color:var(--mut);background:var(--card2)}
.needstate{font-size:.6rem;text-transform:uppercase;letter-spacing:.04em;font-weight:600}
.needrow .logname{font-weight:600;color:var(--ink)}
.needrow .logmod{color:var(--mut)}
.needok{font-family:var(--mono);font-size:.82rem;color:var(--accent)}
/* width is constant across views (wide, left-aligned) */
.plan{margin-top:4px}
.pnarr{margin:2px 0 26px}
.ptitle{font-family:var(--sans);font-weight:700;font-size:1.6rem;letter-spacing:-.02em;margin:0 0 12px}
.psys{font-size:1.1rem;color:var(--ink2);max-width:82ch;margin:0 0 16px;line-height:1.65}
.pmetrics{display:flex;flex-wrap:wrap;gap:9px}
.pm{font-family:var(--mono);font-size:.74rem;background:var(--card2);border:1px solid var(--rule);border-radius:100px;padding:5px 13px;color:var(--ink2)}
.pm.ok{color:var(--accent);border-color:currentColor}.pm.bad{color:var(--red);border-color:currentColor}
.pm.dot-GREEN{color:#1f9d57}.pm.dot-YELLOW{color:var(--amber)}.pm.dot-RED{color:var(--red)}.pm.dot-PINK{color:#e0559b}.pm.dot-UNSIGNED{color:var(--mut)}
.pfit{position:relative;overflow:hidden}
.pdiagram{position:relative;border:1px solid var(--rule);border-radius:16px;background:var(--card2)}
.parrows{position:absolute;left:0;top:0;color:var(--mut)}
.parrow{fill:none;stroke:var(--mut);stroke-width:2.5;opacity:.55}
.pflow{position:absolute;transform:translate(-50%,-50%);max-width:168px;font-family:var(--mono);font-size:.66rem;line-height:1.35;text-align:center;color:var(--ink2);background:var(--card);border:1px solid var(--rule);border-radius:10px;padding:4px 9px;white-space:normal;word-break:break-word;z-index:3;box-shadow:var(--shadow)}
.pcard{position:absolute;z-index:2;background:var(--card);border:1px solid var(--rule);border-top:4px solid var(--mut);border-radius:14px;padding:16px 18px;box-shadow:0 12px 30px -18px rgba(16,24,40,.25);display:flex;flex-direction:column;overflow:hidden}
.prole{font-family:var(--mono);font-size:.6rem;text-transform:uppercase;letter-spacing:.1em;font-weight:600}
.pname{font-family:var(--sans);font-weight:700;font-size:1.05rem;margin:3px 0 7px;line-height:1.25}
.ppurpose{font-size:.9rem;color:var(--ink2);line-height:1.5;overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical}
.pcardfoot{margin-top:auto;padding-top:10px}
.pmods{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px}
.pmod{font-family:var(--mono);font-size:.66rem;background:var(--card2);border:1px solid var(--rule);border-radius:6px;padding:2px 7px;color:var(--mut)}
.pcells{font-family:var(--mono);font-size:.68rem;color:var(--mut)}
.phi{margin:24px 0 0;background:var(--card2);border:1px solid var(--rule);border-radius:14px;padding:18px 22px}
.phih{font-family:var(--sans);font-size:.72rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink2);margin:0 0 10px}
.phi ul{margin:0;padding-left:18px}.phi li{margin:6px 0;color:var(--ink2)}
.pfoot{margin-top:18px;font-family:var(--mono);font-size:.72rem;color:var(--mut)}
.pnote{padding:24px;color:var(--mut);font-family:var(--mono);font-size:.85rem;border:1px dashed var(--rule);border-radius:12px}
.modal{position:fixed;inset:0;z-index:80;display:none;padding:48px 16px;overflow:auto;background:rgba(10,12,16,.55);backdrop-filter:blur(2px)}
.modal.open{display:flex;align-items:flex-start;justify-content:center}
.modal-panel{position:relative;background:var(--paper);border:1px solid var(--rule);border-radius:16px;max-width:840px;width:100%;padding:24px 26px 28px;box-shadow:0 40px 90px -30px rgba(0,0,0,.5);max-height:calc(100vh - 96px);overflow:auto}
.modal-close{position:absolute;top:14px;right:14px;background:var(--card);border:1px solid var(--rule);border-radius:8px;color:var(--ink);width:32px;height:32px;cursor:pointer;font-size:.85rem}
.modal-close:hover{border-color:var(--mut)}
.mhead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:8px;padding-right:36px}
.mid{font-family:var(--mono);font-size:.78rem;color:var(--accent);font-weight:600}
.mname{font-family:var(--sans);font-size:1.1rem;font-weight:700;word-break:break-word}
.mpill{font-family:var(--mono);font-size:.64rem;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
.dmeta{display:flex;gap:6px 12px;flex-wrap:wrap;font-family:var(--mono);font-size:.68rem;color:var(--mut);margin-bottom:6px}
.dh{font-family:var(--sans);font-size:.66rem;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--ink2);margin:16px 0 6px}
pre.code{margin:0;background:var(--codebg);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:14px 16px;overflow-x:auto;font-family:var(--mono);font-size:.8rem;line-height:1.65;white-space:pre;color:var(--codeink)}
.badline{display:block;background:rgba(255,90,80,.18);color:#ff8f86;font-weight:700;border-radius:4px;margin:0 -6px;padding:0 6px}
pre.code .sp-intent{color:var(--blue);font-weight:600}
pre.code .sp-ensures{color:var(--purple);font-weight:600}
.checks{margin:0;padding:0;list-style:none;font-size:.84rem}.checks li{margin:5px 0;line-height:1.5}
.ck-red{color:var(--red);font-weight:600}.ck-yellow{color:var(--amber)}.ck-info{color:var(--mut)}
.allok{font-size:.84rem;color:var(--mut)}
</style></head><body>
<header class="nav"><div class="nav-in">
<div class="brand"><span class="logo"><svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><rect width="26" height="26" rx="7" fill="#3ecf8e"/><path d="M6.5 13.5l4 4L20 7.5" fill="none" stroke="#04231a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="brandname">YayLayer</span><span class="brandsep">/</span><span class="brandproj">${esc(project || 'project')}</span></div>
<div class="nav-right"><nav class="tabs"><button class="tab active" data-tab="map">Map</button><button class="tab" data-tab="files">Files</button><button class="tab" data-tab="plan" id="tab-plan" style="display:none">System Plan</button><button class="tab" data-tab="signers">Signers</button><button class="tab" data-tab="commands">Commands</button></nav><button id="themebtn" class="themebtn" aria-label="Toggle theme">Dark</button></div>
</div></header>
<div class="wrap">
<div class="pagehead"><h1>System map</h1><p class="sub">${totalUnits} units · ${verified.passed ? 'gate PASS' : 'gate BLOCKED'}</p></div>
<div class="legend">${legend}</div>
<div id="needs" class="needs"></div>
<p class="hint">A drill-down tree. The box on the <b>left is where you are</b>; its contents branch to the right. Click a <b>container ›</b> to zoom into it, click the left box or <b>↑ Up a level</b> to zoom out, and click a <b>unit</b> to open its spec, code &amp; checks.</p>
<div class="crumb" id="crumb"></div>
<div class="stage"><svg id="graph"></svg></div>
<div class="logwrap"><div class="logh">Recent changes</div><ol id="log" class="log"></ol></div>
<div id="plan" class="plan" style="display:none"></div>
<div id="signers" class="signers" style="display:none"></div>
<div id="files" class="files" style="display:none"></div>
<div id="commands" class="commands" style="display:none">${commandsHTML()}</div>
<div class="foot">Generated by <code>yay map</code> · zoomable hierarchy · green = code proven to match a signed spec, pink = no spec · ▲N = Cells that depend on this (blast radius) · <span style="color:var(--amber)">unused?</span> = no callers found.</div>
</div>
<div id="modal" class="modal" role="dialog" aria-modal="true"><div class="modal-panel"><button class="modal-close" aria-label="Close">✕</button><div class="modal-body"></div></div></div>
<script id="yl-data" type="application/json">${payload}</script>
<script>
(function(){
  var DATA=JSON.parse(document.getElementById('yl-data').textContent);
  var NODES=DATA.nodes, DETAILS=DATA.details, EDGES=DATA.edges||{};
  var svg=document.getElementById('graph'), crumbEl=document.getElementById('crumb');
  var NS='http://www.w3.org/2000/svg';
  var cur=DATA.root;

  function crumb(){
    var path=[], id=cur; while(id){ path.unshift(id); id=NODES[id].parent; }
    crumbEl.innerHTML='';
    var up=document.createElement('button');
    up.className='upbtn'; up.textContent='↑ Up a level';
    up.disabled=!NODES[cur].parent;
    up.onclick=function(){ var pp=NODES[cur].parent; if(pp){ cur=pp; draw(); } };
    crumbEl.appendChild(up);
    path.forEach(function(pid,i){
      var sep=document.createElement('span'); sep.className='sep'; sep.textContent='›'; crumbEl.appendChild(sep);
      if(i===path.length-1){ var s=document.createElement('span'); s.className='here'; s.textContent=NODES[pid].label; crumbEl.appendChild(s); }
      else{ var b=document.createElement('button'); b.textContent=NODES[pid].label; b.onclick=function(){ cur=pid; draw(); }; crumbEl.appendChild(b); }
    });
  }

  function openDetail(uid){ var m=document.getElementById('modal'); m.querySelector('.modal-body').innerHTML=DETAILS[uid]||''; m.classList.add('open'); document.body.style.overflow='hidden'; }

  function short(s){ s=String(s); return s.length>34 ? s.slice(0,32)+'…' : s; }
  function widthFor(label, hasCount){ return Math.max(150, short(label).length*7.9 + (hasCount?72:34)); }
  function mk(g,name,attrs){ var e=document.createElementNS(NS,name); for(var k in attrs) e.setAttribute(k,attrs[k]); g.appendChild(e); return e; }
  function txt(g,x,y,cls,s,anchor){ var t=mk(g,'text',{'class':cls,x:x,y:y,'text-anchor':anchor||'start','dominant-baseline':'central'}); t.textContent=s; return t; }

  function draw(){
    crumb();
    var root=NODES[cur];
    var kids=(root.children||[]).map(function(k){return NODES[k];});
    var W=svg.clientWidth||900;
    var rowH=48, topPad=30, botPad=26, childH=34;
    var H=Math.max(340, topPad+botPad+Math.max(1,kids.length)*rowH);
    svg.setAttribute('viewBox','0 0 '+W+' '+H); svg.setAttribute('height',H);
    svg.innerHTML='';
    var linkG=document.createElementNS(NS,'g'); svg.appendChild(linkG);
    var nodeG=document.createElementNS(NS,'g'); svg.appendChild(nodeG);

    var rootW=widthFor(root.label,false), rootH=48;
    var rootX=26, rootY=H/2, rootCx=rootX+rootW/2, rootRight=rootX+rootW;
    var maxW=0; kids.forEach(function(n){ var w=widthFor(n.label,n.kind!=='unit'); if(w>maxW)maxW=w; });
    var childX=Math.max(rootRight+80, Math.min(W*0.42, 340));
    if(childX+maxW>W-18) childX=Math.max(rootRight+34, W-18-maxW);

    kids.forEach(function(n,i){
      var rightU = n.kind==='unit' ? (n.blast ? '▲'+n.blast : (n.bloat ? 'unused?' : '')) : String(n.count);
      var hasRight = n.kind!=='unit' ? true : !!rightU;
      var cy=topPad+i*rowH+childH/2, w=widthFor(n.label,hasRight);
      var x1=rootRight, y1=rootY, x2=childX, mx=(x1+x2)/2;
      mk(linkG,'path',{'class':'link',d:'M'+x1+','+y1+' C'+mx+','+y1+' '+mx+','+cy+' '+x2+','+cy});
      var g=document.createElementNS(NS,'g'); g.setAttribute('class','gnode'+(n.kind==='unit'?' leaf':'')); nodeG.appendChild(g);
      mk(g,'rect',{'class':'gbox',x:childX,y:cy-childH/2,width:w,height:childH,rx:9,stroke:n.color,'stroke-width':n.kind==='unit'?2:2.5});
      txt(g,childX+14,cy,'glabel',short(n.label),'start');
      if(n.kind!=='unit'){ txt(g,childX+w-24,cy,'gcount',String(n.count),'end'); txt(g,childX+w-11,cy,'gchev','›','end'); }
      else if(rightU){ txt(g,childX+w-12,cy,n.bloat?'gbloat':'gcount',rightU,'end'); }
      (function(node){ g.addEventListener('click',function(){ if(node.kind==='unit'){ openDetail(node.id); } else if(node.children&&node.children.length){ cur=node.id; draw(); } }); })(n);
    });

    var upable=!!NODES[cur].parent;
    var rg=document.createElementNS(NS,'g'); rg.setAttribute('class','gnode'+(upable?'':' leaf')); nodeG.appendChild(rg);
    mk(rg,'rect',{'class':'rootbox',x:rootX,y:rootY-rootH/2,width:rootW,height:rootH,rx:10,stroke:root.color,'stroke-width':3});
    txt(rg,rootCx,rootY-7,'glabel rootlabel',short(root.label),'middle');
    txt(rg,rootCx,rootY+12,'gcount',(upable?'↑ ':'')+root.count+' units','middle');
    if(upable) rg.addEventListener('click',function(){ cur=NODES[cur].parent; draw(); });

    if(!kids.length) txt(nodeG,childX,H/2,'gcount','(nothing deeper — open the node to read its spec)','start');
  }

  function esc2(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function pad2(x){ return (x<10?'0':'')+x; }
  function exact(ms){ var d=new Date(ms); return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate())+' '+pad2(d.getHours())+':'+pad2(d.getMinutes()); }
  // Relative only within the last 24h; older entries show the exact local date & time.
  function ago(ms){ if(!ms) return ''; var s=(Date.now()-ms)/1000; if(s<60) return 'just now'; var m=s/60; if(m<60) return Math.round(m)+'m ago'; var h=m/60; if(h<24) return Math.round(h)+'h ago'; return exact(ms); }
  function moduleLabelOf(node){ var g=NODES[node.parent]; var m=g&&NODES[g.parent]; return m?m.label:''; }
  function renderLog(){
    var el=document.getElementById('log'); if(!el) return;
    var items=(DATA.changes||[]).filter(function(ch){ return NODES[ch.id]; });
    if(!items.length){ el.innerHTML='<li class="logempty">No change history yet — sign specs (each approval is logged here) or generate the map inside a git repo.</li>'; return; }
    el.innerHTML='';
    items.slice(0,40).forEach(function(ch){
      var node=NODES[ch.id];
      var li=document.createElement('li'); li.className='logrow'; li.title=ch.at?new Date(ch.at).toLocaleString():'';
      li.innerHTML='<span class="logdot" style="background:'+node.color+'"></span>'
        +'<span class="logtime">'+ago(ch.at)+'</span>'
        +'<span class="logname">'+esc2(node.label)+'</span>'
        +'<span class="logmod">'+esc2(moduleLabelOf(node))+'</span>'
        +'<span class="logsrc">'+esc2(ch.source)+'</span>';
      li.addEventListener('click',function(){ openDetail(ch.id); });
      el.appendChild(li);
    });
  }
  function jumpTo(uid){ var n=NODES[uid]; if(n&&n.parent){ cur=n.parent; draw(); } openDetail(uid); }
  function renderNeeds(){
    var el=document.getElementById('needs'); if(!el) return;
    var items=(DATA.needs||[]).filter(function(x){ return NODES[x.id]; });
    if(!items.length){ el.innerHTML='<div class="needok">✓ Nothing needs signing or attention — the gate passes.</div>'; return; }
    var counts={}; items.forEach(function(x){ counts[x.state]=(counts[x.state]||0)+1; });
    var summary=Object.keys(counts).map(function(s){ return counts[s]+' '+s.toLowerCase(); }).join(' · ');
    var rows=items.slice(0,80).map(function(x){ var n=NODES[x.id];
      return '<div class="needrow" data-id="'+x.id+'"><span class="logdot" style="background:'+n.color+'"></span>'
        +'<span class="needstate" style="color:'+n.color+'">'+esc2(x.state)+'</span>'
        +'<span class="logname">'+esc2(n.label)+'</span>'
        +'<span class="logmod">'+esc2(moduleLabelOf(n))+'</span></div>';
    }).join('');
    el.innerHTML='<div class="needsh">Needs attention · '+summary+' — click to jump &amp; open</div><div class="needlist">'+rows+'</div>';
    Array.prototype.forEach.call(el.querySelectorAll('.needrow'), function(r){ r.addEventListener('click', function(){ jumpTo(r.getAttribute('data-id')); }); });
  }
  // ── System Plan poster (static, AI-synthesized) ──────────────────────────
  function planColor(role){ return ({input:'#3d38a8',data:'#1f9d57',logic:'#c9860f',output:'#e0559b',ui:'#7c3aed',other:'#6f6f7a'})[role]||'#6f6f7a'; }
  function layerBy(names, edges){
    var rank={}; names.forEach(function(n){ rank[n]=0; });
    for(var it=0; it<names.length+2; it++){ var ch=false;
      edges.forEach(function(e){ if(rank[e[0]]!=null && rank[e[1]]!=null){ var r=rank[e[0]]+1; if(r>rank[e[1]]){ rank[e[1]]=r; ch=true; } } });
      if(!ch) break; }
    return rank;
  }
  function renderPlan(){
    var el=document.getElementById('plan'); if(!el) return;
    var meta=DATA.meta||{}, P=meta.plan;
    if(!P){ el.innerHTML='<div class="pnote">No system plan yet. Run <b>yay plan</b> (needs an API key in your .env), then regenerate the map.</div>'; return; }
    var subs=P.subsystems||[], flows=P.flows||[], c=meta.counts||{};
    var chips='<span class="pm">'+meta.totalUnits+' cells</span><span class="pm">'+subs.length+' subsystems</span>'
      +'<span class="pm '+(meta.passed?'ok':'bad')+'">gate '+(meta.passed?'PASS':'BLOCKED')+'</span>';
    ['GREEN','YELLOW','RED','UNSIGNED','PINK'].forEach(function(k){ if(c[k]) chips+='<span class="pm dot-'+k+'">'+c[k]+' '+k.toLowerCase()+'</span>'; });
    var rank=layerBy(subs.map(function(s){return s.name;}), flows.map(function(f){return [f.from,f.to];}));
    var cols={}; subs.forEach(function(s){ var r=rank[s.name]||0; (cols[r]=cols[r]||[]).push(s); });
    var colKeys=Object.keys(cols).map(Number).sort(function(a,b){return a-b;});
    var CARDW=272, CARDH=212, COLGAP=210, ROWGAP=64, PADX=34, PADY=34, COLW=CARDW+COLGAP;
    var pos={}, maxRows=1;
    colKeys.forEach(function(r,ci){ cols[r].forEach(function(s,ri){ pos[s.name]={x:PADX+ci*COLW,y:PADY+ri*(CARDH+ROWGAP)}; }); maxRows=Math.max(maxRows,cols[r].length); });
    var W=PADX*2 + colKeys.length*CARDW + Math.max(0,colKeys.length-1)*COLGAP;
    var H=PADY*2 + maxRows*CARDH + Math.max(0,maxRows-1)*ROWGAP;
    var arrows='', labels='', placed=[];
    // Is (lx,ly) on top of any subsystem card? (multi-column flows cross intermediate cards)
    function cardAt(lx,ly){ for(var i=0;i<subs.length;i++){ var q=pos[subs[i].name]; if(!q) continue; if(lx>q.x-6&&lx<q.x+CARDW+6&&ly>q.y-6&&ly<q.y+CARDH+6) return q; } return null; }
    // A spot is clear if it's off every card AND not on top of an already-placed label.
    function clearSpot(lx,ly){ if(cardAt(lx,ly)) return false; for(var i=0;i<placed.length;i++){ if(Math.abs(placed[i].x-lx)<150 && Math.abs(placed[i].y-ly)<26) return false; } return true; }
    flows.forEach(function(f){ var a=pos[f.from], b=pos[f.to]; if(!a||!b||f.from===f.to) return; var x1=a.x+CARDW,y1=a.y+CARDH/2,x2=b.x,y2=b.y+CARDH/2,mx=(x1+x2)/2;
      arrows+='<path d="M'+x1+','+y1+' C'+mx+','+y1+' '+mx+','+y2+' '+x2+','+y2+'" class="parrow" marker-end="url(#pah)"/>';
      if(f.what){ var lx=mx, ly=(y1+y2)/2;
        // nudge off cards and other labels: try the midpoint, then step vertically out
        if(!clearSpot(lx,ly)){ for(var d=1;d<=10;d++){ var down=ly+d*26, up=ly-d*26;
            if(down<H-10&&clearSpot(lx,down)){ ly=down; break; } if(up>10&&clearSpot(lx,up)){ ly=up; break; } } }
        placed.push({x:lx,y:ly});
        labels+='<div class="pflow" style="left:'+lx+'px;top:'+ly+'px">'+esc2(f.what)+'</div>'; } });
    var cards=subs.map(function(s){ var pp=pos[s.name], col=planColor(s.role);
      var cells=(s.modules||[]).reduce(function(sum,mn){ var n=NODES['m:'+mn]; return sum+(n?n.count:0); },0);
      var mods=(s.modules||[]).slice(0,6).map(function(mn){ return '<span class="pmod">'+esc2(mn)+'</span>'; }).join('');
      return '<div class="pcard" style="left:'+pp.x+'px;top:'+pp.y+'px;width:'+CARDW+'px;height:'+CARDH+'px;border-top-color:'+col+'">'
        +'<div class="prole" style="color:'+col+'">'+esc2(s.role||'')+'</div>'
        +'<div class="pname">'+esc2(s.name)+'</div>'
        +'<div class="ppurpose">'+esc2(s.purpose||'')+'</div>'
        +'<div class="pcardfoot">'+(mods?'<div class="pmods">'+mods+'</div>':'')+(cells?'<div class="pcells">'+cells+' cells</div>':'')+'</div>'
        +'</div>'; }).join('');
    // scale the whole diagram to fit the page width — no ugly horizontal scrollbar
    var avail=(el.clientWidth||900)-2; var scale=Math.min(1, avail/W); if(!isFinite(scale)||scale<=0) scale=1;
    var diagram='<div class="pdiagram" style="width:'+W+'px;height:'+H+'px;transform:scale('+scale+');transform-origin:top left">'
      +'<svg class="parrows" width="'+W+'" height="'+H+'"><defs><marker id="pah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>'+arrows+'</svg>'+labels+cards+'</div>';
    el.innerHTML='<div class="pnarr"><h2 class="ptitle">'+esc2(meta.project)+' — System Plan</h2>'
      +'<p class="psys">'+esc2(P.system||'')+'</p><div class="pmetrics">'+chips+'</div></div>'
      +'<div class="pfit" style="height:'+Math.ceil(H*scale)+'px">'+diagram+'</div>'
      +((P.highlights&&P.highlights.length)?'<div class="phi"><div class="phih">Highlights</div><ul>'+P.highlights.map(function(h){return '<li>'+esc2(h)+'</li>';}).join('')+'</ul></div>':'')
      +'<div class="pfoot">Synthesized by '+esc2(P.model||'an LLM')+(P.at?(' · '+esc2(String(P.at).slice(0,10))):'')+' from the signed specs — a view for humans, not a proof.</div>';
  }
  // ── Signers / Owners tab ─────────────────────────────────────────────────
  function acolor(s){ var h=0; for(var i=0;i<String(s).length;i++) h=(h*31+String(s).charCodeAt(i))>>>0; return 'hsl('+(h%360)+' 52% 45%)'; }
  function renderSigners(){
    var el=document.getElementById('signers'); if(!el) return;
    var g=DATA.meta&&DATA.meta.gov;
    if(!g||!g.signers||!g.signers.length){ el.innerHTML='<h1>Signers &amp; Owners</h1><div class="snote">No signers yet — create a key (<b>yay keygen</b> / <b>yay init</b>) or pair a phone (<b>yay pair</b>).</div>'; return; }
    var html='<h1>Signers &amp; Owners</h1>';
    if(g.signedRoster) html+='<div class="rootcard"><div><div class="rootlbl">Trust root</div><div class="rootfp">'+esc2(g.rootFp||'')+'</div></div><div class="snote">Pin this in CI (<b>yay gate</b>). Any swap of the roster fails the gate.</div></div>';
    else html+='<div class="swarn">⚠ Roster is unsigned — anyone with repo write could add a signer. Run <b>yay init</b>/<b>yay keygen</b> to establish a signed trust root.</div>';
    (g.problems||[]).forEach(function(p){ html+='<div class="swarn">✗ '+esc2(p)+'</div>'; });
    g.signers.forEach(function(s){
      var init=(String(s.name).trim().charAt(0)||'?').toUpperCase();
      html+='<div class="srow"><div class="savatar" style="background:'+acolor(s.name)+'">'+esc2(init)+'</div><div style="flex:1;min-width:0">'
        +'<div><span class="sname">'+esc2(s.name)+'</span><span class="srole '+(s.role==='owner'?'owner':'signer')+'">'+esc2(s.role)+'</span></div>'
        +'<div class="smeta">'+s.keys.length+' key'+(s.keys.length===1?'':'s')+' · '+s.approvals+' approval'+(s.approvals===1?'':'s')+' signed</div>'
        +s.keys.map(function(k){ return '<div class="skey">'+(k.kind?'<span class="skeykind">'+esc2(k.kind)+'</span>':'')+'<span>'+esc2(k.fp)+'</span>'+(k.addedAt?'<span style="color:var(--mut)">· added '+esc2(String(k.addedAt).slice(0,10))+'</span>':'')+'</div>'; }).join('')
        +'</div></div>';
    });
    el.innerHTML=html;
  }

  // ── Files tab — classic file tree, problem states marked in colour ────────
  var SEVN={GREEN:0,YELLOW:2,UNSIGNED:3,PINK:4,RED:5};
  function worse(a,b){ return (SEVN[b]||0)>(SEVN[a]||0)?b:a; }
  function renderFiles(){
    var el=document.getElementById('files'); if(!el) return;
    var items=(DATA.meta&&DATA.meta.files)||[];
    if(!items.length){ el.innerHTML='<h1>Files</h1><div class="snote">No files to show.</div>'; return; }
    var tree={_d:{},_f:[]};
    items.forEach(function(it){ var parts=String(it.file).split('/'); var node=tree; for(var i=0;i<parts.length-1;i++){ var d=parts[i]; node._d[d]=node._d[d]||{_d:{},_f:[],_name:d}; node=node._d[d]; } var fname=parts[parts.length-1]; var f=node._f.find(function(x){return x.name===fname;}); if(!f){ f={name:fname,cells:[],worst:'GREEN'}; node._f.push(f);} f.cells.push(it); f.worst=worse(f.worst,it.state); });
    function dot(state){ var col={GREEN:'#1f9d57',YELLOW:'#c9860f',RED:'#cf4436',UNSIGNED:'#7f8796',PINK:'#e0559b'}[state]||'#7f8796'; return '<span class="fdot" style="background:'+col+'"></span>'; }
    function renderDir(node,depth){
      var out='';
      Object.keys(node._d).sort().forEach(function(d){ out+='<div class="frow fdir" style="padding-left:'+(depth*18+10)+'px">▸ '+esc2(d)+'</div>'+renderDir(node._d[d],depth+1); });
      node._f.sort(function(a,b){return a.name.localeCompare(b.name);}).forEach(function(f){
        out+='<div class="frow ffile" style="padding-left:'+(depth*18+10)+'px">'+(f.worst!=='GREEN'?dot(f.worst):'<span class="fdot" style="background:#1f9d57"></span>')+'<span class="fname">'+esc2(f.name)+'</span><span class="fcount">'+f.cells.length+'</span></div>';
        f.cells.sort(function(a,b){return (a.line||0)-(b.line||0);}).forEach(function(cl){ out+='<div class="frow fcell'+(cl.state!=='GREEN'?' bad':'')+'" data-id="'+esc2(cl.id)+'" style="padding-left:'+((depth+1)*18+16)+'px">'+dot(cl.state)+'<span class="funit">'+esc2(cl.name)+'</span><span class="fstate" style="color:'+({GREEN:'#1f9d57',YELLOW:'#c9860f',RED:'#cf4436',UNSIGNED:'#7f8796',PINK:'#e0559b'}[cl.state]||'#7f8796')+'">'+esc2(cl.state)+'</span></div>'; });
      });
      return out;
    }
    el.innerHTML='<h1>Files</h1><div class="snote" style="margin:0 0 12px">Every file and its Cells. Green ones are proven; anything <b>yellow / red / unsigned / pink</b> is coloured so it stands out. Click a Cell to open it.</div><div class="ftree">'+renderDir(tree,0)+'</div>';
    Array.prototype.forEach.call(el.querySelectorAll('.fcell'),function(r){ r.addEventListener('click',function(){ openDetail(r.getAttribute('data-id')); }); });
  }

  // ── tabs ──────────────────────────────────────────────────────────────────
  var MAP_ELS=['.pagehead','.legend','#needs','.hint','#crumb','.stage','.logwrap','.foot'];
  function showSel(sel,on){ var e=document.querySelector(sel); if(e) e.style.display=on?'':'none'; }
  var curTab='map';
  function setTab(name){
    curTab=name;
    MAP_ELS.forEach(function(s){ showSel(s, name==='map'); });
    showSel('#plan', name==='plan'); showSel('#signers', name==='signers'); showSel('#files', name==='files'); showSel('#commands', name==='commands');
    Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(b){ b.classList.toggle('active', b.getAttribute('data-tab')===name); });
    if(name==='plan') renderPlan();
    if(name==='signers') renderSigners();
    if(name==='files') renderFiles();
  }
  (function(){
    var tp=document.getElementById('tab-plan'); if(tp && DATA.meta && DATA.meta.plan) tp.style.display='';
    Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(b){ b.addEventListener('click',function(){ setTab(b.getAttribute('data-tab')); }); });
  })();

  window.addEventListener('resize',function(){ if(curTab==='plan') renderPlan(); else if(curTab==='map') draw(); });
  draw();
  renderNeeds();
  renderLog();
})();
(function(){
  var modal=document.getElementById('modal');
  function close(){ modal.classList.remove('open'); document.body.style.overflow=''; }
  modal.addEventListener('click',function(e){ if(e.target===modal) close(); });
  modal.querySelector('.modal-close').addEventListener('click',close);
  document.addEventListener('keydown',function(e){ if(e.key==='Escape') close(); });
})();
(function(){
  var root=document.documentElement, btn=document.getElementById('themebtn');
  function current(){ return root.getAttribute('data-theme') || 'light'; } // white by default; dark is opt-in
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
