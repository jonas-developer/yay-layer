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

const { canonical, pubKeysOf, isJsLang, normLangName } = require('./util');
const { verify: sigVerify } = require('./crypto');
const { proveManifest } = require('./prove');
const { requiredSigners, inertLevel, ignoreAllowed, coverageRequired } = require('./policy');
const { deriveRoster } = require('./roster');
const G = require('./grants');

// Shallow side-effect signals used for the MVP purity / minimality checks — per
// LANGUAGE, so a `pure: yes` claim is policed in every language we can run, not just
// JS. (Signal-based, not a proof of purity: an evader can dodge a regex; the typical
// AI-written effect gets caught.)
const EFFECT_SIGNALS = [
  ['localStorage', /\blocalStorage\b/], ['sessionStorage', /\bsessionStorage\b/],
  ['console', /\bconsole\s*\./], ['network', /\bfetch\s*\(|\bXMLHttpRequest\b/],
  ['require', /\brequire\s*\(/], ['process', /\bprocess\s*\./],
  ['dom', /\bdocument\b|\bwindow\b/], ['filesystem', /\bfs\s*\./],
  ['nondeterminism', /\bMath\.random\b|\bDate\.now\b|\bnew Date\b/],
];
const EFFECT_SIGNALS_PY = [
  ['stdout', /\bprint\s*\(/], ['stdin', /\binput\s*\(/],
  ['filesystem', /\bopen\s*\(|\bshutil\s*\.|\bpathlib\b.*\.(write|unlink|mkdir)/],
  ['os', /\bos\s*\./], ['sys', /\bsys\s*\./], ['subprocess', /\bsubprocess\s*\./],
  ['network', /\bsocket\s*\.|\brequests\s*\.|\burllib\b|\bhttpx\s*\./],
  ['nondeterminism', /\brandom\s*\.|\btime\s*\.\s*time\s*\(|\bdatetime\s*\.\s*(datetime\s*\.\s*)?now\s*\(/],
  ['global-state', /^\s*global\s+[A-Za-z_]/],
  ['import', /\b__import__\s*\(/],
];
// Per-language nets for the five P1.5 languages, so a `pure: yes` claim is policed in each with
// its OWN effect idioms (before this, non-JS/Python fell through to no net — a missed Red).
// Conservative: match common effect calls, not every token (a false Red is worse than a gap).
const EFFECT_SIGNALS_RUBY = [
  ['stdout', /\b(puts|print|pp)\b|\$stdout\b|\bSTDOUT\b/],
  ['filesystem', /\bFile\s*\.|\bIO\s*\.|\bDir\s*\.|\bFileUtils\b/],
  ['network', /\bNet::HTTP\b|\bURI\s*\.\s*open\b|\bopen-uri\b|\bTCPSocket\b|\bSocket\b|\bHTTParty\b/],
  ['exec', /\bsystem\s*\(|\bexec\s*\(|\bIO\.popen\b|\bProcess\s*\.|`[^`]*`|%x[({[]/],
  ['env', /\bENV\b/],
  ['nondeterminism', /\brand\b|\bTime\s*\.\s*now\b|\bDateTime\b|\bSecureRandom\b/],
  ['global-state', /(^|[^@\w])\$[a-zA-Z_]\w*/],
];
const EFFECT_SIGNALS_PHP = [
  ['stdout', /\becho\b|\bprint\b|\bprintf\s*\(|\bvar_dump\s*\(/],
  ['filesystem', /\bfile_get_contents\s*\(|\bfile_put_contents\s*\(|\bfopen\s*\(|\bunlink\s*\(|\bmkdir\s*\(|\brename\s*\(/],
  ['network', /\bcurl_exec\s*\(|\bfsockopen\s*\(|\bstream_socket_client\s*\(/],
  ['exec', /\bexec\s*\(|\bshell_exec\s*\(|\bsystem\s*\(|\bpassthru\s*\(|\bproc_open\s*\(|`[^`]*`/],
  ['superglobal', /\$_(GET|POST|REQUEST|SESSION|COOKIE|SERVER|ENV|FILES)\b/],
  ['db', /\bnew\s+PDO\b|\bmysqli?_(query|connect)\b/],
  ['nondeterminism', /\brand\s*\(|\bmt_rand\s*\(|\brandom_int\s*\(|\btime\s*\(|\bmicrotime\s*\(|\bdate\s*\(|\buniqid\s*\(/],
];
const EFFECT_SIGNALS_SOLIDITY = [
  ['state', /\bstorage\b|\bselfdestruct\s*\(/],
  ['event', /\bemit\s+\w/],
  ['external-call', /\.\s*call\s*[({]|\.\s*delegatecall\s*\(|\.\s*transfer\s*\(|\.\s*send\s*\(/],
  ['context', /\bblock\s*\.|\bmsg\s*\.|\btx\s*\.|\bblockhash\s*\(|\bnow\b/],
];
const EFFECT_SIGNALS_RUST = [
  ['stdout', /\bprintln!|\bprint!|\beprintln!|\beprint!|\bio::stdout\b/],
  ['filesystem', /\bstd::fs\b|\bFile::(open|create)\b|\bfs::(read|write|remove|create)/],
  ['network', /\bTcpStream\b|\bTcpListener\b|\bstd::net\b|\breqwest\b/],
  ['process', /\bstd::process\b|\bCommand::new\b/],
  ['nondeterminism', /\brand::|\bInstant::now\b|\bSystemTime::now\b|\bthread_rng\b/],
  ['global-mut', /\bstatic\s+mut\b/],
  ['unsafe', /\bunsafe\b/],
];
const EFFECT_SIGNALS_CSHARP = [
  ['stdout', /\bConsole\s*\.\s*(Write|WriteLine|Read|ReadLine)\b/],
  ['filesystem', /\bFile\s*\.|\bDirectory\s*\.|\bStreamReader\b|\bStreamWriter\b|\bSystem\s*\.\s*IO\b/],
  ['network', /\bHttpClient\b|\bWebClient\b|\bSocket\b|\bSystem\s*\.\s*Net\b/],
  ['process', /\bProcess\s*\.\s*Start\b|\bSystem\s*\.\s*Diagnostics\s*\.\s*Process\b/],
  ['env', /\bEnvironment\s*\./],
  ['nondeterminism', /\bnew\s+Random\b|\bDateTime\s*\.\s*(Now|UtcNow|Today)\b|\bGuid\s*\.\s*NewGuid\b|\bStopwatch\b/],
];
const isPyLang = (l) => /^py(thon)?w?$/i.test(String(l || ''));
// A machine-readable descriptor of the per-language effect nets: { lang: [signal labels] }. Used by
// the verifier-capability fingerprint (src/capability.js) so adding/removing a signal or a whole net
// changes the fingerprint — forcing a capability-version bump instead of a silent expansion.
function effectNetDescriptor() {
  const labels = (arr) => arr.map((s) => s[0]).sort();
  return {
    js: labels(EFFECT_SIGNALS), python: labels(EFFECT_SIGNALS_PY), ruby: labels(EFFECT_SIGNALS_RUBY),
    php: labels(EFFECT_SIGNALS_PHP), solidity: labels(EFFECT_SIGNALS_SOLIDITY), rust: labels(EFFECT_SIGNALS_RUST),
    csharp: labels(EFFECT_SIGNALS_CSHARP),
  };
}

function effectSignalsFor(lang) {
  if (!lang || isJsLang(lang)) return EFFECT_SIGNALS;
  if (isPyLang(lang)) return EFFECT_SIGNALS_PY;
  switch (normLangName(lang)) {
    case 'ruby': return EFFECT_SIGNALS_RUBY;
    case 'php': return EFFECT_SIGNALS_PHP;
    case 'solidity': return EFFECT_SIGNALS_SOLIDITY;
    case 'rust': return EFFECT_SIGNALS_RUST;
    case 'csharp': return EFFECT_SIGNALS_CSHARP;
    default: return null; // languages with no net yet — don't guess (a false Red is worse)
  }
}

const SEV = { GREEN: 0, YELLOW: 1, UNSIGNED: 2, RED: 3 };
const worst = (a, b) => (SEV[a] >= SEV[b] ? a : b);

function trustOf(cell, lock, roster, grants, policy, rejections) {
  let match = null;
  let violation = null; // a delegated approval whose grant-key signature is real but broke its envelope
  let firstAt = null; // earliest approval that ever covered this Cell → "created in the system"
  for (const ap of lock.approvals || []) {
    if (!ap.items || !(cell.id in ap.items)) continue;
    if (ap.at && (!firstAt || Date.parse(ap.at) < Date.parse(firstAt))) firstAt = ap.at;
    if (ap.items[cell.id] !== cell.specHash) continue;
    const { signature, ...rest } = ap;
    if (ap.autoApproved && ap.grant) {
      // Autopilot: signed by the machine-held GRANT key, valid only if a good grant
      // covers it (owner-signed, unexpired, unrevoked-before-this, in-envelope, in-count).
      const g = (grants || {})[ap.grant];
      const chk = g && G.autoApprovalOk(g, ap, cell.id, cell, { policy });
      const sigOk = g && sigVerify(canonical(rest), signature, g.grantPub);
      if (g && chk.ok && sigOk) {
        match = { signed: true, signer: ap.signer || null, auto: true, grant: ap.grant, at: ap.at || null };
      } else if (sigOk && g && g.ownerOk) {
        // BACKSTOP (P3): the grant is a VALID, owner-authorized delegation and its key really signed
        // this — but the target is OUTSIDE the envelope (wrong path/cell/risk, or an owner-signed
        // non-delegable area). That's an attempt to widen scope, not a lapsed grant, so we don't drop
        // it silently: flag a GRANT VIOLATION that blocks the gate loudly, agent behaviour aside.
        // (A merely expired/revoked/count-exhausted grant is a lapse → falls through to UNSIGNED.)
        const cov = G.grantCoversCellR(g, cell.id, cell, { policy });
        if (!cov.ok) violation = { grant: ap.grant, reason: cov.reason };
      }
      continue; // a human ratification (a later normal approval) will supersede this
    }
    const pubs = pubKeysOf(roster[ap.signer]); // an identity may hold several keys
    if (!pubs.length) continue;
    if (pubs.some((pub) => sigVerify(canonical(rest), signature, pub))) {
      // Keep the most recent valid signature over the current spec as "signed at".
      match = { signed: true, signer: ap.signer, auto: false, grant: null, at: ap.at || null };
    }
  }
  // Rejection withdraws approval (P3). A human turning down delegated work is like removing a
  // signature: the Cell drops behind the gate until it's reworked and re-approved. A reject targets
  // an EXACT specHash, so reworking the code (which changes the specHash) naturally clears the old
  // reject; and a later HUMAN approval over that same spec — the human changing their mind — also
  // supersedes it. A delegated (grant-key) re-approval never clears a human rejection. Forging a
  // rejection can only BLOCK a Cell (fail-safe), never approve one, so a signature check isn't
  // required for soundness here.
  let rejected = null;
  for (const ev of (rejections && rejections.events) || []) {
    if (!ev || ev.type !== 'reject' || !ev.cells || !ev.cells.includes(cell.id)) continue;
    if (!ev.specHashes || ev.specHashes[cell.id] !== cell.specHash) continue; // only the exact reviewed spec
    if (!rejected || Date.parse(ev.at || 0) > Date.parse(rejected.at || 0)) rejected = ev;
  }
  if (rejected) {
    const humanAfter = match && match.auto === false && match.at && Date.parse(match.at) > Date.parse(rejected.at || 0);
    if (!humanAfter) {
      return { signed: false, rejected: true, rejectReason: rejected.reason || '', rejectBy: rejected.signer || rejected.by || null, firstAt, violation };
    }
  }
  if (match) return { ...match, firstAt };
  return { signed: false, firstAt, violation };
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
  // Effect / purity signals per LANGUAGE (JS tokens for JS/TS, Python tokens for
  // Python). Languages with no reliable net get none — a false red on a function
  // that merely shares a name would be worse than an honest gap.
  // (Missing lang ⇒ JS, so legacy/synthetic cells behave exactly as before.)
  const sigSet = effectSignalsFor(cell.langName || cell.lang);
  if (cell.unitBody && sigSet) {
    const base = cell.unitBodyStart || 0;
    const found = []; // { signal, line, text } — the exact offending source lines
    cell.unitBody.split('\n').forEach((ln, k) => {
      for (const [sig, re] of sigSet) {
        if (re.test(ln)) { found.push({ signal: sig, line: base + k + 1, text: ln.trim() }); break; }
      }
    });
    const signals = [...new Set(found.map((f) => f.signal))];
    const renders = /^yes\b/i.test(spec.renders || '');
    if (pure && found.length && renders) {
      // A component's inline handlers (onClick={() => fetch(…)}) run AFTER render, so a
      // signal here isn't proof the RENDER is impure — a line net can't tell handler from
      // body. Honest middle: Yellow, with the fix spelled out (never a silent pass, never
      // a false Red on a legitimately pure render that attaches effectful handlers).
      yellow = true; badLines = found.map((f) => f.text);
      for (const f of found) notes.push({ level: 'yellow', text: `effect signal in a \`renders:\` component (line ${f.line}): ${f.signal} → ${f.text} — if it's in a handler, declare it in \`effects:\` (handlers run outside the render) or drop \`pure: yes\`; if it runs during render, the render is not pure` });
    } else if (pure && found.length) {
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

  // NOTE the non-JS honesty cap ("signed-only, capped at Yellow") no longer lives here:
  // some non-JS Cells ARE machine-provable now (pure Python via the subprocess prover),
  // so the cap is applied in verifyManifest AFTER the prover pass — only Cells the
  // prover did NOT prove get capped. Same honesty, without punishing a real proof.

  // vague / prose-only spec caps at YELLOW: a leaf Cell needs at least one machine field.
  const machineFields = ['in', 'out', 'ensures', 'pure', 'throws'].some((k) => spec[k]);
  if (!isModule && !machineFields) { yellow = true; notes.push({ level: 'yellow', text: 'prose-only spec (no in/out/ensures/pure/throws) — capped at Yellow' }); }
  if (!spec.intent) { yellow = true; notes.push({ level: 'yellow', text: 'no `intent:` line' }); }

  // unit-name mismatch: the spec's `unit:` names a different function than the code
  // actually defines below it (a rename, or the block attached to the wrong function).
  const short = (n) => String(n || '').split('.').pop();
  if (!isModule && spec.unit && cell.detectedUnit && short(spec.unit) !== short(cell.detectedUnit)) {
    yellow = true;
    notes.push({ level: 'yellow', text: `unit name mismatch: spec says \`unit: ${spec.unit}\` but the code defines \`${cell.detectedUnit}\` — update the spec, or the block may be on the wrong function` });
  }

  // dangling references: this Cell calls a bare name defined nowhere in the project
  // (renamed/removed function, typo, or an import the analyzer couldn't see).
  if (cell.unresolved && cell.unresolved.length) {
    yellow = true;
    const names = cell.unresolved.map((n) => '`' + n + '`').join(', ');
    notes.push({ level: 'yellow', text: `calls undefined name${cell.unresolved.length > 1 ? 's' : ''} ${names} — not defined anywhere in the project (renamed/removed/typo, or an unlisted import)` });
  }

  return { red, yellow, notes, badLines };
}

function verifyManifest(manifest, lock, config, opts) {
  opts = opts || {};
  // Trusted signers come from the SIGNED roster log when present (authoritative),
  // not from the plain config file — so an unsigned edit to who-can-sign has no
  // effect. Legacy projects with no signed log fall back to config.signers.
  let roster, rosterProblems = [], rootFp = null, rosterOk = true, signedRoster = false;
  let ownerPubs = [];
  let rosterPolicy = { rules: [] }; // the ENFORCED policy comes from the owner-signed roster (tamper-evident)
  if (opts.roster && opts.roster.events) {
    const d = deriveRoster(opts.roster, { root: opts.root });
    roster = d.roster; rosterProblems = d.problems; rootFp = d.rootFp; rosterOk = d.ok; signedRoster = true;
    rosterPolicy = d.policy || { rules: [] };
    ownerPubs = Object.keys(d.roles || {}).filter((n) => d.roles[n] === 'owner').reduce((a, n) => a.concat(roster[n] || []), []);
  } else {
    roster = (config && config.signers) || {};
    ownerPubs = ((config && config.owners) || []).reduce((a, n) => a.concat(pubKeysOf(roster[n])), []);
  }
  // Autopilot: validated delegation grants (empty when the project doesn't use them).
  const grants = opts.grants ? G.deriveGrants(opts.grants, ownerPubs, lock.approvals) : {};
  const results = {};

  for (const id of Object.keys(manifest.cells)) {
    const cell = manifest.cells[id];
    const trust = trustOf(cell, lock, roster, grants, rosterPolicy, opts.rejections);
    const sc = staticChecks(cell);

    let state;
    if (trust.violation) state = 'RED';       // grant-envelope violation → gate-blocking backstop
    else if (!trust.signed) state = 'UNSIGNED';
    else if (sc.red) state = 'RED';
    else if (sc.yellow) state = 'YELLOW';
    else state = 'GREEN';

    const isModule = !!(cell.contains && cell.contains.length);
    // Influence overlay (computed from the call graph, not asserted). It does not
    // change color — it's an oversight signal — except the honest bloat *note*.
    if (!isModule && cell.bloat) {
      sc.notes.push({ level: 'info', text: 'no static callers found — possible dead code / bloat candidate (or an entry point called dynamically)' });
    }
    if (trust.auto) {
      sc.notes.push({ level: 'info', text: `DELEGATED under grant ${trust.grant} (Autopilot) — awaiting ratification, not human-reviewed. Run \`yay ratify\` to sign it for real.` });
    }
    if (trust.violation) {
      sc.notes.push({ level: 'red', text: `GRANT VIOLATION — a delegated (Autopilot) approval under grant ${trust.violation.grant} covered this Cell, but it is outside that grant's envelope: ${trust.violation.reason}. The agent cannot widen its own grant; this needs a real human signature. (verifier backstop)` });
    }
    if (trust.rejected) {
      sc.notes.push({ level: 'red', text: `🚫 rejected by ${trust.rejectBy || 'a human'}${trust.rejectReason ? ` — ${String(trust.rejectReason).replace(/[.\s]+$/, '')}` : ''}. The delegated approval was withdrawn (like removing a signature); rework and re-approve to clear it. (yay ratify --reject)` });
    }

    results[id] = {
      id, state, trust, notes: sc.notes, badLines: sc.badLines || [], file: cell.file, line: cell.line,
      blast: cell.blast || 0, dependents: cell.directCallers || 0, isEntry: !!cell.isEntry, bloat: !!cell.bloat,
      // legibility: is the promise actually machine-proven, or just signed?
      hasEnsures: !!(cell.spec && cell.spec.ensures), proven: false,
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
      results[id].proven = true;
      const mu = pr.mutation;
      let text = `ensures proven over ${pr.cases} generated case(s)`;
      // Honesty: a proven non-JS Cell (Python subprocess prover) isn't yet graded by
      // mutation testing or the inertness check — say so, so its green reads correctly.
      const prLang = manifest.cells[id] && manifest.cells[id].lang;
      if ((!mu || !mu.total) && prLang && !isJsLang(prLang)) text += ` (mutation grading + inertness check not yet available for ${prLang})`;
      if (mu && mu.total) {
        text += `; mutation score ${Math.round(mu.score * 100)}% (${mu.killed}/${mu.total} killed)`;
        if (mu.score < 0.5) {
          results[id].state = worst(results[id].state, 'YELLOW');
          results[id].notes.push({ level: 'yellow', text: `weak ensures — ${mu.survived} mutant(s) survived (e.g. ${mu.survivor || 'a code change'}); the promise passes even when the code is broken` });
        }
      }
      results[id].notes.push({ level: 'info', text });
      // Branch-exercise honesty: show the coverage boundary of the proof instead of hiding it.
      // A badge only — it never downgrades the green here (a legit `throws:` guard is often
      // unexercised on purpose); policy (`coverage: full`) decides if that's gate-blocking.
      const cov = pr.coverage;
      if (cov && cov.total) {
        results[id].coverage = cov;
        if (cov.missed && cov.missed.length) {
          const where = cov.missed.slice(0, 3).map((m) => 'line ' + m.line).join(', ') + (cov.missed.length > 3 ? '…' : '');
          results[id].notes.push({ level: 'info', text: `proven — but ${cov.exercised}/${cov.total} branches exercised by spec-derived inputs; unexercised: ${where}. A dormant branch is an unexercised branch — check these are intended (guards/edge cases), spec them, or require full exercise via policy.` });
        } else {
          results[id].notes.push({ level: 'info', text: `proven — all ${cov.total} branches exercised by spec-derived inputs (full branch coverage)` });
        }
      }
    } else if (pr.status === 'skip') {
      // Couldn't check it (prose, exotic type, won't load) — say so, but don't
      // punish honest code for the prover's limits. Only a real contradiction is Red.
      results[id].notes.push({ level: 'info', text: 'ensures not machine-verified — ' + pr.reason });
    }
  }

  // Honesty cap for non-JS Cells, applied AFTER the prover so a genuinely proven Cell
  // (e.g. a pure Python function proved by the subprocess prover) keeps its Green.
  // Everything non-JS the prover did NOT prove stays capped at Yellow — no silent
  // false green for signed-but-unverified code in other languages.
  for (const id of Object.keys(manifest.cells)) {
    const cell = manifest.cells[id];
    if (!results[id]) continue;
    const isModule = !!(cell.contains && cell.contains.length);
    if (isModule || !cell.lang || isJsLang(cell.lang)) continue;
    if (results[id].proven) continue; // machine-proven out-of-VM → the proof stands
    results[id].state = worst(results[id].state, 'YELLOW');
    results[id].notes.push({ level: 'yellow', text: `signed, but not machine-verified — ${cell.lang} code⇔spec isn't checked yet (pure Python functions with an ensures ARE provable); capped at Yellow` });
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
  // ── Signing policy (optional; neutral when there are no rules) ──
  // A Cell matching a rule MUST be signed by a required signer with a real (non-AUTO)
  // seal, else it can't ship: downgrade it to RED so it blocks the gate and shows on the
  // map, with a note naming who must sign. No policy / no match → unconstrained, as before.
  const policy = opts.policy || rosterPolicy || { rules: [] };
  let policyBlocked = 0;
  for (const id of Object.keys(manifest.cells)) {
    const cell = manifest.cells[id];
    const r = results[id];
    if (!r || (cell.contains && cell.contains.length)) continue; // leaves only
    const req = requiredSigners(policy, cell);
    if (!req.length) continue;
    const okBy = r.trust && r.trust.signed && !r.trust.auto && req.includes(r.trust.signer);
    if (!okBy) {
      r.state = worst(r.state, 'RED');
      r.policyOk = false;
      r.notes.push({ level: 'red', text: `policy: requires ${req.join(' or ')} to sign — ${r.trust && r.trust.signed ? 'currently signed by ' + (r.trust.signer || '?') : 'not yet signed by them'}` });
      policyBlocked++;
    } else { r.policyOk = true; }
  }

  // ── Inertness verdicts (built-in security feature) ──
  // The prover flags branches removable with every spec-derived test still passing —
  // unpromised behaviour riding under a signature (dead weight, ahead-of-spec
  // scaffolding, or a dormant payload). Default: Yellow cap. Policy escalates
  // (inert: block → gate-blocking) or relaxes (inert: note) per path/tag/module.
  for (const id of Object.keys(proofs)) {
    const pr = proofs[id];
    const r = results[id];
    if (!r || !pr || !pr.inertness) continue;
    const inert = pr.inertness;
    if (inert.exempt) { r.notes.push({ level: 'info', text: `inertness: Cell exempt — ${inert.exempt} (signed declaration)` }); continue; }
    if (!inert.flagged || !inert.flagged.length) continue;
    const level = inertLevel(policy, manifest.cells[id]);
    const ex = inert.flagged[0];
    // Sharpen with branch-exercise data: an inert branch that was ALSO never exercised by any
    // spec-derived input is the highest-confidence dormancy signal — call it out explicitly.
    const missedLines = new Set(((r.coverage && r.coverage.missed) || []).map((m) => m.line));
    const alsoUnexercised = (inert.flagged || []).some((f) => missedLines.has(f.line));
    const msg = `inert code — ${inert.flagged.length} branch(es) removable with every spec-derived test still passing (e.g. line ${ex.line}: \`${ex.snippet}\`)${alsoUnexercised ? ' — and never exercised by any spec-derived input (strongest dormancy signal)' : ''}: unpromised behaviour riding under the signature. Prune it, spec it (add the ensures case or its own Cell), or declare it (\`throws:\` for guards, \`perf:\` for optimizations).`;
    if (level === 'note') {
      r.notes.push({ level: 'info', text: msg + ' (policy: inert → note)' });
    } else if (level === 'block') {
      r.state = worst(r.state, 'RED');
      r.notes.push({ level: 'red', text: msg + ' (policy: inert → block — this Cell is gate-blocked until resolved)' });
    } else {
      r.state = worst(r.state, 'YELLOW');
      r.notes.push({ level: 'yellow', text: msg });
    }
  }

  // ── Coverage strictness (owner-signed policy `coverage: full`) ──
  // Default is a badge, never a downgrade. But for crown-jewel scopes a policy rule can DEMAND that
  // every branch of a proven Cell was exercised — an unexercised branch (where a dormant payload
  // hides) then blocks the gate until it's exercised, spec'd, or pruned.
  for (const id of Object.keys(manifest.cells)) {
    const cell = manifest.cells[id];
    const r = results[id];
    if (!r || (cell.contains && cell.contains.length) || !r.coverage) continue;
    if (!coverageRequired(policy, cell)) continue;
    const missed = (r.coverage.missed || []);
    if (missed.length) {
      r.state = worst(r.state, 'RED');
      r.notes.push({ level: 'red', text: `policy: coverage full — ${missed.length} branch(es) never exercised by spec-derived inputs (${missed.slice(0, 3).map((m) => 'line ' + m.line).join(', ')}${missed.length > 3 ? '…' : ''}); this scope requires every branch exercised. Exercise them (strengthen the ensures/inputs), spec them, or prune them.` });
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
    const wrapHint = isJsLang(u.lang)
      ? 'wrap it in an IIFE around a spec\'d function — `(function(){ function init(){…} init(); })()` — or run `yay adopt`'
      : 'move it under an entry guard (e.g. `if __name__ == "__main__":`) or into a function an explicit caller runs';
    const text = u.kind === 'loose'
      ? `top-level code runs at load with no spec (${u.count || 1} statement${(u.count || 1) > 1 ? 's' : ''}): ${wrapHint}`
      : `no formal specification (${u.kind || 'unit'}) — never described or signed (run \`yay adopt\`)`;
    results[id] = {
      id, state: 'PINK', trust: { signed: false }, untracked: true,
      name: u.name, file: u.file, line: u.line, lang: u.lang, module: u.module, group: u.group,
      notes: [{ level: 'red', text }],
      badLines: [],
    };
  }

  // Source code hidden from the gate by .yaylayerignore → gate-blocking Pink, unless an
  // OWNER-SIGNED policy `ignore: source` rule authorises it. Closes the bypass where a
  // bare .yaylayerignore line removes a file from judgment entirely.
  for (const ig of manifest.ignoredSource || []) {
    if (ignoreAllowed(policy, ig.file)) continue; // whitelisted (vendored/generated), signed
    const id = `«ignored: ${ig.file}»`;
    results[id] = {
      id, state: 'PINK', trust: { signed: false }, untracked: true, ignoredSource: true,
      name: 'ignored source', file: ig.file, line: 1, lang: ig.lang, module: ig.file, group: 'hidden',
      notes: [{ level: 'red', text: `SOURCE file hidden from the gate by .yaylayerignore — code here is never scanned, signed, or verified. Un-ignore it, or authorise it with an owner-signed policy rule { "match": { "path": "${ig.file}" }, "ignore": "source" } (yay policy → --set).` }],
      badLines: [],
    };
  }

  const counts = { GREEN: 0, YELLOW: 0, RED: 0, UNSIGNED: 0, PINK: 0 };
  for (const r of Object.values(results)) counts[r.state]++;
  counts.policyBlocked = policyBlocked; // Cells blocked by the signing policy (already RED)
  // Legibility: of the GREEN Cells, how many are machine-PROVEN vs signed-but-unproven
  // (a promise stated but never machine-checked — the specs to strengthen next).
  let proven = 0, unproven = 0;
  for (const r of Object.values(results)) if (r.state === 'GREEN') { if (r.proven) proven++; else if (r.hasEnsures) unproven++; }
  counts.proven = proven; counts.unproven = unproven;
  // Autopilot: of the signed Cells, how many are AUTO (delegated, awaiting ratification).
  let auto = 0;
  for (const r of Object.values(results)) if (r.trust && r.trust.auto && r.state !== 'UNSIGNED') auto++;
  counts.auto = auto;
  // A tampered / unauthorized / root-mismatched roster blocks the gate: if we can't
  // trust WHO may sign, we can't trust any signature.
  const passed = counts.RED === 0 && counts.UNSIGNED === 0 && counts.PINK === 0 && rosterOk;
  // `policy` is the EFFECTIVE ruleset the verdicts were produced under — exposed so an attestation
  // (P2) can hash exactly what the verifier used (rulesetHash), not re-guess it.
  return { results, counts, passed, grants, rosterProblems, rootFp, rosterOk, signedRoster, policy };
}

module.exports = { verifyManifest, worst, effectNetDescriptor };
