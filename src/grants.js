'use strict';
// Autopilot — scoped, owner-signed delegation GRANTS, expanded in P3 into signed CAPABILITY
// ENVELOPES with attenuating CHILD GRANTS.
//
// A grant lets the machine AUTO-APPROVE in-scope, non-sensitive Cells for a bounded window
// (time + count + path/cell/risk envelope) without contacting the phone. It binds a machine-held
// grant PUBLIC key (the laptop keeps the matching private key and signs auto-approvals with it).
// The owner signs the grant on their phone (or local key) — the AI can never issue one. `yay verify`
// accepts an auto-approval only when a valid, unexpired, unrevoked, in-count, in-envelope grant
// covers it; the Cell is then GREEN-on-verify but marked AUTO on the TRUST axis and queued for
// human ratification.
//
// ENVELOPE (P3): { allow:[globs], deny:[globs], cells:[ids], maxCells, maxRisk, deps, deployment,
//                  childGrants:{allowed,maxDepth} }. Scope constraints (allow/deny/cells/maxCells/
//                  maxRisk) are enforced NOW — we know where a change lands. Content constraints
//                  (deps/deployment/network) are DETECTOR-GATED (D15): recorded + shown, enforced
//                  only where a detector exists, so we never promise a boundary we can't verify.
//
// CHILD GRANTS (P3): a grant may carry `parent` + be signed by the parent's GRANT key (not an
// owner). It can only ATTENUATE — allow ⊆ parent.allow, deny ⊇ parent.deny, maxCount ≤ parent
// remaining, expiry ≤ parent, risk ≤ parent, depth ≤ parent.childGrants.maxDepth. The verifier
// REFUSES any child that exceeds its parent, so no new authority is ever minted below the human
// root. Off by default (parent must set childGrants.allowed).
//
// A grant/revoke is a signed event (same body-canonicalisation as roster.eventBytes), stored
// append-only in .yaylayer/grants.json.
const C = require('./crypto');
const roster = require('./roster');
const { nonDelegable, globToRe } = require('./policy');

function safeVerify(msg, sig, pub) { try { return !!(sig && pub && C.verify(msg, sig, pub)); } catch (_) { return false; } }

const RISK = { low: 1, medium: 2, high: 3 };
function riskRank(r) { return RISK[String(r || 'medium').toLowerCase()] || RISK.medium; }

// Normalize a grant event's envelope, tolerating the legacy shape (`scope.cells` + `maxCount`).
function envelopeOf(grant) {
  const g = grant || {};
  const env = g.envelope || {};
  const legacyCells = (g.scope && Array.isArray(g.scope.cells)) ? g.scope.cells : null;
  const cg = env.childGrants || {};
  return {
    allow: Array.isArray(env.allow) ? env.allow : [],
    deny: Array.isArray(env.deny) ? env.deny : [],
    cells: Array.isArray(env.cells) ? env.cells : (legacyCells || []),
    maxRisk: env.maxRisk || null,
    deps: env.deps || null,             // detector-gated (recorded)
    deployment: env.deployment || null, // detector-gated (recorded)
    childGrants: { allowed: !!cg.allowed, maxDepth: cg.maxDepth != null ? cg.maxDepth : (cg.allowed ? 1 : 0) },
  };
}

function pathMatchesAny(globs, file) {
  if (!globs || !globs.length) return null; // no constraint
  return globs.some((g) => { try { return globToRe(g).test(file || ''); } catch (_) { return false; } });
}

// A Cell is SENSITIVE — never auto-approvable — if it is code-pinned or marked sensitive in its
// spec. This is the COOPERATIVE signal (AI-writable, so an agent could strip it — visible in the
// ratification spec-diff). The AUTHORITATIVE backstop is the owner-signed policy `delegable:false`
// (see grantCoversCell's `nonDelegable` check), which lives outside the delegated surface.
function isSensitive(cell) {
  if (!cell) return true;
  const sp = cell.spec || {};
  if (cell.codePin || sp.codePin || sp['code-pin'] || sp['code_pin']) return true;
  const s = sp.sensitive;
  return s === true || s === 'yes' || s === 'true';
}

// The risk level a Cell declares (`risk: low|medium|high`), defaulting to medium when unstated.
function cellRisk(cell) { return String(((cell && cell.spec) || {}).risk || 'medium').toLowerCase(); }

