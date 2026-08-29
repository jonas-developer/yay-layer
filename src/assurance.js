'use strict';
// P4 — long-lived assurance helpers (pure logic; the CLI/dashboard wire them up):
//   • reverifyDiff       — compare a stored attestation's verdicts to a fresh run (verifier upgrades
//                          APPEND a new attestation, never rewrite — "Green is an event", D5).
//   • integrityWitness   — cross-check the append-only ledgers against each other and the tree
//                          (git vs ledger vs spec-archive): does the record still describe reality?
//   • earnedAutonomy     — turn the rejection history (P3) into per-category trust metrics: where the
//                          agent's delegated work is reliably ratified vs. repeatedly rejected.

// ── reverify diff ────────────────────────────────────────────────────────────────
// prevAtt.evidence and newVerObj.evidence are per-Cell { state, proven } maps. Returns the verdict
// changes between them (a Cell moving YELLOW→GREEN is an *improvement* from a better verifier; a
// GREEN→RED is a *regression* a capability bump surfaced). Never mutates either input.
function reverifyDiff(prevAtt, newVerObj) {
  const a = (prevAtt && prevAtt.evidence) || {};
  const b = (newVerObj && newVerObj.evidence) || {};
  const rank = { PINK: 0, RED: 1, UNSIGNED: 2, YELLOW: 3, GREEN: 4 };
  const ids = Object.keys({ ...a, ...b }).sort();
  const changes = [];
  let improved = 0, regressed = 0;
  for (const id of ids) {
    const from = a[id] ? a[id].state : '(absent)';
    const to = b[id] ? b[id].state : '(gone)';
    const fromProven = !!(a[id] && a[id].proven), toProven = !!(b[id] && b[id].proven);
    if (from === to && fromProven === toProven) continue;
    const dir = ((rank[to] != null ? rank[to] : -1) - (rank[from] != null ? rank[from] : -1));
    if (dir > 0 || (from === to && !fromProven && toProven)) improved++;
    else if (dir < 0) regressed++;
    changes.push({ cell: id, from, to, fromProven, toProven });
  }
  return {
    capabilityChanged: !!(prevAtt && newVerObj && prevAtt.capability !== newVerObj.capability),
    fromCapability: prevAtt ? prevAtt.capability : null,
    toCapability: newVerObj ? newVerObj.capability : null,
    changes, improved, regressed,
  };
}

// ── integrity witness (git/tree vs ledger vs spec-archive) ─────────────────────────
// A witness answers "does the record still describe reality, and is the record internally sound?"
// It takes already-loaded state (so it's pure/testable) and returns { ok, problems, checks }.
//   deps: {
//     ledger,            // attestation ledger { entries:[...] }
//     loadAttestation,   // (hash) => validated attestation | null   (tamper check baked in)
//     currentCodeTreeHash,
//     approvals,         // lock.approvals
//     hasSpecObject,     // (specHash) => bool  (is the as-signed spec archived? P1)
//   }
function integrityWitness(deps) {
  const problems = [];
  const led = (deps.ledger && deps.ledger.entries) || [];
  // 1) attestation chain: each entry references the previous hash, and each stored object validates.
  let chainOk = true, prev = 'genesis', validated = 0;
  for (const e of led) {
    if (e.prev !== prev) { chainOk = false; problems.push(`attestation ${String(e.hash).slice(0, 12)}: broken chain (prev ${String(e.prev).slice(0, 8)} ≠ expected ${String(prev).slice(0, 8)})`); }
    const att = deps.loadAttestation ? deps.loadAttestation(e.hash) : null;
    if (!att) problems.push(`attestation ${String(e.hash).slice(0, 12)}: object missing or fails signature/tamper check`);
    else validated++;
    prev = e.hash;
  }
  // 2) git/tree vs ledger: does the newest attestation still describe the code on disk?
  const last = led.length ? led[led.length - 1] : null;
  const covered = !!(last && deps.currentCodeTreeHash && last.codeTreeHash === deps.currentCodeTreeHash);
  if (last && !covered) problems.push(`the latest attestation (${String(last.hash).slice(0, 12)}) no longer matches the current code — re-run \`yay attest\` / \`yay reverify\``);
  // 3) spec-archive completeness: every signed spec identity should be archived (P1), so "as signed"
  //    reconstruction never depends on git surviving.
  let missingSpecs = 0, checkedSpecs = 0;
  if (deps.hasSpecObject) {
    const seen = new Set();
    for (const ap of deps.approvals || []) {
      for (const id of Object.keys(ap.items || {})) {
        const h = ap.items[id]; if (!h || seen.has(h)) continue; seen.add(h); checkedSpecs++;
        if (!deps.hasSpecObject(h)) missingSpecs++;
      }
    }
    if (missingSpecs) problems.push(`${missingSpecs} signed spec revision(s) are not in the archive (history could blank if git is lost) — re-sign or run a spec re-archive`);
  }
  return {
    ok: problems.length === 0,
    problems,
    checks: { attestations: led.length, attestationsValidated: validated, chainOk, latestCovered: covered, specsChecked: checkedSpecs, specsMissing: missingSpecs },
  };
}

// ── earned-autonomy metrics (from rejection + delegation history) ─────────────────
// "refactor delegated changes — 97% ratified; dependency changes — 31% rejected → exclude by default."
// Approximate but honest: delegated = autoApproved approvals; ratified ≈ a Cell that was delegated and
// later carries a real human approval; rejected = recorded rejection events (P3), by category.
function earnedAutonomy(rejections, approvals) {
  const rej = (rejections && rejections.events ? rejections.events : rejections) || [];
  const aps = approvals || [];
  // per-Cell: was it ever delegated? ever human-signed after?
  const delegatedCell = new Set(), humanCell = new Set();
  for (const ap of aps) {
    const ids = Object.keys(ap.items || {});
    if (ap.autoApproved) ids.forEach((id) => delegatedCell.add(id));
    else ids.forEach((id) => humanCell.add(id));
  }
  let ratified = 0; for (const id of delegatedCell) if (humanCell.has(id)) ratified++;
  const byCategory = {};
  let rejectedCells = 0;
  for (const e of rej) {
    if (e.type && e.type !== 'reject') continue;
    const cat = String(e.category || 'other').toLowerCase();
    const n = (e.cells || []).length || 1;
    byCategory[cat] = (byCategory[cat] || 0) + n;
    rejectedCells += n;
  }
  const delegated = delegatedCell.size;
  const decided = ratified + rejectedCells;
  const suggestions = [];
  for (const cat of Object.keys(byCategory)) {
    if (byCategory[cat] >= 3) suggestions.push(`"${cat}" changes have been rejected ${byCategory[cat]}× — consider excluding them from grants by default`);
  }
  return {
    delegated, ratified, rejected: rejectedCells, byCategory,
    ratifiedRate: decided ? +(ratified / decided).toFixed(3) : null,
    suggestions,
  };
}

module.exports = { reverifyDiff, integrityWitness, earnedAutonomy };
