'use strict';
// The gate. For every Cell it answers two orthogonal questions:
//   TRUST  — is this spec covered by a valid signature in the lock? (who signed)
//   VERIFY — does the code match the spec? (static checks)
// and combines them into GREEN / YELLOW / RED / UNSIGNED.
//
// MVP scope: VERIFY runs *static-lite* checks (unit exists, declared purity
// holds, effects are declared). Deep behavioural proof — property tests generated
// from `ensures`, real AST effect analysis, mutation scoring — is the per-language
// adapter milestone on the roadmap (see standard/STANDARD.md §Verification tiers).

const { canonical, pubKeysOf } = require('./util');
const { verify: sigVerify } = require('./crypto');
const { proveManifest } = require('./prove');

// Shallow side-effect signals used for the MVP purity / minimality checks.
const EFFECT_SIGNALS = [
  ['localStorage', /\blocalStorage\b/], ['sessionStorage', /\bsessionStorage\b/],
  ['console', /\bconsole\s*\./], ['network', /\bfetch\s*\(|\bXMLHttpRequest\b/],
  ['require', /\brequire\s*\(/], ['process', /\bprocess\s*\./],
  ['dom', /\bdocument\b|\bwindow\b/], ['filesystem', /\bfs\s*\./],
  ['nondeterminism', /\bMath\.random\b|\bDate\.now\b|\bnew Date\b/],
];

const SEV = { GREEN: 0, YELLOW: 1, UNSIGNED: 2, RED: 3 };
const worst = (a, b) => (SEV[a] >= SEV[b] ? a : b);

function trustOf(cell, lock, roster) {
  let match = null;
  let firstAt = null; // earliest approval that ever covered this Cell → "created in the system"
  for (const ap of lock.approvals || []) {
    if (!ap.items || !(cell.id in ap.items)) continue;
    if (ap.at && (!firstAt || Date.parse(ap.at) < Date.parse(firstAt))) firstAt = ap.at;
    if (ap.items[cell.id] !== cell.specHash) continue;
    const pubs = pubKeysOf(roster[ap.signer]); // an identity may hold several keys
    if (!pubs.length) continue;
    const { signature, ...rest } = ap;
    if (pubs.some((pub) => sigVerify(canonical(rest), signature, pub))) {
      // Keep the most recent valid signature over the current spec as "signed at".
      match = { signed: true, signer: ap.signer, auto: !!ap.autoApproved, grant: ap.grant || null, at: ap.at || null };
    }
  }
  return match ? { ...match, firstAt } : { signed: false, firstAt };
}

function staticChecks(cell) {
  const notes = [];
  let red = false, yellow = false;
  const spec = cell.spec || {};
  const isModule = !!(cell.contains && cell.contains.length);

  // A module (container Cell) governs composition, not a code unit — so it is not
  // expected to have a function body or the machine fields a leaf Cell needs.
  if (!isModule && cell.unitName && !cell.unitFound) {
    red = true; notes.push({ level: 'red', text: `code missing: no unit "${cell.unitName}" found below the spec` });
  }

  const declaredEffects = (spec.effects || '').toLowerCase();
  const pure = /^yes\b/i.test(spec.pure || '');
  let badLines = [];
  if (cell.unitBody) {
    const base = cell.unitBodyStart || 0;
    const found = []; // { signal, line, text } — the exact offending source lines
    cell.unitBody.split('\n').forEach((ln, k) => {
      for (const [sig, re] of EFFECT_SIGNALS) {
        if (re.test(ln)) { found.push({ signal: sig, line: base + k + 1, text: ln.trim() }); break; }
      }
    });
    const signals = [...new Set(found.map((f) => f.signal))];
    if (pure && found.length) {
      red = true;
      badLines = found.map((f) => f.text);
      for (const f of found) notes.push({ level: 'red', text: `purity violated (line ${f.line}): \`pure: yes\` but uses ${f.signal} → ${f.text}` });
    } else if (!pure && found.length) {
      const undeclared = found.filter((f) => !declaredEffects.includes(f.signal) && !declaredEffects.includes('any'));
      if (declaredEffects && undeclared.length) {
        yellow = true; badLines = undeclared.map((f) => f.text);
        for (const f of undeclared) notes.push({ level: 'yellow', text: `undeclared effect (line ${f.line}): ${f.signal} → ${f.text}` });
      } else if (!declaredEffects) {
        yellow = true; badLines = found.map((f) => f.text);
        notes.push({ level: 'yellow', text: `has effects (${signals.join(', ')}) but none declared in \`effects:\`` });
      }
    }
  }

  // vague / prose-only spec caps at YELLOW: a leaf Cell needs at least one machine field.
  const machineFields = ['in', 'out', 'ensures', 'pure', 'throws'].some((k) => spec[k]);
  if (!isModule && !machineFields) { yellow = true; notes.push({ level: 'yellow', text: 'prose-only spec (no in/out/ensures/pure/throws) — capped at Yellow' }); }
  if (!spec.intent) { yellow = true; notes.push({ level: 'yellow', text: 'no `intent:` line' }); }

  return { red, yellow, notes, badLines };
}

function verifyManifest(manifest, lock, config, opts) {
  const roster = (config && config.signers) || {};
  const results = {};

  for (const id of Object.keys(manifest.cells)) {
    const cell = manifest.cells[id];
    const trust = trustOf(cell, lock, roster);
    const sc = staticChecks(cell);

    let state;
    if (!trust.signed) state = 'UNSIGNED';
    else if (sc.red) state = 'RED';
    else if (sc.yellow) state = 'YELLOW';
    else state = 'GREEN';

    const isModule = !!(cell.contains && cell.contains.length);
    // Influence overlay (computed from the call graph, not asserted). It does not
    // change color — it's an oversight signal — except the honest bloat *note*.
    if (!isModule && cell.bloat) {
      sc.notes.push({ level: 'info', text: 'no static callers found — possible dead code / bloat candidate (or an entry point called dynamically)' });
    }

    results[id] = {
      id, state, trust, notes: sc.notes, badLines: sc.badLines || [], file: cell.file, line: cell.line,
      blast: cell.blast || 0, dependents: cell.directCallers || 0, isEntry: !!cell.isEntry, bloat: !!cell.bloat,
    };
  }

  // Behavioural proof: run each pure Cell against its `ensures` (spec-derived
  // tests). A counterexample ⇒ Red (code contradicts its promise); a claim we
  // can't check ⇒ Yellow (unproven), never a fake pass.
  const proofs = proveManifest(manifest, opts);
  for (const id of Object.keys(proofs)) {
    if (!results[id]) continue;
    const pr = proofs[id];
    if (pr.status === 'fail') {
      results[id].state = worst(results[id].state, 'RED');
      results[id].notes.push({ level: 'red', text: 'ensures FAILED — ' + pr.counterexample });
      const body = manifest.cells[id] && manifest.cells[id].unitBody;
      if (body) results[id].badLines = body.split('\n').map((l) => l.trim()).filter((l) => /\breturn\b/.test(l));
    } else if (pr.status === 'pass') {
      const mu = pr.mutation;
      let text = `ensures proven over ${pr.cases} generated case(s)`;
      if (mu && mu.total) {
        text += `; mutation score ${Math.round(mu.score * 100)}% (${mu.killed}/${mu.total} killed)`;
        if (mu.score < 0.5) {
          results[id].state = worst(results[id].state, 'YELLOW');
          results[id].notes.push({ level: 'yellow', text: `weak ensures — ${mu.survived} mutant(s) survived (e.g. ${mu.survivor || 'a code change'}); the promise passes even when the code is broken` });
        }
      }
      results[id].notes.push({ level: 'info', text });
    } else if (pr.status === 'skip') {
      // Couldn't check it (prose, exotic type, won't load) — say so, but don't
      // punish honest code for the prover's limits. Only a real contradiction is Red.
      results[id].notes.push({ level: 'info', text: 'ensures not machine-verified — ' + pr.reason });
    }
  }

  // Higher-order: broken feeds edges, and roll-up color for container Cells.
  for (const id of Object.keys(manifest.cells)) {
    const cell = manifest.cells[id];
    for (const t of cell.feeds || []) {
      if (!manifest.cells[t]) {
        results[id].notes.push({ level: 'yellow', text: `broken edge: feeds → ${t} (no such Cell)` });
        results[id].state = worst(results[id].state, 'YELLOW');
      }
    }
  }
  for (const id of Object.keys(manifest.cells)) {
    const cell = manifest.cells[id];
    if (cell.contains && cell.contains.length) {
      let rolled = results[id].state;
      for (const child of cell.contains) {
        if (results[child]) rolled = worst(rolled, results[child].state);
      }
      if (rolled !== results[id].state) results[id].notes.push({ level: 'info', text: `rolled up to ${rolled} from contained Cells` });
      results[id].state = rolled;
      results[id].isModule = true;
    }
  }

  // PINK: code with no spec block at all — untracked, never described or signed.
  // The most dangerous state, so it BLOCKS the gate: everything must be covered.
  for (const u of manifest.untracked || []) {
    let id = `«${u.name}»`;
    if (results[id]) id += ` @${u.file}:${u.line}`;
    const text = u.kind === 'loose'
      ? `top-level code runs at load with no spec (${u.count || 1} statement${(u.count || 1) > 1 ? 's' : ''}) — wrap it in a Cell`
      : `no formal specification (${u.kind || 'unit'}) — never described or signed (run \`yay adopt\`)`;
    results[id] = {
      id, state: 'PINK', trust: { signed: false }, untracked: true,
      name: u.name, file: u.file, line: u.line, lang: u.lang, module: u.module, group: u.group,
      notes: [{ level: 'red', text }],
      badLines: [],
    };
  }

  const counts = { GREEN: 0, YELLOW: 0, RED: 0, UNSIGNED: 0, PINK: 0 };
  for (const r of Object.values(results)) counts[r.state]++;
  const passed = counts.RED === 0 && counts.UNSIGNED === 0 && counts.PINK === 0;
  return { results, counts, passed };
}

module.exports = { verifyManifest, worst };