// Does a grant's envelope cover this Cell? opts.policy (owner-signed) supplies the authoritative
// non-delegable backstop. Returns a { ok, reason } so the verifier can explain a refusal.
function grantCoversCellR(grant, cellId, cell, opts) {
  if (!grant) return { ok: false, reason: 'no grant' };
  const policy = (opts && opts.policy) || { rules: [] };
  if (nonDelegable(policy, cell || { file: '', spec: {} })) return { ok: false, reason: 'owner-signed policy marks this area non-delegable — needs a real human signature' };
  if (isSensitive(cell)) return { ok: false, reason: 'Cell is sensitive/code-pinned — needs a real human signature' };
  const env = envelopeOf(grant);
  if (env.cells.length && !env.cells.includes(cellId)) return { ok: false, reason: 'Cell is not in the grant cell allow-list' };
  const file = (cell && cell.file) || '';
  if (env.deny.length && pathMatchesAny(env.deny, file)) return { ok: false, reason: `path is in the grant's deny list` };
  const allowM = pathMatchesAny(env.allow, file);
  if (allowM === false) return { ok: false, reason: `path is outside the grant's allowed paths` };
  if (env.maxRisk && riskRank(cellRisk(cell)) > riskRank(env.maxRisk)) return { ok: false, reason: `Cell risk (${cellRisk(cell)}) exceeds the grant's max risk (${env.maxRisk})` };
  return { ok: true };
}
// Boolean convenience (back-compat with existing callers).
function grantCoversCell(grant, cellId, cell, opts) { return grantCoversCellR(grant, cellId, cell, opts).ok; }

// ── child-grant attenuation ────────────────────────────────────────────────────
// Every constraint of a child must be ⊆ its parent. Returns { ok, reason }.
function attenuates(child, parent) {
  const c = envelopeOf(child), p = envelopeOf(parent);
  // allow: every child allow path must be inside SOME parent allow (or parent unrestricted).
  if (p.allow.length) {
    if (!c.allow.length) return { ok: false, reason: 'child must restrict allowed paths (parent is path-scoped)' };
    for (const a of c.allow) { if (pathMatchesAny(p.allow, sampleOf(a)) === false) return { ok: false, reason: `child allow "${a}" is outside parent allow` }; }
  }
  // deny: child must inherit (⊇) every parent deny.
  for (const d of p.deny) { if (!c.deny.includes(d)) return { ok: false, reason: `child must keep parent deny "${d}"` }; }
  // cells: if parent restricts to a cell list, child's must be a subset.
  if (p.cells.length) { for (const id of c.cells) if (!p.cells.includes(id)) return { ok: false, reason: `child cell "${id}" is outside parent cells` }; }
  // maxCount: child ≤ parent remaining.
  if (parent.maxCount != null && (child.maxCount == null || child.maxCount > parent.maxCount)) return { ok: false, reason: 'child maxCount exceeds parent' };
  // expiry: child ≤ parent.
  if (parent.expiresAt && (!child.expiresAt || Date.parse(child.expiresAt) > Date.parse(parent.expiresAt))) return { ok: false, reason: 'child expiry is later than parent' };
  // risk: child ≤ parent.
  if (p.maxRisk && riskRank(c.maxRisk || 'high') > riskRank(p.maxRisk)) return { ok: false, reason: 'child max risk exceeds parent' };
  // depth: parent must allow children.
  if (!p.childGrants.allowed) return { ok: false, reason: 'parent does not permit child grants' };
  return { ok: true };
}
// A representative concrete path for a child allow-glob, so we can test containment against the
// parent's globs (e.g. child "src/ui/**" → sample "src/ui/x" which parent "src/**" must match).
function sampleOf(glob) { return String(glob).replace(/\*\*/g, 'x').replace(/\*/g, 'x'); }

// Validate + summarise every grant in the append-only log against the owner keys, the clock,
// revocations, the auto-approvals spent, AND (P3) the parent chain for child grants.
function deriveGrants(glog, ownerPubs, lockApprovals, nowMs) {
  const now = nowMs || Date.now();
  const events = (glog && glog.events) || [];
  const revokeAt = {};
  for (const e of events) if (e.type === 'grant-revoke' && e.grant) revokeAt[e.grant] = e.at;
  const autos = {};
  for (const a of (lockApprovals || [])) if (a.autoApproved && a.grant) (autos[a.grant] = autos[a.grant] || []).push(a);
  for (const g of Object.keys(autos)) autos[g].sort((x, y) => String(x.at).localeCompare(String(y.at)));

  const grantEvents = events.filter((e) => e.type === 'grant');
  const byId = {};
  for (const e of grantEvents) byId[e.id] = e;
  const out = {};

  // Depth-ordered pass: a child validates against its (already-derived) parent. Parents have no
  // `parent` field so they resolve first; children resolve once their parent is in `out`.
  const pending = grantEvents.slice();
  let guard = pending.length + 1;
  while (pending.length && guard-- > 0) {
    const still = [];
    for (const e of pending) {
      if (e.parent && !out[e.parent]) { still.push(e); continue; } // parent not derived yet
      out[e.id] = deriveOne(e, out, ownerPubs, revokeAt, autos, now);
    }
    if (still.length === pending.length) { // unresolved parents (missing/cyclic) — mark invalid
      for (const e of still) out[e.id] = deriveOne(e, out, ownerPubs, revokeAt, autos, now);
      break;
    }
    pending.length = 0; pending.push(...still);
  }
  return out;
}

