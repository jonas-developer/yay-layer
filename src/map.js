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

// Light syntax highlighting for the code panel — subtle, readable on the dark code bg.
// Runs on the already-ESCAPED line (esc() leaves quotes intact, so string matching still
// works). Single pass; strings come first so a `//` inside a string isn't read as a comment.
function hlCode(escLine) {
  return escLine.replace(
    /("[^"]*"|'[^']*'|`[^`]*`)|(\/\/.*$)|(\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|typeof|instanceof|await|async|yield|throw|try|catch|finally|import|export|from|as|default|null|true|false|undefined|void|delete)\b)|(\b\d[\w.]*\b)/g,
    (m, str, com, kw, num) => {
      if (str) return `<span class="tk-s">${str}</span>`;
      if (com) return `<span class="tk-c">${com}</span>`;
      if (kw) return `<span class="tk-k">${kw}</span>`;
      if (num) return `<span class="tk-n">${num}</span>`;
      return m;
    });
}

const COMMANDS = [
  { cmd: 'yay init [dir]', desc: 'Guided setup: files → signing key → adopt → Brief tags → Constitution → optional System Plan. Signing key: local, mobile over your LAN, or mobile over relay.yaylayer.com (for off-LAN, end-to-end encrypted).', flags: [['--key local|mobile', 'signing-key type (mobile = pair your phone)'], ['--relay / --lan', 'mobile transport: hosted relay.yaylayer.com (off-LAN) or your local network'], ['--name <you>', 'signer name on every seal'], ['--tags <set>', 'Brief-tag starter set (technical, responsibility, component, layer, area, product)'], ['--adopt / --no-adopt', 'scaffold specs over existing code'], ['--constitution <keys|all>', 'write the Constitution into AI-harness files'], ['--plan / --no-plan', 'enable AI System Plan'], ['--provider anthropic|openai|custom', 'plan LLM (+ --base-url, --model, --api-key)']] },
  { cmd: 'yay keygen --name <you>', desc: 'Create your ed25519 signing key (public → roster, private → encrypted keystore).', flags: [['--passphrase <p>', 'or the YAY_PASSPHRASE env var']] },
  { cmd: 'yay pair [--name you]', desc: 'Pair your phone as the signer — scan the QR; the private key stays on the phone. The FIRST pairing (no roster yet) makes the phone the trust root itself, so no local key is ever needed. Served over HTTPS by default.', flags: [['--name <you>', 'attach the phone key to this identity'], ['--relay / --lan', 'route via relay.yaylayer.com (off-LAN, E2E) or the local network'], ['--no-https', 'disable TLS (default: mkcert-trusted cert if available, else self-signed)']] },
  { cmd: 'yay enroll --name X --pubkey <b64>', desc: 'Enroll another signer via an OWNER-signed roster event.', flags: [['--role owner|signer', 'role to grant (default signer)'], ['--by <owner>', 'which owner authorizes it'], ['--phone', 'authorize on an owner’s phone (no local key needed)']] },
  { cmd: 'yay invite "Bob"', desc: 'Mint a 30-min, one-time link a teammate opens to request to join — they make their key, you get an approval on your phone (verify the 6-digit code, tap Approve). No pubkey to copy. Needs a running dashboard.', flags: [['--role owner|signer', 'role to grant on approval (default signer; owner can enroll/revoke others)']] },
  { cmd: 'yay revoke --name X', desc: 'Revoke a compromised/rotated key (or a whole identity) via an owner-signed event. Past approvals stay attributed; refuses if it would leave no owner.', flags: [['--pubkey <b64>', 'revoke just this key (omit to remove the whole identity)'], ['--phone', 'authorize on an owner’s phone']] },
  { cmd: 'yay reroot', desc: 'Retire the current trust root and establish a new one — recovery for a lost/compromised root key. A trust discontinuity: re-sign specs and repoint the CI pin afterward.', flags: [['--phone', 'root the new key on your phone (phone-as-genesis)'], ['--name <you>', 'new local owner name'], ['--force', 'skip the confirmation prompt']] },
  { cmd: 'yay adopt [path]', desc: 'Scaffold draft (unsigned) spec blocks over existing code.', flags: [['--dry', 'preview what would be added']] },
  { cmd: 'yay sign [--cell IDs]', desc: 'Approve the current specs — appends a signed seal. Uses THIS project’s signing method automatically (phone or local); no flag needed. If a dashboard is running, the request pops up on the phone you already scanned.', flags: [['--brief "<text>"', 'the signed Brief prose, REQUIRED by default (read-only on the phone: Accept or Send back; prompted if omitted at a terminal)'], ['--title "<headline>"', 'a short title over the Brief — the scannable headline in the ledger, clouds and phone'], ['--tags "A,B"', 'tag the Brief from the project pool (see yay tags) — required when a pool exists; --no-tags to skip'], ['--name "<signer>"', 'sign as / route to that signer — a teammate over relay gets it in their inbox (fire-and-return, returns a request id)'], ['--check [id]', 'collect a routed teammate’s signature and write the seal'], ['--phone / --local', 'force the device (default = the project’s method)'], ['--no-brief', 'skip the Brief for a trivial re-sign'], ['--relay / --lan', 'phone transport override'], ['--cell <ids>', 'only these Cells (comma-separated)']] },
  { cmd: 'yay inbox', desc: 'Print YOUR on-duty relay link (+ QR) — open it on your phone and leave it up to receive approval requests teammates address to you with `yay sign --name "You"`.', flags: [] },
  { cmd: 'yay requests [done <id>]', desc: 'The AI’s inbox of plain requests queued from the dashboard’s “Request a change” button. The AI turns each into a polished Brief + Cells to sign.', flags: [['done <id> / clear', 'remove a handled request (or all)']] },
  { cmd: 'yay tags [--set id]', desc: 'The project’s Brief-tag vocabulary — every Brief is tagged from it, so work can be sorted by concern over time. Six starter sets or a blank custom set; edit here or live in the dashboard Tags tab.', flags: [['--set <id>', 'switch to a starter set (technical, responsibility, component, layer, area, product) or custom (blank placeholders)'], ['add "Tag" / remove "Tag"', 'edit the pool'], ['rename "A" "B"', 'relabel a tag — blocked once it is used in a signed Brief (would split history)'], ['desc "Tag" "…"', 'set a tag’s description'], ['sets', 'list the six starter sets and their tags']] },
  { cmd: 'yay policy [--init|--set]', desc: 'Signing policy — who must sign what (neutral by default). A rule requires a specific person to sign Cells matched by path glob, spec tag, or module; the gate blocks any match they haven’t signed. Edit the draft in the dashboard Policy tab or the file, then --set owner-signs it into the roster (tamper-evident).', flags: [['--init', 'write a commented policy.json template'], ['--set', 'owner-sign the draft policy.json into effect (routes to your phone)']] },
  { cmd: 'yay grant [--for 2h] [--count 20]', desc: 'FREEDOM MODE: an owner-signed grant lets the AI auto-approve in-scope, non-sensitive Cells unattended until it expires or hits the count. Sensitive / code-pinned Cells always still need a real signature.', flags: [['--for <dur>', 'time window, e.g. 2h, 90m, 1d (default 2h)'], ['--count <n>', 'max auto-approvals (default 20)'], ['--cell <ids>', 'scope to named Cells (else all non-sensitive)'], ['list / revoke [id]', 'show active grants / stop one']] },
  { cmd: 'yay ratify [--sign]', desc: 'List Cells auto-approved under a grant (delegated, not human-reviewed); --sign signs them for real.', flags: [['--sign', 'sign the delegated approvals for real (human)']] },
  { cmd: 'yay verify [--strict] [-d]', desc: 'The gate: paint every Cell + run the behavioural prover & mutation grading.', flags: [['--strict', 'non-zero exit if blocked (for CI)'], ['-d, --details', 'print each spec, code & checks'], ['--problems', 'show only non-green Cells'], ['--no-mutate', 'skip mutation grading']] },
  { cmd: 'yay test [--test "cmd"]', desc: 'Run the project’s OWN test suite (package.json "test" / config.test) — the runtime backstop for what per-Cell checks can’t reach. Non-zero exit on failure (for CI).', flags: [['--test "<cmd>"', 'the command to run (else package.json test)']] },
  { cmd: 'yay adversary [--cell IDs]', desc: 'Spec-only adversary: an LLM sees ONLY each Cell’s spec (never the code) and writes probes to BREAK it, run against the real code. A break is a genuine spec↔code violation. Needs an LLM key.', flags: [['--cell <ids>', 'only these Cells'], ['--provider …', 'same provider config as the System Plan']] },
  { cmd: 'yay plan', desc: 'AI-synthesize the high-level System Plan → .yaylayer/plan.json.', flags: [['--provider anthropic|openai|custom', 'LLM provider (key from .env)'], ['--base-url <url>', 'custom / OpenAI-compatible endpoint (Ollama, LM Studio, vLLM — key optional)'], ['--model <m>', 'model id']] },
  { cmd: 'yay map [-o file.html]', desc: 'Write this HTML site (Map / Files / System Plan / Briefs / Tags / Policy / Signers / Commands).', flags: [['-o <file>', 'output path'], ['--no-plan', 'omit the System Plan entirely'], ['--replan', 'force plan regeneration']] },
  { cmd: 'yay dashboard [--port N]', desc: 'Live control panel + phone relay: serves the map (auto-refreshes) with on-demand buttons — ➕ Request a change (queue a request your AI turns into a Brief to sign), ▷ Preview (run a package.json script — dev server, build — with a live link + Stop), Changes, Run tests, Adversary, Regenerate System Plan — AND routes pair/sign/authorize to the phone you scanned ONCE. Has Briefs, Tags and Policy tabs. Leave it running. HTTPS by default; the phone installs the cert from the /trust page for warning-free https.', flags: [['--port <n>', 'port (default 48757)'], ['--open', 'open it in your browser'], ['--no-https', 'disable TLS (default: mkcert-trusted cert if available, else self-signed)']] },
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
    const html = hlCode(esc(l));
    return (t && bad.has(t)) ? `<span class="badline">${html}</span>` : html;
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
  // What changed in THIS Cell's spec since the last commit (old red / new green).
  const diffSection = (cell.diff && cell.diff.length)
    ? `<div class="dh">Changes since last commit</div><pre class="code diff">${cell.diff.map((d) => {
      const cls = d.t === '+' ? 'dl-add' : d.t === '-' ? 'dl-del' : 'dl-ctx';
      return `<span class="${cls}">${esc((d.t === '+' ? '+ ' : d.t === '-' ? '- ' : '  ') + d.text)}</span>`;
    }).join('\n')}</pre>`
    : '';
  // green ≠ proven: show whether the promise is machine-proven or only signed.
  const provBadge = (res.state === 'GREEN' && res.hasEnsures)
    ? `<span class="mpill" style="color:${res.proven ? 'var(--accent)' : 'var(--amber)'};margin-left:6px" title="${res.proven ? 'ensures machine-proven' : 'signed, but its ensures is not machine-checked — strengthen it'}">${res.proven ? '✓ proven' : '● unproven'}</span>`
    : '';
  // Freedom mode: mark Cells approved by a delegation grant (not a human) — awaiting ratification.
  const autoBadge = (res.trust && res.trust.auto)
    ? `<span class="mpill" style="color:var(--amber);margin-left:6px" title="Auto-approved under grant ${esc(res.trust.grant || '')} — delegated, NOT human-reviewed. Run \`yay ratify\` to sign it for real.">⚡ AUTO</span>`
    : '';
  return `<div class="mhead"><span class="mid">${esc(cell.id)}</span><span class="mname">${esc(cell.unitName || cell.spec.unit || cell.id)}</span><span class="mpill" style="color:${col}">${label}</span>${provBadge}${autoBadge}</div>
    <div class="dmeta">${meta.map((m) => `<span>${m}</span>`).join('')}</div>
    <div class="dh">Sealed spec</div><pre class="code">${colorizeSpec(cell.specBlock)}</pre>
    ${diffSection}
    ${body}
    ${history}
    ${impact}
    ${checks}`;
}

