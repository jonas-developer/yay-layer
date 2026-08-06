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

const { canonical } = require('./util');
const { verify: sigVerify } = require('./crypto');

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
  for (const ap of lock.approvals || []) {
    if (!ap.items || ap.items[cell.id] !== cell.specHash) continue;
    const pub = roster[ap.signer];
    if (!pub) continue;
    const { signature, ...rest } = ap;
    if (sigVerify(canonical(rest), signature, pub)) {
      return { signed: true, signer: ap.signer, auto: !!ap.autoApproved, grant: ap.grant || null };
    }
  }
  return { signed: false };
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

function verifyManifest(manifest, lock, config) {
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

    results[id] = { id, state, trust, notes: sc.notes, badLines: sc.badLines || [], file: cell.file, line: cell.line };
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

  const counts = { GREEN: 0, YELLOW: 0, RED: 0, UNSIGNED: 0 };
  for (const r of Object.values(results)) counts[r.state]++;
  const passed = counts.RED === 0 && counts.UNSIGNED === 0;
  return { results, counts, passed };
}

module.exports = { verifyManifest, worst };