function deriveOne(e, out, ownerPubs, revokeAt, autos, now) {
  const rAt = revokeAt[e.id] || null;
  const spent = (autos[e.id] || []).length;
  const expired = !!(e.expiresAt && Date.parse(e.expiresAt) <= now);
  let ownerOk = false, chain = null, attenuation = null;
  if (e.parent) {
    // Child: authority DESCENDS from the parent. It must be signed by the parent's grant key
    // (issuedBy), the parent must be valid, and the child must strictly attenuate.
    const parent = out[e.parent];
    const parentValid = !!(parent && parent.ownerOk && !parent.revoked);
    const sigOk = !!(parent && safeVerify(roster.eventBytes(e), e.signature, parent.grantPub) && (!e.issuedBy || e.issuedBy === parent.grantPub));
    attenuation = parent ? attenuates(e, parent) : { ok: false, reason: 'parent grant not found' };
    ownerOk = parentValid && sigOk && attenuation.ok;
    chain = { parent: e.parent, parentValid, sigOk, attenuates: attenuation.ok, reason: attenuation.ok ? null : (sigOk ? attenuation.reason : 'child not signed by the parent grant key') };
  } else {
    // Root grant: must be validly OWNER-signed.
    ownerOk = !!(e.signature && (ownerPubs || []).some((pub) => safeVerify(roster.eventBytes(e), e.signature, pub)));
  }
  // A parent's revocation cascades: a child is inactive once its parent is revoked/expired.
  let parentInactive = false;
  if (e.parent) { const pr = out[e.parent]; parentInactive = !pr || !pr.active; }
  const active = ownerOk && !expired && !rAt && !parentInactive && (!e.maxCount || spent < e.maxCount);
  return {
    ...e, ownerOk, revokeAt: rAt, revoked: !!rAt, expired, spent,
    remaining: e.maxCount ? Math.max(0, e.maxCount - spent) : null,
    active, autos: autos[e.id] || [], envelope: envelopeOf(e), chain,
  };
}

// The single active grant to auto-sign with right now (most recently issued that is active), or
// null. `cells` (id → cell) lets us confirm all targets are in scope. opts.policy = owner-signed.
function activeGrantFor(grants, targetIds, cells, opts) {
  const list = Object.values(grants || {}).filter((g) => g.active)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  for (const g of list) {
    if (g.maxCount && g.spent + targetIds.length > g.maxCount) continue; // would blow the count
    if (targetIds.every((id) => grantCoversCell(g, id, cells[id], opts))) return g;
  }
  return null;
}

// Is THIS auto-approval of `cellId` acceptable under its grant? (verify does the actual signature
// check with grant.grantPub; here we check the grant + window + envelope + count.)
function autoApprovalOk(grant, approval, cellId, cell, opts) {
  if (!grant) return { ok: false, reason: 'no such grant' };
  if (!grant.ownerOk) return { ok: false, reason: grant.parent ? 'child grant does not validly chain to the owner root' : 'grant is not validly owner-signed' };
  const at = Date.parse(approval.at) || 0;
  if (Date.parse(grant.at) && at < Date.parse(grant.at)) return { ok: false, reason: 'approval predates the grant' };
  if (grant.expiresAt && at > Date.parse(grant.expiresAt)) return { ok: false, reason: 'grant had expired' };
  if (grant.revokeAt && at > Date.parse(grant.revokeAt)) return { ok: false, reason: 'grant was revoked before this approval' };
  const cov = grantCoversCellR(grant, cellId, cell, opts);
  if (!cov.ok) return { ok: false, reason: cov.reason };
  if (grant.maxCount) {
    const idx = (grant.autos || []).findIndex((a) => a.id === approval.id);
    if (idx >= 0 && idx >= grant.maxCount) return { ok: false, reason: 'grant count exceeded' };
  }
  return { ok: true };
}

module.exports = {
  isSensitive, cellRisk, riskRank, envelopeOf, grantCoversCell, grantCoversCellR,
  attenuates, deriveGrants, activeGrantFor, autoApprovalOk,
};