function renderMap(manifest, verified, project, changes, times, planDoc, gov, briefs, tagCfg, policyInfo, tagSets, batchCfg) {
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
    const grpId = 'g:' + module + '\u0000' + group;
    const unitId = 'u:' + id;
    const m = ensure(modId, module, 'module', 'system');
    if (!nodes.system.children.includes(modId)) nodes.system.children.push(modId);
    const g = ensure(grpId, group, 'group', modId);
    if (!m.children.includes(grpId)) m.children.push(grpId);
    nodes[unitId] = { id: unitId, label: cell.unitName || cell.spec.unit || id, kind: 'unit', parent: grpId, children: [], state: res.state, cellId: cell.id, intent: cell.spec.intent || '', blast: res.blast || 0, bloat: !!res.bloat, auto: !!(res.trust && res.trust.auto) };
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
    YLnodes[id] = { id, label: n.label, kind: n.kind, color: COLORS[n.state][0], state: n.state, count: n.count || 1, children: n.children, parent: n.parent, intent: n.intent || '', blast: n.blast || 0, bloat: !!n.bloat, auto: !!n.auto };
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
  // Per-Cell spec-block character count — so the Briefs "Chart" view can plot the growth
  // of signed Specs + Briefs over time (a Brief's weight = its own chars + its Cells' specs).
  const specChars = {};
  for (const id of Object.keys(manifest.cells)) { const c = manifest.cells[id]; if (c) specChars[id] = (c.specBlock || '').length; }
  const meta = { project: project || 'project', counts: verified.counts, passed: verified.passed, totalUnits, plan: planDoc || null, gov: gov || null, files: FILES, briefs: briefs || [], specChars, tags: (tagCfg && tagCfg.tags) || [], tagSet: (tagCfg && tagCfg.set) || null, tagDescriptions: (tagCfg && tagCfg.descriptions) || {}, tagSets: tagSets || [], batch: batchCfg || { enabled: true, barrier: 5 }, policy: policyInfo || { enforced: [], draft: [], violations: [], signers: [] } };
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
.navburger{display:none;align-items:center;justify-content:center;width:38px;height:36px;font-size:1.05rem;line-height:1;background:var(--card);color:var(--ink);border:1px solid var(--rule);border-radius:8px;cursor:pointer}
.navburger:hover{border-color:var(--mut)}
.navmenu{display:none}
@media(max-width:820px){
  .nav-in{padding:0 16px;height:52px}
  .wrap{padding:20px 16px 72px}
  .brandproj{max-width:34vw}
  .tabs{display:none}
  .navburger{display:inline-flex}
  .navmenu{flex-direction:column;gap:3px;padding:8px 16px 14px;border-top:1px solid var(--rule);background:var(--paper)}
  .navmenu.open{display:flex}
  .navmenu .tab{width:100%;text-align:left;font-size:1rem;padding:12px;border-radius:8px;background:var(--card2)}
  .navmenu .tab.active{background:var(--brand);color:#04231a}
  .legend{font-size:.74rem;gap:7px}
  .lg{padding:6px 12px}
  h1{font-size:1.25rem}
  .wrap>*{min-width:0}
}
.signers{margin-top:4px;max-width:900px}
.rootcard{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;background:var(--card2);border:1px solid var(--rule);border-radius:12px;padding:16px 18px;margin:0 0 20px}
.rootlbl{font-family:var(--sans);font-size:.68rem;font-weight:600;text-transform:uppercase;letter-spacing:.07em;color:var(--ink2)}
.rootfp{font-family:var(--mono);font-size:1.05rem;font-weight:700;color:var(--ink);margin-top:2px}
.srow{display:flex;align-items:flex-start;gap:14px;border:1px solid var(--rule);border-radius:12px;padding:15px 18px;margin:0 0 10px;background:var(--card);box-shadow:var(--shadow)}
.mcell{display:inline-block;font-family:var(--mono);font-size:.78rem;padding:2px 9px;margin:5px 6px 0 0;border-radius:7px;border:1px solid var(--rule);color:var(--mut)}
.mcell.known{cursor:pointer;color:var(--accent);border-color:var(--accent)}
.mcell.known:hover{background:var(--accent);color:#fff}
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
.pleader{fill:none;stroke:var(--mut);stroke-width:1.5;opacity:.4;stroke-dasharray:3 3}
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
pre.code.diff .dl-add{color:#54d98c}pre.code.diff .dl-del{color:#ff8f86}pre.code.diff .dl-ctx{color:var(--codeink);opacity:.65}
pre.code .sp-intent{color:var(--blue);font-weight:600}
pre.code .sp-ensures{color:var(--purple);font-weight:600}
pre.code .tk-k{color:#a9b7ff}
pre.code .tk-s{color:#8fcaa4}
pre.code .tk-n{color:#e2b07e}
pre.code .tk-c{color:#7f8c84;font-style:italic}
.badline .tk-k,.badline .tk-s,.badline .tk-n,.badline .tk-c{color:inherit}
.checks{margin:0;padding:0;list-style:none;font-size:.84rem}.checks li{margin:5px 0;line-height:1.5}
.ck-red{color:var(--red);font-weight:600}.ck-yellow{color:var(--amber)}.ck-info{color:var(--mut)}
.allok{font-size:.84rem;color:var(--mut)}
</style></head><body>
<header class="nav"><div class="nav-in">
<div class="brand"><span class="logo"><svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><rect width="26" height="26" rx="7" fill="#3ecf8e"/><path d="M6.5 13.5l4 4L20 7.5" fill="none" stroke="#04231a" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg></span><span class="brandname">YayLayer</span><span class="brandsep">/</span><span class="brandproj">${esc(project || 'project')}</span></div>
<div class="nav-right"><nav class="tabs"><button class="tab active" data-tab="map">Map</button><button class="tab" data-tab="files">Files</button><button class="tab" data-tab="plan" id="tab-plan" style="display:none">System Plan</button><button class="tab" data-tab="briefs">Briefs</button><button class="tab" data-tab="tags" id="tab-tags" style="display:none">Tags</button><button class="tab" data-tab="policy" id="tab-policy" style="display:none">Policy</button><button class="tab" data-tab="signers">Signers</button><button class="tab" data-tab="commands">Commands</button></nav><button id="themebtn" class="themebtn" aria-label="Toggle theme">Dark</button><button id="navburger" class="navburger" aria-label="Menu" aria-expanded="false">☰</button></div>
</div>
<div id="navmenu" class="navmenu"><button class="tab active" data-tab="map">Map</button><button class="tab" data-tab="files">Files</button><button class="tab" data-tab="plan" style="display:none">System Plan</button><button class="tab" data-tab="briefs">Briefs</button><button class="tab" data-tab="tags" style="display:none">Tags</button><button class="tab" data-tab="policy" style="display:none">Policy</button><button class="tab" data-tab="signers">Signers</button><button class="tab" data-tab="commands">Commands</button></div>
</header>
<div class="wrap">
<div class="pagehead"><h1>System map</h1><p class="sub">${totalUnits} units · ${verified.passed ? 'gate PASS' : 'gate BLOCKED'}${verified.counts.GREEN ? ` · ${verified.counts.proven || 0} proven / ${verified.counts.unproven || 0} unproven` : ''}</p></div>
<div class="legend">${legend}</div>
<div id="needs" class="needs"></div>
<p class="hint">A drill-down tree. The box on the <b>left is where you are</b>; its contents branch to the right. Click a <b>container ›</b> to zoom into it, click the left box or <b>↑ Up a level</b> to zoom out, and click a <b>unit</b> to open its spec, code &amp; checks.</p>
<div class="crumb" id="crumb"></div>
<div class="stage"><svg id="graph"></svg></div>
<div class="logwrap"><div class="logh">Recent changes</div><ol id="log" class="log"></ol></div>
<div id="plan" class="plan" style="display:none"></div>
<div id="briefs" class="signers" style="display:none"></div>
<div id="tags" class="signers" style="display:none"></div>
<div id="policy" class="signers" style="display:none"></div>
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
      var rightU = n.kind==='unit' ? [(n.auto?'⚡':''),(n.blast?'▲'+n.blast:(n.bloat?'unused?':''))].filter(Boolean).join(' ') : String(n.count);
      var hasRight = n.kind!=='unit' ? true : !!rightU;
      var cy=topPad+i*rowH+childH/2, w=widthFor(n.label,hasRight);
      var x1=rootRight, y1=rootY, x2=childX, mx=(x1+x2)/2;
      mk(linkG,'path',{'class':'link',d:'M'+x1+','+y1+' C'+mx+','+y1+' '+mx+','+cy+' '+x2+','+cy});
      var g=document.createElementNS(NS,'g'); g.setAttribute('class','gnode'+(n.kind==='unit'?' leaf':'')); nodeG.appendChild(g);
      mk(g,'rect',{'class':'gbox',x:childX,y:cy-childH/2,width:w,height:childH,rx:9,stroke:n.color,'stroke-width':n.kind==='unit'?2:2.5});
      txt(g,childX+14,cy,'glabel',short(n.label),'start');
      if(n.kind!=='unit'){ txt(g,childX+w-24,cy,'gcount',String(n.count),'end'); txt(g,childX+w-11,cy,'gchev','›','end'); }
      else if(rightU){ txt(g,childX+w-12,cy,(n.auto||n.bloat)?'gbloat':'gcount',rightU,'end'); }
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
    var arrows='', labels='', leaders='', placed=[];
    var cardBottom=PADY + maxRows*CARDH + Math.max(0,maxRows-1)*ROWGAP; // y just under the lowest card
    var belowY=cardBottom+34; // a lane BELOW the cards for labels that would otherwise cover one
    // Is (lx,ly) on top of any subsystem card? (multi-column flows cross intermediate cards)
    function cardAt(lx,ly){ for(var i=0;i<subs.length;i++){ var q=pos[subs[i].name]; if(!q) continue; if(lx>q.x-6&&lx<q.x+CARDW+6&&ly>q.y-6&&ly<q.y+CARDH+6) return q; } return null; }
    function labelClash(lx,ly){ for(var i=0;i<placed.length;i++){ if(Math.abs(placed[i].x-lx)<150 && Math.abs(placed[i].y-ly)<24) return true; } return false; }
    flows.forEach(function(f){ var a=pos[f.from], b=pos[f.to]; if(!a||!b||f.from===f.to) return; var x1=a.x+CARDW,y1=a.y+CARDH/2,x2=b.x,y2=b.y+CARDH/2,mx=(x1+x2)/2;
      arrows+='<path d="M'+x1+','+y1+' C'+mx+','+y1+' '+mx+','+y2+' '+x2+','+y2+'" class="parrow" marker-end="url(#pah)"/>';
      if(f.what){ var lx=mx, ly=(y1+y2)/2;
        if(cardAt(lx,ly)){
          // The midpoint sits on a card (a flow that spans/crosses one). NEVER draw over a
          // card — drop the label into the lane below the cards, with a faint leader line.
          lx=Math.min(Math.max(mx,100),W-100); ly=belowY; belowY+=30;
          leaders+='<path d="M'+mx+','+cardBottom+' L'+lx+','+(ly-11)+'" class="pleader"/>';
        } else if(labelClash(lx,ly)){
          // Only clashing with another label in the gap — nudge vertically, staying off cards.
          for(var d=1;d<=6;d++){ var up=ly-d*22, down=ly+d*22;
            if(up>PADY && !cardAt(lx,up) && !labelClash(lx,up)){ ly=up; break; }
            if(down<cardBottom-8 && !cardAt(lx,down) && !labelClash(lx,down)){ ly=down; break; } }
        }
        placed.push({x:lx,y:ly});
        labels+='<div class="pflow" style="left:'+lx+'px;top:'+ly+'px">'+esc2(f.what)+'</div>'; } });
    if(belowY>cardBottom+34) H=Math.max(H, belowY+16); // grow the canvas to fit the below-lane
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
      +'<svg class="parrows" width="'+W+'" height="'+H+'"><defs><marker id="pah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="currentColor"/></marker></defs>'+leaders+arrows+'</svg>'+labels+cards+'</div>';
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

  // ── Briefs tab — the plain-English ledger of what was ordered (Standard §5) ──
  var briefTagFilter=null, briefGroupBy=false, briefView='list'; // Briefs-tab view state
  var briefChartTag=null, briefChartSigner=null; // Chart-view filters (tag / signer / both)
  function renderBriefs(){
    var el=document.getElementById('briefs'); if(!el) return;
    var ms=(DATA.meta&&DATA.meta.briefs)||[];
    if(!ms.length){ el.innerHTML='<h1>Briefs</h1><div class="snote">No briefs yet. A Brief is the plain-English record of what you ordered, signed together with each change-set. Sign with <b>yay sign --brief "…"</b> (your AI supplies it automatically).</div>'; return; }
    var lc=function(s){return String(s).toLowerCase();};
    function cellChips(cells){ return (cells||[]).map(function(c){ var uid='u:'+c; var known=!!DETAILS[uid]; return '<span class="mcell'+(known?' known':'')+'"'+(known?(' data-uid="'+esc2(uid)+'"'):'')+' title="'+(known?'Open this Cell':'This Cell is no longer in the codebase')+'">'+esc2(c)+'</span>'; }).join(''); }
    function briefCard(m){
      var when=m.at?String(m.at).slice(0,10):'';
      var cells=m.cells||[]; var valid=m.valid!==false; var bar=valid?'var(--accent)':'#cf4436';
      var badge=valid?'<span style="font-size:.72rem;font-weight:700;color:#1f9d57" title="Signature verifies against a trusted signer">✓ signed</span>':'<span style="font-size:.72rem;font-weight:700;color:#cf4436" title="This seal does NOT verify — the brief or approval was tampered with, or it was not signed by a trusted key">⚠ seal invalid</span>';
      var tagline=(m.tags&&m.tags.length)?('<div style="margin:0 0 8px">'+m.tags.map(function(t){var on=briefTagFilter&&lc(t)===lc(briefTagFilter);return '<span class="btag" data-tag="'+esc2(t)+'" title="Filter Briefs by this tag" style="display:inline-block;font-size:.68rem;font-weight:700;padding:2px 9px;border-radius:100px;border:1px solid '+(on?'var(--accent)':'var(--rule)')+';margin:0 5px 4px 0;cursor:pointer;'+(on?'background:var(--accent);color:#fff':'color:var(--accent)')+'">'+esc2(t)+'</span>';}).join('')+'</div>'):'';
      return '<div style="border:1px solid var(--rule);border-left:3px solid '+bar+';border-radius:12px;padding:14px 16px;margin:0 0 12px;background:var(--card2)">'
        +'<div style="display:flex;justify-content:space-between;gap:12px;align-items:baseline;margin-bottom:6px"><span style="font-weight:800;letter-spacing:.06em;font-size:.72rem;color:var(--accent)">BRIEF '+esc2(m.id||'')+'</span><span style="font-size:.78rem;color:var(--mut)">'+badge+' · '+esc2(when)+(m.signer?(' · '+esc2(m.signer)):'')+'</span></div>'
        +(m.title?('<div style="font-size:1.06rem;font-weight:800;color:var(--ink);margin-bottom:3px">'+esc2(m.title)+'</div>'):'')
        +'<div style="font-size:'+(m.title?'.92rem':'1.02rem')+';line-height:1.45;color:'+(m.title?'var(--mut)':'var(--ink)')+';margin-bottom:8px">'+esc2(m.text||'')+'</div>'+tagline
        +'<div style="font-size:.8rem;color:var(--mut)">covers '+cells.length+' part'+(cells.length===1?'':'s')+(cells.length?' — click to open:':'')+'</div>'
        +(cells.length?('<div style="margin-top:2px">'+cellChips(cells)+'</div>'):'')+'</div>';
    }
    // ── Chart view: cumulative characters of signed Specs + Briefs over time, filterable
    // by tag and/or signer. A Brief's "weight" = its own chars (title + prose) plus the
    // spec-block chars of every Cell it covers (DATA.meta.specChars).
    var specChars=(DATA.meta&&DATA.meta.specChars)||{};
    function briefChars(b){ var s=(b.title||'').length+(b.text||'').length; (b.cells||[]).forEach(function(c){ s+=(specChars[c]||0); }); return s; }
    function chartControls(){
      var pool=(DATA.meta&&DATA.meta.tags)||[];
      var signers=[]; ms.forEach(function(b){ if(b.signer&&signers.indexOf(b.signer)<0) signers.push(b.signer); });
      var selCss='padding:7px 10px;border-radius:8px;border:1px solid var(--rule);background:var(--paper);color:var(--ink);font-family:inherit;font-size:.82rem';
      var tagOpts='<option value="">All tags</option>'+pool.map(function(t){return '<option value="'+esc2(t)+'"'+(briefChartTag&&lc(t)===lc(briefChartTag)?' selected':'')+'>#'+esc2(t)+'</option>';}).join('');
      var sigOpts='<option value="">All signers</option>'+signers.map(function(s){return '<option value="'+esc2(s)+'"'+(briefChartSigner&&lc(s)===lc(briefChartSigner)?' selected':'')+'>'+esc2(s)+'</option>';}).join('');
      var reset=(briefChartTag||briefChartSigner)?'<span id="bf-creset" style="font-size:.78rem;color:var(--accent);cursor:pointer;text-decoration:underline">reset</span>':'';
      return '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 12px"><span style="font-size:.8rem;color:var(--mut)">Filter:</span><select id="bf-ct" style="'+selCss+'">'+tagOpts+'</select><select id="bf-cs" style="'+selCss+'">'+sigOpts+'</select>'+reset+'</div>';
    }
    function chartSVG(list){
      if(!list.length) return '<div class="snote">No Briefs match this filter.</div>';
      var pts=[], cum=0, tmin=Infinity, tmax=-Infinity;
      list.forEach(function(b){ cum+=briefChars(b); var t=Date.parse(b.at||'')||0; if(t<tmin)tmin=t; if(t>tmax)tmax=t; pts.push({t:t,y:cum,b:b}); });
      var ymax=cum||1, n=list.length;
      var W=760,H=340,L=58,R=20,Tp=18,Bp=46, pw=W-L-R, ph=H-Tp-Bp, same=(tmax<=tmin);
      function X(i,t){ return same?(n<=1?L+pw/2:L+(i/(n-1))*pw):(L+(t-tmin)/(tmax-tmin)*pw); }
      function Y(v){ return Tp+ph-(v/ymax)*ph; }
      var line='', dots='', pdata=[], dr=Math.max(1.4, 4-Math.floor(n/25)); // dots shrink as points crowd (a year of dailies stays legible; the line always reads)
      pts.forEach(function(p,i){ var x=X(i,p.t), y=Y(p.y); line+=(i?' L':'M')+x.toFixed(1)+','+y.toFixed(1);
        pdata.push({x:+x.toFixed(1),y:+y.toFixed(1),d:String(p.b.at||'').slice(0,10),t:(p.b.title||''),bt:(p.b.text||''),c:briefChars(p.b),v:p.y,s:p.b.signer||'',id:(p.b.id||'')});
        dots+='<circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="'+dr+'" fill="var(--accent)"'+(dr>=3?' stroke="var(--card2)" stroke-width="1.5"':'')+'><title>'+esc2((p.b.title||p.b.text||'')+' — +'+briefChars(p.b)+' chars → '+p.y+' total · '+String(p.b.at||'').replace('T',' ').slice(0,16)+(p.b.signer?' · '+p.b.signer:''))+'</title></circle>'; });
      var pattr=esc2(JSON.stringify(pdata)).replace(/"/g,'&quot;');
      var x0=X(0,pts[0].t), xl=X(n-1,pts[n-1].t), y0=Y(0);
      var area='M'+x0.toFixed(1)+','+y0.toFixed(1)+' '+line.replace(/^M/,'L')+' L'+xl.toFixed(1)+','+y0.toFixed(1)+' Z';
      var yt=''; for(var k=0;k<=4;k++){ var v=ymax*k/4, yy=Y(v); yt+='<line x1="'+L+'" y1="'+yy.toFixed(1)+'" x2="'+(W-R)+'" y2="'+yy.toFixed(1)+'" stroke="var(--rule)" stroke-width="1" opacity="0.55"/><text x="'+(L-8)+'" y="'+(yy+3.5).toFixed(1)+'" text-anchor="end" font-size="10" fill="var(--mut)">'+(v>=1000?(Math.round(v/100)/10)+'k':Math.round(v))+'</text>'; }
      var xt='', idxs=(n<=1)?[0]:(n<=3?pts.map(function(_,i){return i;}):[0,Math.floor((n-1)/2),n-1]);
      idxs.forEach(function(i){ var x=X(i,pts[i].t); xt+='<text x="'+x.toFixed(1)+'" y="'+(H-24)+'" text-anchor="middle" font-size="10" fill="var(--mut)">'+esc2(String(pts[i].b.at||'').slice(0,10))+'</text>'; });
      return '<div id="bf-chartwrap" style="position:relative;border:1px solid var(--rule);border-radius:14px;background:var(--card2);padding:14px 12px 8px;overflow-x:auto">'
        +'<svg id="bf-chartsvg" data-pts="'+pattr+'" viewBox="0 0 '+W+' '+H+'" style="width:100%;min-width:520px;height:auto;display:block;cursor:crosshair">'
        +yt+'<path d="'+area+'" fill="var(--accent)" opacity="0.10"/><path d="'+line+'" fill="none" stroke="var(--accent)" stroke-width="2"/>'+dots
        +'<text x="'+L+'" y="'+(Tp+1)+'" font-size="10" fill="var(--mut)">cumulative chars — Specs + Briefs</text>'+xt+'</svg>'
        +'<div style="font-size:.75rem;color:var(--mut);padding:6px 4px 2px">'+n+' Brief'+(n===1?'':'s')+' · '+ymax+' total characters signed'+(briefChartTag?(' · #'+esc2(briefChartTag)):'')+(briefChartSigner?(' · '+esc2(briefChartSigner)):'')+'. Hover to preview a Brief; click a point to open it.</div></div>';
    }
    // Hover the line: a small white bubble shows the nearest Brief — its title in a
    // readable size, the full Brief text in smaller letters below.
    function setupChartLens(){
      var svg=document.getElementById('bf-chartsvg'), wrap=document.getElementById('bf-chartwrap');
      if(!svg||!wrap) return; var pd; try{ pd=JSON.parse(svg.getAttribute('data-pts')||'[]'); }catch(e){ pd=[]; }
      if(!pd.length) return; var VW=760, VH=340;
      var oldTip=document.getElementById('bf-chart-tip'); if(oldTip) oldTip.remove(); // a body-level tip from a previous render would otherwise leak
      var tip=document.createElement('div'); tip.id='bf-chart-tip'; tip.style.cssText='position:fixed;pointer-events:none;opacity:0;transition:opacity .1s ease;z-index:9999;max-width:230px;background:#fff;border:1px solid rgba(0,0,0,0.10);border-radius:12px;box-shadow:0 10px 28px rgba(0,0,0,0.22);padding:9px 12px;text-align:left;font-weight:400'; document.body.appendChild(tip);
      var mark=document.createElement('div'); mark.style.cssText='position:absolute;pointer-events:none;opacity:0;transition:opacity .1s ease;z-index:29;width:14px;height:14px;border-radius:50%;border:2px solid var(--accent);background:#fff;box-shadow:0 0 0 3px rgba(0,0,0,0.05)'; wrap.appendChild(mark);
      function hide(){ tip.style.opacity='0'; mark.style.opacity='0'; tip._key=''; }
      svg.addEventListener('mouseleave',hide);
      svg.addEventListener('mousemove',function(ev){
        var r=svg.getBoundingClientRect(); if(!r.width) return; var wr=wrap.getBoundingClientRect();
        var sx=r.width/VW, sy=r.height/VH, vx=(ev.clientX-r.left)/sx;
        var near=pd[0], bd=1e9; pd.forEach(function(p){ var d=Math.abs(p.x-vx); if(d<bd){bd=d;near=p;} });
        var offX=r.left-wr.left, offY=r.top-wr.top, cx=offX+near.x*sx, cy=offY+near.y*sy;
        mark.style.left=(cx-7)+'px'; mark.style.top=(cy-7)+'px'; mark.style.opacity='1';
        var key=near.x;
        if(tip._key!==key){
          tip._key=key; var head=near.t||near.bt, body=near.t?near.bt:'';
          tip.innerHTML='<div style="font-size:12px;font-weight:700;color:#1a1a1a;line-height:1.3;white-space:normal;overflow-wrap:anywhere;word-break:break-word">'+esc2(head)+'</div>'
            +(body?('<div style="font-size:10px;font-weight:400;color:#666;line-height:1.4;margin-top:3px;white-space:normal;overflow-wrap:anywhere">'+esc2(body)+'</div>'):'')
            +'<div style="font-size:9px;font-weight:400;color:#9a9a9a;margin-top:5px;letter-spacing:.02em">'+esc2(near.d)+(near.s?(' · '+esc2(near.s)):'')+'</div>';
        }
        var px=r.left+near.x*sx, py=r.top+near.y*sy; // the point in viewport (fixed) coords
        var tw=tip.offsetWidth||200, th=tip.offsetHeight||60;
        var lx=px-tw/2, ly=py-th-14; if(ly<4) ly=py+16;
        lx=Math.max(4, Math.min(lx, window.innerWidth-tw-4));
        if(ly+th>window.innerHeight-4) ly=Math.max(4, window.innerHeight-th-4);
        tip.style.left=lx+'px'; tip.style.top=ly+'px'; tip.style.opacity='1';
      });
      // Click a point → open that Brief in the modal (title, full text, tags, and its exact Cells — each chip opens the Cell).
      svg.addEventListener('click',function(ev){
        var r=svg.getBoundingClientRect(); if(!r.width) return; var vx=(ev.clientX-r.left)/(r.width/VW);
        var near=pd[0], bd=1e9; pd.forEach(function(p){ var d=Math.abs(p.x-vx); if(d<bd){bd=d;near=p;} });
        var b=((DATA.meta&&DATA.meta.briefs)||[]).filter(function(x){ return String(x.id)===String(near.id); })[0]; if(!b) return;
        var mo=document.getElementById('modal'); if(!mo) return;
        mo.querySelector('.modal-body').innerHTML=briefCard(b);
        mo.classList.add('open'); document.body.style.overflow='hidden'; hide();
        Array.prototype.forEach.call(mo.querySelectorAll('.mcell.known'),function(ch){ ch.addEventListener('click',function(){ openDetail(ch.getAttribute('data-uid')); }); });
        Array.prototype.forEach.call(mo.querySelectorAll('.btag'),function(ch){ ch.addEventListener('click',function(){ briefChartTag=ch.getAttribute('data-tag'); var cl=mo.querySelector('.modal-close'); if(cl) cl.click(); renderBriefs(); }); });
      });
    }
    // View toggle: List (flat / grouped) vs Clouds (a card per tag) vs Chart (growth over time)
    function vbtn(v,label){ var on=briefView===v; return '<button class="bf-view" data-v="'+v+'" style="border:none;padding:6px 15px;font-weight:600;cursor:pointer;font-family:inherit;font-size:.8rem;'+(on?'background:var(--accent);color:#fff':'background:transparent;color:var(--ink)')+'">'+label+'</button>'; }
    var seg='<div style="display:inline-flex;border:1px solid var(--rule);border-radius:9px;overflow:hidden;margin-right:4px">'+vbtn('list','List')+vbtn('clouds','Clouds')+vbtn('chart','Chart')+'</div>';
    var toolbar='<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 14px">'+seg
      +(briefView==='list'?('<button id="bf-group" class="tab'+(briefGroupBy?' active':'')+'" style="border:1px solid '+(briefGroupBy?'var(--accent)':'var(--rule)')+'">'+(briefGroupBy?'✓ ':'')+'Group by tag</button>'
        +(briefTagFilter?('<span style="display:inline-flex;align-items:center;gap:6px;font-size:.78rem;font-weight:700;color:var(--accent);border:1px solid var(--accent);border-radius:100px;padding:3px 11px">#'+esc2(briefTagFilter)+' <span id="bf-clear" style="cursor:pointer;opacity:.7" title="Clear filter">✕</span></span>'):'')):'')
      +'</div>';
    var bcfg=(DATA.meta&&DATA.meta.batch)||{enabled:true,barrier:5};
    // A real PROJECT SETTING (changes the AI's behaviour) — styled distinctly from the
    // List/Clouds/Group view controls above so it can't be mistaken for a display toggle.
    var batchbar=isLive()?('<div style="border:1px solid var(--rule);border-left:3px solid var(--accent);border-radius:10px;padding:11px 14px;margin:0 0 18px;background:var(--card2)">'
      +'<div style="display:flex;flex-wrap:wrap;gap:9px;align-items:center">'
        +'<span style="font-family:var(--mono);font-size:.6rem;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--accent)">⚙ Project setting</span>'
        +'<b style="color:var(--ink);font-size:.9rem">Batch</b>'
        +'<label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-size:.85rem;color:var(--ink-2)"><input type="checkbox" id="bf-batch-en"'+(bcfg.enabled?' checked':'')+'>on</label>'
        +'<span style="color:var(--mut)">·</span>'
        +'<span style="font-size:.85rem;color:var(--ink-2)">sign after <input id="bf-batch-n" type="number" min="1" max="100" value="'+bcfg.barrier+'" style="width:52px;padding:4px 6px;border-radius:7px;border:1px solid var(--rule);background:var(--paper);color:var(--ink)"> small changes</span>'
        +'<span id="bf-batch-msg" style="color:var(--mut);font-size:.8rem;margin-left:auto"></span>'
      +'</div>'
      +'<div style="font-size:.77rem;color:var(--mut);margin-top:7px">Controls how the <b style="color:var(--ink-2)">AI groups changes into Briefs</b> before you sign — and is shared with your team. It does <b style="color:var(--ink-2)">not</b> affect how Briefs are displayed here.</div>'
      +'</div>'):'';
    var hint=briefView==='clouds'?'Each tag is a cloud; inside, its Briefs newest-first. A Brief with several tags appears in every matching cloud — tap one to see its parts.':briefView==='chart'?'How your signed Specs + Briefs grow over time (each Brief adds its own text plus its Cells’ specs). Filter by tag and/or signer.':'Click a tag to filter; “Group by tag” orders by tag first, date second.';
    // Order: description → project setting (batch) → view controls + their hint → the Briefs.
    // The List/Clouds/Group controls sit right above the Briefs they display.
    var html='<h1>Briefs</h1><div class="snote" style="margin:0 0 14px">What was ordered, in plain language.</div>'+batchbar+toolbar+'<div class="snote" style="margin:2px 0 14px;font-size:.82rem">'+hint+'</div>';

    if(briefView==='chart'){
      html+=chartControls();
      var cf=ms.filter(function(b){
        if(briefChartTag && !(b.tags||[]).some(function(t){return lc(t)===lc(briefChartTag);})) return false;
        if(briefChartSigner && lc(b.signer||'')!==lc(briefChartSigner)) return false;
        return true;
      }).slice().sort(function(a,z){ return String(a.at||'').localeCompare(String(z.at||'')); });
      html+=chartSVG(cf);
    } else if(briefView==='clouds'){
      var tagMap={};
      ms.forEach(function(b){ ((b.tags&&b.tags.length)?b.tags:['(untagged)']).forEach(function(t){ var k=lc(t); if(!tagMap[k])tagMap[k]={label:(String(t)==='(untagged)'?'Untagged':t),briefs:[]}; tagMap[k].briefs.push(b); }); });
      var keys=Object.keys(tagMap).sort(function(a,z){ if(a==='(untagged)')return 1; if(z==='(untagged)')return -1; return String((tagMap[z].briefs[0]||{}).at||'').localeCompare(String((tagMap[a].briefs[0]||{}).at||'')); });
      html+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,290px),1fr));gap:14px;align-items:start">';
      keys.forEach(function(k){ var c=tagMap[k]; var untag=(k==='(untagged)');
        var rows=c.briefs.map(function(b){ var when=String(b.at||'').slice(0,10); var vc=(b.valid!==false)?'var(--accent)':'#cf4436';
          return '<div class="cbrief" style="padding:7px 9px;border-radius:9px;cursor:pointer;border-left:2px solid '+vc+';margin:0 0 5px;background:var(--paper)">'
            +'<div style="display:flex;gap:8px;justify-content:space-between;align-items:baseline"><span style="font-size:.9rem;font-weight:'+(b.title?'700':'400')+';color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc2(b.title||b.text||'')+'</span><span style="font-size:.68rem;color:var(--mut);font-variant-numeric:tabular-nums;white-space:nowrap">'+esc2(when)+'</span></div>'
            +'<div class="cbdetail" style="display:none;margin-top:7px;padding-top:7px;border-top:1px solid var(--rule)">'
              +'<div style="font-size:.88rem;color:var(--ink);margin-bottom:6px">'+esc2(b.text||'')+'</div>'
              +'<div style="font-size:.72rem;color:var(--mut);margin-bottom:5px">'+esc2(b.id||'')+' · '+((b.valid!==false)?'✓ signed':'⚠ seal invalid')+(b.signer?(' · '+esc2(b.signer)):'')+'</div>'
              +((b.cells&&b.cells.length)?('<div style="font-size:.72rem;color:var(--mut);margin-bottom:3px">covers '+b.cells.length+' part'+(b.cells.length===1?'':'s')+':</div><div>'+cellChips(b.cells)+'</div>'):'<div style="font-size:.72rem;color:var(--mut)">no parts</div>')
              +((b.tags&&b.tags.length>1)?('<div style="font-size:.7rem;color:var(--mut);margin-top:5px">also in: '+b.tags.filter(function(t){return lc(t)!==k;}).map(esc2).join(', ')+'</div>'):'')
            +'</div></div>';
        }).join('');
        html+='<div style="border:1px solid var(--rule);border-radius:16px;background:var(--card2);box-shadow:var(--shadow);overflow:hidden">'
          +'<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid var(--rule)"><span style="font-weight:800;font-size:.9rem;color:'+(untag?'var(--mut)':'var(--accent)')+'">'+(untag?'Untagged':'#'+esc2(c.label))+'</span><span style="font-size:.72rem;font-weight:700;color:var(--mut);background:var(--paper);border:1px solid var(--rule);border-radius:100px;padding:1px 9px">'+c.briefs.length+'</span></div>'
          +'<div style="padding:10px 12px;max-height:340px;overflow:auto">'+rows+'</div></div>';
      });
      html+='</div>';
    } else {
      var list=briefTagFilter?ms.filter(function(b){return (b.tags||[]).some(function(t){return lc(t)===lc(briefTagFilter);});}):ms;
      if(!list.length){ html+='<div class="snote">No Briefs with that tag.</div>'; }
      else if(briefGroupBy){
        var byTag={}; list.forEach(function(b){ ((b.tags&&b.tags.length)?b.tags:['(untagged)']).forEach(function(t){ (byTag[t]=byTag[t]||[]).push(b); }); });
        var names=Object.keys(byTag).sort(function(a,z){return a==='(untagged)'?1:z==='(untagged)'?-1:a.localeCompare(z);});
        names.forEach(function(t){ html+='<div style="font-weight:800;font-size:.82rem;color:var(--accent);margin:14px 0 8px">'+(t==='(untagged)'?'Untagged':'#'+esc2(t))+' <span style="color:var(--mut);font-weight:600">· '+byTag[t].length+'</span></div>'; byTag[t].forEach(function(b){ html+=briefCard(b); }); });
      } else { list.forEach(function(b){ html+=briefCard(b); }); }
    }
    el.innerHTML=html;
    Array.prototype.forEach.call(el.querySelectorAll('.bf-view'),function(bt){ bt.onclick=function(){ briefView=bt.getAttribute('data-v'); renderBriefs(); }; });
    var cct=document.getElementById('bf-ct'); if(cct) cct.onchange=function(){ briefChartTag=cct.value||null; renderBriefs(); };
    var ccs=document.getElementById('bf-cs'); if(ccs) ccs.onchange=function(){ briefChartSigner=ccs.value||null; renderBriefs(); };
    var crs=document.getElementById('bf-creset'); if(crs) crs.onclick=function(){ briefChartTag=null; briefChartSigner=null; renderBriefs(); };
    if(briefView==='chart') setupChartLens();
    var ben=document.getElementById('bf-batch-en'), bn=document.getElementById('bf-batch-n'), bmsg=document.getElementById('bf-batch-msg');
    function saveBatch(){ fetch('/api/batch',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:ben.checked,barrier:parseInt(bn.value,10)||5})}).then(function(r){return r.json();}).then(function(j){ if(bmsg){ bmsg.textContent=(j&&j.ok)?'✓ saved':'✗ '+((j&&j.error)||'failed'); bmsg.style.color=(j&&j.ok)?'#1f9d57':'#cf4436'; } }); }
    if(ben) ben.onchange=saveBatch; if(bn) bn.onchange=saveBatch;
    var g=document.getElementById('bf-group'); if(g) g.onclick=function(){ briefGroupBy=!briefGroupBy; renderBriefs(); };
    var clr=document.getElementById('bf-clear'); if(clr) clr.onclick=function(){ briefTagFilter=null; renderBriefs(); };
    Array.prototype.forEach.call(el.querySelectorAll('.btag'),function(ch){ ch.onclick=function(){ briefTagFilter=ch.getAttribute('data-tag'); renderBriefs(); }; });
    Array.prototype.forEach.call(el.querySelectorAll('.cbrief'),function(row){ row.onclick=function(e){ if(e.target.classList&&e.target.classList.contains('mcell')) return; var d=row.querySelector('.cbdetail'); if(d) d.style.display=(d.style.display==='none'?'block':'none'); }; });
    Array.prototype.forEach.call(el.querySelectorAll('.mcell.known'),function(ch){ ch.addEventListener('click',function(){ openDetail(ch.getAttribute('data-uid')); }); });
  }

  // ── Tags tab — the project vocabulary + what was built, sorted by tag over time. Under
  // the live dashboard it's editable (relabel/describe/add/remove); a tag already in a
  // signed Brief can't be renamed (that would split the history) but can be removed.
  function renderTags(){
    var el=document.getElementById('tags'); if(!el) return;
    var LIVE=isLive();
    var pool=(DATA.meta&&DATA.meta.tags)||[];
    var setName=(DATA.meta&&DATA.meta.tagSet)||'';
    var descs=(DATA.meta&&DATA.meta.tagDescriptions)||{};
    var briefs=(DATA.meta&&DATA.meta.briefs)||[];
    var lc=function(s){return String(s).toLowerCase();};
    var counts={}; briefs.forEach(function(b){ (b.tags||[]).forEach(function(t){ counts[lc(t)]=(counts[lc(t)]||0)+1; }); });
    function descOf(t){ for(var k in descs){ if(lc(k)===lc(t)) return descs[k]; } return ''; }
    function post(u,b){return fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(function(r){return r.json();});}
    if(!pool.length){
      // No pool yet → offer the starter sets to pick from (these become what signers pick from).
      var sets=(DATA.meta&&DATA.meta.tagSets)||[];
      var ph='<h1>Tags</h1><div class="snote" style="margin:0 0 14px">No tag pool yet. Pick a starter set — every Brief is then tagged from it, and it becomes the list a signer can choose from (including when correcting the AI’s tags on the phone). You can switch, relabel, add or remove later.</div>';
      ph+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,240px),1fr));gap:10px;margin:0 0 6px">';
      sets.forEach(function(s){ ph+='<div class="setpick" data-set="'+esc2(s.id)+'" style="border:1px solid var(--rule);border-radius:12px;padding:12px 14px;background:var(--card2)'+(LIVE?';cursor:pointer':'')+'"><div style="font-weight:800;color:var(--accent)">'+esc2(s.name)+'</div><div style="font-size:.78rem;color:var(--mut);margin-top:3px">'+esc2(s.desc)+'</div></div>'; });
      ph+='<div class="setpick" data-set="custom" style="border:1px dashed var(--rule);border-radius:12px;padding:12px 14px;background:var(--card2)'+(LIVE?';cursor:pointer':'')+'"><div style="font-weight:800;color:var(--mut)">Custom</div><div style="font-size:.78rem;color:var(--mut);margin-top:3px">blank placeholders (Custom 1–4) you relabel yourself</div></div>';
      ph+='</div>';
      ph+='<div class="snote" style="margin:12px 0 0">'+(LIVE?'Tap a set to use it.':'Set one with <b>yay tags --set &lt;id&gt;</b> (e.g. <b>responsibility</b>, or <b>custom</b>).')+'</div>';
      if(LIVE){ ph+='<div style="margin:16px 0 0"><div style="font-weight:800;font-size:.8rem;color:var(--mut);margin-bottom:6px">…or start your own</div>'
        +'<div style="display:flex;gap:8px;align-items:center"><input id="tag-new" placeholder="type a tag label" style="flex:1;min-width:140px;padding:8px;border-radius:8px;border:1px solid var(--rule);background:var(--paper);color:var(--ink)"><button id="tag-add" style="padding:8px 14px;border-radius:8px;border:none;background:var(--brand);color:#04231a;font-weight:700;cursor:pointer">Add tag</button></div><div id="tag-msg" style="margin-top:8px;font-size:.82rem;color:var(--mut)"></div></div>'; }
      el.innerHTML=ph;
      if(LIVE){
        Array.prototype.forEach.call(el.querySelectorAll('.setpick'),function(c){ c.onclick=function(){ post('/api/tags/edit',{action:'set',set:c.getAttribute('data-set')}).then(function(j){ if(j&&j.ok) location.reload(); }); }; });
        var an=document.getElementById('tag-add'), ai=document.getElementById('tag-new'), am=document.getElementById('tag-msg');
        function addOwn(){ var v=(ai.value||'').trim(); if(!v){ if(am){am.textContent='✗ enter a tag label';am.style.color='#cf4436';} return; } post('/api/tags/edit',{action:'add',label:v}).then(function(j){ if(j&&j.ok) location.reload(); else if(am){am.textContent='✗ '+((j&&j.error)||'failed');am.style.color='#cf4436';} }); }
        if(an) an.onclick=addOwn; if(ai) ai.addEventListener('keydown',function(e){ if(e.key==='Enter') addOwn(); });
      }
      return;
    }
    var html='<h1>Tags</h1><div class="snote" style="margin:0 0 14px">The project vocabulary'+(setName?(' ('+esc2(setName)+' set)'):'')+' — every Brief is tagged from this pool.'+(LIVE?' Relabel, describe, add or remove below. A tag already used in a signed Brief can’t be renamed (it would split the history), but can be removed.':' You choose this pool — switch starter sets, rename, add or remove tags with <b>yay tags</b> or live in the dashboard’s Tags tab.')+'</div>';
    var anyUsed=Object.keys(counts).length>0;
    if(LIVE && !anyUsed){
      // No tagged Briefs yet → a wholesale switch to a different set is still safe.
      var sw=(DATA.meta&&DATA.meta.tagSets)||[];
      html+='<div style="border:1px solid var(--rule);border-radius:12px;padding:12px 14px;margin:0 0 16px;background:var(--card2)"><div style="font-weight:700;margin-bottom:8px">Switch to a different set <span style="font-weight:400;color:var(--mut);font-size:.8rem">— allowed until the first tagged Brief is signed</span></div><div style="display:flex;flex-wrap:wrap;gap:6px">'
        +sw.map(function(s){return '<button class="setpick" data-set="'+esc2(s.id)+'" title="'+esc2(s.desc)+'" style="border:1px solid var(--rule);background:var(--paper);color:var(--ink);border-radius:100px;padding:5px 12px;cursor:pointer;font-size:.8rem;font-weight:600'+(cur.set===s.id?';border-color:var(--accent);color:var(--accent)':'')+'">'+esc2(s.name)+'</button>';}).join('')
        +'<button class="setpick" data-set="custom" style="border:1px dashed var(--rule);background:var(--paper);color:var(--mut);border-radius:100px;padding:5px 12px;cursor:pointer;font-size:.8rem;font-weight:600">Custom</button></div></div>';
    }
    if(LIVE){
      html+='<div id="tag-editor" style="margin:0 0 22px">';
      pool.forEach(function(t){
        var n=counts[lc(t)]||0, d=descOf(t);
        html+='<div class="tag-row" data-tag="'+esc2(t)+'" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;border:1px solid var(--rule);border-radius:10px;padding:8px 10px;margin:0 0 8px">';
        if(n) html+='<span style="font-weight:700;color:var(--accent);min-width:120px">'+esc2(t)+'</span><span style="font-size:.72rem;color:var(--mut)" title="used in signed Briefs — locked from renaming">🔒 used ×'+n+'</span>';
        else html+='<input class="tag-label" value="'+esc2(t)+'" style="font-weight:700;min-width:120px;padding:6px 8px;border-radius:7px;border:1px solid var(--rule);background:var(--paper);color:var(--ink)">';
        html+='<input class="tag-desc" value="'+esc2(d)+'" placeholder="description (optional)" style="flex:1;min-width:150px;padding:6px 8px;border-radius:7px;border:1px solid var(--rule);background:var(--paper);color:var(--ink)">';
        html+='<button class="tag-rm" style="border:1px solid var(--rule);background:none;color:#cf4436;border-radius:7px;padding:5px 9px;cursor:pointer;font-size:.8rem">remove</button></div>';
      });
      html+='<div style="display:flex;gap:8px;align-items:center;margin-top:10px"><input id="tag-new" placeholder="new tag label" style="flex:1;min-width:140px;padding:8px;border-radius:8px;border:1px solid var(--rule);background:var(--paper);color:var(--ink)"><button id="tag-add" style="padding:8px 14px;border-radius:8px;border:none;background:var(--brand);color:#04231a;font-weight:700;cursor:pointer">Add tag</button></div>';
      html+='<div id="tag-msg" style="margin-top:8px;font-size:.82rem;color:var(--mut)"></div></div>';
    } else {
      html+='<div style="border:1px solid var(--rule);border-left:3px solid var(--accent);border-radius:10px;padding:10px 13px;margin:0 0 14px;background:var(--card2);font-size:.85rem;color:var(--mut);line-height:1.5">You’re <b style="color:var(--ink)">not</b> handed a fixed list — you <b style="color:var(--ink)">choose the pool</b>. Switch to another starter set, <b style="color:var(--ink)">rename</b> any tag, <b style="color:var(--ink)">add</b> your own, or <b style="color:var(--ink)">remove</b> one — from the CLI (<b style="color:var(--ink)">yay tags</b>) or live in a running dashboard’s Tags tab. This static preview shows the current pool read-only.</div>';
      html+='<div style="font-weight:800;font-size:.8rem;color:var(--mut);margin:0 0 8px">'+pool.length+' tag'+(pool.length===1?'':'s')+' in the pool</div>';
      html+='<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,230px),1fr));gap:9px;margin:0 0 6px">'+pool.map(function(t){var n=counts[lc(t)]||0,d=descOf(t);
        return '<div style="border:1px solid var(--rule);border-radius:11px;padding:10px 13px;background:var(--card2)"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><span style="font-weight:800;color:var(--accent);font-size:.92rem">'+esc2(t)+'</span><span style="font-size:.68rem;font-weight:700;color:var(--mut);background:var(--paper);border:1px solid var(--rule);border-radius:100px;padding:1px 8px" title="used in '+n+' Brief(s)">'+n+'</span></div>'+(d?('<div style="font-size:.78rem;color:var(--mut);margin-top:4px;line-height:1.35">'+esc2(d)+'</div>'):'')+'</div>';
      }).join('')+'</div>';
      var sw2=(DATA.meta&&DATA.meta.tagSets)||[];
      if(sw2.length){
        html+='<div style="margin:16px 0 0"><div style="font-weight:800;font-size:.8rem;color:var(--mut);margin-bottom:6px">Starter sets you can switch to</div><div style="display:flex;flex-wrap:wrap;gap:6px">'
          +sw2.map(function(s){var act=(s.id===setName||s.name===setName);return '<span title="'+esc2(s.desc)+'" style="border:1px solid var(--rule);background:var(--paper);color:var(--ink);border-radius:100px;padding:5px 12px;font-size:.8rem;font-weight:600'+(act?';border-color:var(--accent);color:var(--accent)':'')+'">'+esc2(s.name)+(act?' ✓':'')+'</span>';}).join('')
          +'<span style="border:1px dashed var(--rule);background:var(--paper);color:var(--mut);border-radius:100px;padding:5px 12px;font-size:.8rem;font-weight:600">Custom (relabel your own)</span></div>'
          +'<div class="snote" style="margin:8px 0 0">Switch with <b>yay tags --set &lt;id&gt;</b>, then rename / add / remove freely.</div></div>';
      }
    }
    // Retired = tags that appear in past Briefs but are no longer in the pool. Vocabulary
    // context only (names + counts) — browsing Briefs by tag lives in the Briefs tab.
    var poolLc={}; pool.forEach(function(t){poolLc[lc(t)]=1;});
    var retired={}; briefs.forEach(function(b){ (b.tags||[]).forEach(function(t){ if(!poolLc[lc(t)]) retired[lc(t)]=t; }); });
    var rkeys=Object.keys(retired);
    if(rkeys.length){
      html+='<div style="margin:18px 0 0"><div style="font-weight:800;font-size:.8rem;color:var(--mut);margin-bottom:6px" title="Used in past Briefs but no longer offered for new ones">Retired · in history, not in the pool</div>'
        +'<div>'+rkeys.map(function(k){return '<span style="display:inline-block;font-size:.76rem;font-weight:600;color:var(--mut);border:1px dashed var(--rule);border-radius:100px;padding:3px 10px;margin:0 6px 6px 0">'+esc2(retired[k])+' <span style="opacity:.6">'+(counts[k]||0)+'</span></span>';}).join('')+'</div></div>';
    }
    html+='<div class="snote" style="margin:18px 0 0">This tab manages the vocabulary. To <b>browse Briefs by tag</b>, open the <b>Briefs</b> tab — its <b>Clouds</b> view shows a card per tag, or use <b>Group by tag</b> in the list.</div>';
    el.innerHTML=html;
    if(LIVE){
      var msg=document.getElementById('tag-msg');
      function fail(m){ if(msg){msg.textContent='✗ '+m;msg.style.color='#cf4436';} }
      Array.prototype.forEach.call(el.querySelectorAll('.tag-row'),function(row){
        var orig=row.getAttribute('data-tag');
        var lab=row.querySelector('.tag-label'), de=row.querySelector('.tag-desc'), rm=row.querySelector('.tag-rm');
        if(lab) lab.addEventListener('change',function(){ var v=(lab.value||'').trim(); if(!v||v===orig){lab.value=orig;return;} post('/api/tags/edit',{action:'rename',from:orig,to:v}).then(function(j){ if(j&&j.ok) location.reload(); else { lab.value=orig; fail((j&&j.error)||'rename failed'); } }); });
        if(de) de.addEventListener('change',function(){ post('/api/tags/edit',{action:'desc',label:orig,text:(de.value||'').trim()}).then(function(j){ if(j&&j.ok){ if(msg){msg.textContent='✓ description saved';msg.style.color='#1f9d57';} } else fail((j&&j.error)||'save failed'); }); });
        if(rm) rm.addEventListener('click',function(){ var used=counts[lc(orig)]||0; if(used && !confirm('Remove “'+orig+'”? '+used+' signed Brief(s) keep it in their history (shown under Retired). It just won’t be offered for new Briefs.')) return; post('/api/tags/edit',{action:'remove',label:orig}).then(function(j){ if(j&&j.ok) location.reload(); else fail((j&&j.error)||'remove failed'); }); });
      });
      var addBtn=document.getElementById('tag-add'), addInp=document.getElementById('tag-new');
      if(addBtn) addBtn.onclick=function(){ var v=(addInp.value||'').trim(); if(!v){fail('enter a tag label');return;} post('/api/tags/edit',{action:'add',label:v}).then(function(j){ if(j&&j.ok) location.reload(); else fail((j&&j.error)||'add failed'); }); };
      if(addInp) addInp.addEventListener('keydown',function(e){ if(e.key==='Enter'&&addBtn) addBtn.onclick(); });
      Array.prototype.forEach.call(el.querySelectorAll('.setpick'),function(c){ c.onclick=function(){ post('/api/tags/edit',{action:'set',set:c.getAttribute('data-set')}).then(function(j){ if(j&&j.ok) location.reload(); else fail((j&&j.error)||'switch failed'); }); }; });
    }
  }

  // ── Policy tab — who must sign what. Viewer (enforced vs draft + violations) plus,
  // when live under the dashboard, an editor that owner-signs the draft via the phone.
  function renderPolicy(){
    var el=document.getElementById('policy'); if(!el) return;
    var LIVE=isLive(); // re-checked here (DOM ready by the time a tab is opened)
    var pol=(DATA.meta&&DATA.meta.policy)||{enforced:[],draft:[],violations:[],signers:[]};
    var enforced=pol.enforced||[], draft=pol.draft||[], viol=pol.violations||[], signers=pol.signers||[];
    function ruleLine(r){
      var m=r.match||{}, parts=[];
      if(m.path) parts.push('path <code>'+esc2(m.path)+'</code>');
      if(m.tag) parts.push('tag <code>'+esc2(m.tag)+'</code>');
      if(m.module) parts.push('module <code>'+esc2(m.module)+'</code>');
      var left=(parts.join(' &amp; ')||'(no matcher)');
      if(r.inert){
        var lv=String(r.inert).toLowerCase();
        var desc=lv==='block'?'<b style="color:#cf4436">inert: block</b> — inert code gate-blocks these Cells':lv==='note'?'<b>inert: note</b> — inert findings shown as info only':'<b style="color:#c9860f">inert: yellow</b> — inert code caps these Cells at Yellow (the default, scoped explicitly)';
        return left+' → '+desc;
      }
      if(r.ignore){ return left+' → <b>ignore: source</b> — source here may be excluded from the gate (kept out on purpose)'; }
      var who=r.signer?esc2(r.signer):((r.signers||[]).map(esc2).join(' or '));
      return left+' → must be signed by <b>'+who+'</b>';
    }
    var same=JSON.stringify(enforced)===JSON.stringify(draft);
    var html='<h1>Policy</h1><div class="snote" style="margin:0 0 14px">Who must sign what. Neutral by default — a rule requires a specific person to sign matching Cells, and the gate blocks any match they haven’t signed. Enforced rules are <b>owner-signed</b> into the roster (tamper-evident).</div>';
    if(!enforced.length){ html+='<div class="snote" style="margin:0 0 14px">Enforced: <b>none</b> — every enrolled signer is treated the same.</div>'; }
    else { html+='<div style="margin:0 0 16px"><div style="font-weight:800;font-size:.8rem;color:var(--accent);margin-bottom:6px">ENFORCED · owner-signed</div>'+enforced.map(function(r){return '<div style="border:1px solid var(--rule);border-left:3px solid var(--accent);border-radius:10px;padding:9px 12px;margin:0 0 8px;font-size:.92rem">'+ruleLine(r)+'</div>';}).join('')+'</div>'; }
    if(viol.length){ html+='<div style="margin:0 0 16px"><div style="font-weight:800;font-size:.8rem;color:#cf4436;margin-bottom:6px">VIOLATIONS · '+viol.length+'</div>'+viol.map(function(v){return '<div style="font-size:.88rem;color:#cf4436;padding:2px 0 2px 12px;border-left:2px solid #cf4436;margin:0 0 6px">'+esc2(v.id)+' — '+esc2(v.note)+'</div>';}).join('')+'</div>'; }
    // ── Built-in security: the INERTNESS feature — always visible so users discover it.
    // Templates are OFF by default (examples, not active rules) until added to the
    // draft and owner-signed. Uses the project's own security-ish spec tag if the
    // pool suggests one; the built-in synthetic tag "sensitive" always works.
    (function(){
      var pool=(DATA.meta&&DATA.meta.tags)||[];
      var secTag='sensitive';
      for(var i=0;i<pool.length;i++){ if(/secur|auth/i.test(pool[i])){ secTag=pool[i].toLowerCase(); break; } }
      var tpls=[
        { match:{path:'src/payments/**'}, inert:'yellow', why:'scope the default explicitly to a payments area' },
        { match:{tag:secTag},            inert:'block',  why:'crown jewels — inert code BLOCKS the gate here' },
        { match:{path:'legacy/**'},      inert:'note',   why:'relax for an adopted/legacy area so retrofit noise stays informational' },
      ];
      var hasInert=enforced.concat(draft).some(function(r){return r&&r.inert;});
      html+='<div style="border:1px solid var(--rule);border-left:3px solid var(--accent);border-radius:12px;padding:13px 15px;margin:4px 0 16px;background:var(--card2)">'
        +'<div style="font-weight:800;margin-bottom:4px">🛡 Built-in security: inert-code strictness</div>'
        +'<div style="font-size:.85rem;color:var(--mut);line-height:1.5;margin-bottom:10px">The prover flags <b>inert code</b> — a branch removable with every spec-derived test still passing (dead weight, ahead-of-spec scaffolding, or a <b>dormant payload</b> riding under a signature). Default verdict: <b style="color:#c9860f">Yellow</b>, with the route “prune it, spec it, or declare it” (<code>throws:</code> for guards, <code>perf:</code> for optimizations). Policy rules adjust it per path/tag/module — <b>owner-signed either way, so it can’t be quietly weakened</b>:</div>'
        +tpls.map(function(t){
          var m=t.match.path?('path <code>'+esc2(t.match.path)+'</code>'):('tag <code>'+esc2(t.match.tag)+'</code>');
          var lv=t.inert==='block'?'<b style="color:#cf4436">inert: block</b>':t.inert==='note'?'<b>inert: note</b>':'<b style="color:#c9860f">inert: yellow</b>';
          return '<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;border:1px dashed var(--rule);border-radius:10px;padding:8px 11px;margin:0 0 7px;font-size:.88rem;opacity:.92">'
            +'<span>'+m+' → '+lv+' <span style="color:var(--mut)">— '+esc2(t.why)+'</span></span>'
            +'<span style="display:flex;gap:8px;align-items:center;flex-shrink:0">'
            +'<span style="font-size:.68rem;font-weight:700;color:var(--mut);border:1px solid var(--rule);border-radius:100px;padding:1px 9px" title="An example — not an active rule until you add it to the draft and owner-sign it">off</span>'
            +(LIVE?('<button class="pol-tpl" data-rule="'+esc2(JSON.stringify({match:t.match,inert:t.inert}))+'" style="border:1px solid var(--accent);background:none;color:var(--accent);border-radius:8px;padding:3px 10px;cursor:pointer;font-size:.78rem;font-weight:700">Add to draft</button>'):'')
            +'</span></div>';
        }).join('')
        +'<div style="font-size:.78rem;color:var(--mut)">'+(hasInert?'This project has inert rules '+(LIVE?'below':'listed above/below')+'.':(LIVE?'Templates are examples — tap “Add to draft”, edit the matcher below if needed, then Apply (owner-signs on your phone).':'Enable via the live dashboard’s Policy tab, or add a rule with <b>yay policy</b> (e.g. <code>{ "match": { "tag": "'+esc2(secTag)+'" }, "inert": "block" }</code>) and <b>yay policy --set</b>.'))+'</div>'
        +'</div>';
    })();
    html+='<div style="margin:18px 0 6px;font-weight:800;font-size:.8rem;color:var(--mut)">DRAFT · .yaylayer/policy.json'+(same?' (matches enforced)':' (differs — not yet signed)')+'</div>';
    if(!draft.length){ html+='<div class="snote" style="margin:0 0 10px">No draft rules.</div>'; }
    else { html+=draft.map(function(r,i){return '<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;border:1px dashed var(--rule);border-radius:10px;padding:9px 12px;margin:0 0 8px;font-size:.92rem"><span>'+ruleLine(r)+'</span>'+(LIVE?('<button class="pol-rm" data-i="'+i+'" style="border:1px solid var(--rule);background:none;color:#cf4436;border-radius:8px;padding:3px 9px;cursor:pointer;font-size:.8rem">remove</button>'):'')+'</div>';}).join(''); }
    if(LIVE){
      var sigOpts=signers.map(function(s){return '<option value="s:'+esc2(s)+'">must be signed by '+esc2(s)+'</option>';}).join('');
      html+='<div style="border:1px solid var(--rule);border-radius:12px;padding:14px;margin:12px 0 0;background:var(--card2)">'
        +'<div style="font-weight:700;margin-bottom:10px">Add a rule</div>'
        +'<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">'
        +'<select id="pol-mtype" style="padding:8px;border-radius:8px;border:1px solid var(--rule);background:var(--paper);color:var(--ink)"><option value="path">path glob</option><option value="tag">spec tag</option><option value="module">module</option></select>'
        +'<input id="pol-mval" placeholder="e.g. **/auth/**" style="flex:1;min-width:150px;padding:8px;border-radius:8px;border:1px solid var(--rule);background:var(--paper);color:var(--ink)">'
        +'<span style="color:var(--mut)">→</span>'
        +'<select id="pol-req" style="padding:8px;border-radius:8px;border:1px solid var(--rule);background:var(--paper);color:var(--ink)">'
        +(sigOpts||'')
        +'<option value="i:yellow">inert code → Yellow (default, scoped)</option><option value="i:block">inert code → BLOCK the gate</option><option value="i:note">inert code → note only (relax)</option>'
        +'<option value="g:source">authorise ignoring source (.yaylayerignore)</option>'
        +'</select>'
        +'<button id="pol-add" style="padding:8px 14px;border-radius:8px;border:none;background:var(--brand);color:#04231a;font-weight:700;cursor:pointer">Add to draft</button>'
        +'</div>'
        +(!same?('<div style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button id="pol-apply" style="padding:9px 16px;border-radius:8px;border:none;background:var(--accent);color:#fff;font-weight:700;cursor:pointer">Apply — owner-sign on your phone</button><span style="color:var(--mut);font-size:.85rem">signs the draft into the roster</span></div>'):'')
        +'<div id="pol-msg" style="margin-top:10px;font-size:.85rem;color:var(--mut)"></div></div>';
    } else if(!same){
      html+='<div class="snote" style="margin:10px 0 0">The draft differs from what’s enforced. Apply it with <b>yay policy --set</b> (owner-signs on your phone), or edit it live in <b>yay dashboard</b>.</div>';
    }
    el.innerHTML=html;
    if(LIVE){
      var msg=document.getElementById('pol-msg');
      function post(u,b){return fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})}).then(function(r){return r.json();});}
      Array.prototype.forEach.call(el.querySelectorAll('.pol-rm'),function(btn){ btn.onclick=function(){ post('/api/policy/remove',{index:parseInt(btn.getAttribute('data-i'),10)}).then(function(){ location.reload(); }); }; });
      var add=document.getElementById('pol-add'); if(add) add.onclick=function(){
        var t=document.getElementById('pol-mtype').value, v=(document.getElementById('pol-mval').value||'').trim(), req=document.getElementById('pol-req').value;
        if(!v){ if(msg){msg.textContent='Enter a value to match.';msg.style.color='#cf4436';} return; }
        if(!req){ if(msg){msg.textContent='Pick a requirement — a signer, or an inert level.';msg.style.color='#cf4436';} return; }
        var match={}; match[t]=v;
        var body={match:match};
        if(req.slice(0,2)==='i:') body.inert=req.slice(2); else if(req.slice(0,2)==='g:') body.ignore=req.slice(2); else body.signer=req.slice(2);
        post('/api/policy/rule',body).then(function(j){ if(j&&j.ok){location.reload();} else if(msg){msg.textContent='✗ '+((j&&j.error)||'failed');msg.style.color='#cf4436';} });
      };
      Array.prototype.forEach.call(el.querySelectorAll('.pol-tpl'),function(btn){ btn.onclick=function(){
        var r; try{ r=JSON.parse(btn.getAttribute('data-rule')); }catch(_){ return; }
        post('/api/policy/rule',r).then(function(j){ if(j&&j.ok){location.reload();} else if(msg){msg.textContent='✗ '+((j&&j.error)||'failed');msg.style.color='#cf4436';} });
      };});
      var ap=document.getElementById('pol-apply'); if(ap) ap.onclick=function(){
        if(msg){msg.textContent='Sending to your phone to owner-sign…';msg.style.color='';}
        post('/api/policy/apply',{}).then(function(j){ if(j&&j.ok){ if(msg){msg.textContent='✓ Applied — reloading…';msg.style.color='#1f9d57';} setTimeout(function(){location.reload();},1200);} else if(msg){msg.textContent='✗ '+((j&&j.error)||'failed');msg.style.color='#cf4436';} });
      };
    }
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
    try{ sessionStorage.setItem('yay.tab', name); }catch(e){} // remember across reloads (e.g. after a tag/policy save)
    MAP_ELS.forEach(function(s){ showSel(s, name==='map'); });
    showSel('#plan', name==='plan'); showSel('#signers', name==='signers'); showSel('#files', name==='files'); showSel('#commands', name==='commands'); showSel('#briefs', name==='briefs'); showSel('#tags', name==='tags'); showSel('#policy', name==='policy');
    Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(b){ b.classList.toggle('active', b.getAttribute('data-tab')===name); });
    var nm=document.getElementById('navmenu'); if(nm) nm.classList.remove('open');
    var nb=document.getElementById('navburger'); if(nb){ nb.textContent='☰'; nb.setAttribute('aria-expanded','false'); }
    if(name==='plan') renderPlan();
    if(name==='signers') renderSigners();
    if(name==='briefs') renderBriefs();
    if(name==='tags') renderTags();
    if(name==='policy') renderPolicy();
    if(name==='files') renderFiles();
  }
  // Live = the dashboard's control bar is on the page. Checked LAZILY (not at parse time),
  // because the bar is injected AFTER this script, so it isn't in the DOM yet when we load.
  function isLive(){ return !!document.getElementById('yd-bar'); }
  (function(){
    if(DATA.meta && DATA.meta.plan) Array.prototype.forEach.call(document.querySelectorAll('[data-tab="plan"]'),function(t){ t.style.display=''; });
    function revealTags(){ if(isLive() || (DATA.meta && DATA.meta.tags && DATA.meta.tags.length)) Array.prototype.forEach.call(document.querySelectorAll('[data-tab="tags"]'),function(t){ t.style.display=''; }); }
    revealTags(); window.addEventListener('load', revealTags);
    var pol=(DATA.meta&&DATA.meta.policy)||{};
    function revealPolicy(){ if(isLive() || (pol.enforced&&pol.enforced.length) || (pol.draft&&pol.draft.length)) Array.prototype.forEach.call(document.querySelectorAll('[data-tab="policy"]'),function(t){ t.style.display=''; }); }
    revealPolicy(); window.addEventListener('load', revealPolicy); // re-check once yd-bar is in the DOM
    Array.prototype.forEach.call(document.querySelectorAll('.tab'),function(b){ b.addEventListener('click',function(){ setTab(b.getAttribute('data-tab')); }); });
    var nb=document.getElementById('navburger'), nm=document.getElementById('navmenu');
    if(nb && nm) nb.addEventListener('click',function(){ var open=nm.classList.toggle('open'); nb.textContent=open?'✕':'☰'; nb.setAttribute('aria-expanded',open?'true':'false'); });
    // Restore the tab the user was on before a reload (registered after the reveal listeners
    // so hidden tabs like Tags/Policy are visible by the time we restore).
    window.addEventListener('load',function(){ try{ var t=sessionStorage.getItem('yay.tab'); if(t && t!=='map'){ var b=document.querySelector('[data-tab="'+t+'"]'); if(b && b.style.display!=='none') setTab(t); } }catch(e){} });
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
