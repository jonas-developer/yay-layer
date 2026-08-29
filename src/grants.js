'use strict';
// Autopilot — scoped, owner-signed delegation GRANTS.
//
// A grant lets the machine AUTO-APPROVE in-scope, non-sensitive Cells for a bounded
// window (time + count) without contacting the phone. It binds a machine-held grant
// PUBLIC key (the laptop keeps the matching private key and signs auto-approvals with
// it). The owner signs the grant on their phone (or local key) — the AI can never issue
// one. `yay verify` accepts an auto-approval only when a valid, unexpired, unrevoked,
// in-count, in-scope grant covers it; the Cell is then GREEN-on-verify but marked AUTO
// on the TRUST axis and queued for human ratification.
//
// A grant/revoke is a signed event (same body-canonicalisation as roster.eventBytes),
// stored append-only in .yaylayer/grants.json.
const C = require('./crypto');
const roster = require('./roster');

function safeVerify(msg, sig, pub) { try { return !!(sig && pub && C.verify(msg, sig, pub)); } catch (_) { return false; } }

// A Cell is SENSITIVE — never auto-approvable — if it is code-pinned or marked sensitive.
// These always require a real human signature, grant or not.
//
// KNOWN LIMITATION (P0 grant-broadening audit, to close in P3): sensitivity here is derived
// ONLY from AI-writable spec fields, so an agent under a grant could strip `sensitive:` / a
// code-pin marker to pull a previously-sensitive Cell into the grant's scope. Grant EVENTS are
// owner-signed and tamper-proof (the AI can't mint/widen one, or edit scope.cells) — this is the
// single remaining broadening vector, and it's mitigated because the marker's removal is visible
// in the ratification spec-diff. P3 closes it fully by moving non-delegable classification to
// OWNER-SIGNED policy (path/tag/module), which lives outside the delegated surface, per the
// principle: the authorization boundary must not be editable by the authority being delegated.
function isSensitive(cell) {
  if (!cell) return true;
  const sp = cell.spec || {};
  if (cell.codePin || sp.codePin || sp['code-pin'] || sp['code_pin']) return true;
  const s = sp.sensitive;
  return s === true || s === 'yes' || s === 'true';
}

// Does a grant's scope cover this Cell? Default scope = every non-sensitive Cell.
// An explicit `scope.cells` allow-list narrows it further.
function grantCoversCell(grant, cellId, cell) {
  if (!grant) return false;
  if (isSensitive(cell)) return false;
  const sc = grant.scope || {};
  if (Array.isArray(sc.cells) && sc.cells.length) return sc.cells.includes(cellId);
  return true;
}

// Validate + summarise every grant in the append-only log against the owner keys, the
// clock, revocations, and the auto-approvals already spent (from lock.approvals).
function deriveGrants(glog, ownerPubs, lockApprovals, nowMs) {
  const now = nowMs || Date.now();
  const events = (glog && glog.events) || [];
  const revokeAt = {};
  for (const e of events) if (e.type === 'grant-revoke' && e.grant) revokeAt[e.grant] = e.at;
  const autos = {};
  for (const a of (lockApprovals || [])) if (a.autoApproved && a.grant) (autos[a.grant] = autos[a.grant] || []).push(a);
  for (const g of Object.keys(autos)) autos[g].sort((x, y) => String(x.at).localeCompare(String(y.at)));
  const out = {};
  for (const e of events) {
    if (e.type !== 'grant') continue;
    const ownerOk = !!(e.signature && (ownerPubs || []).some((pub) => safeVerify(roster.eventBytes(e), e.signature, pub)));
    const rAt = revokeAt[e.id] || null;
    const spent = (autos[e.id] || []).length;
    const expired = !!(e.expiresAt && Date.parse(e.expiresAt) <= now);
    const active = ownerOk && !expired && !rAt && (!e.maxCount || spent < e.maxCount);
    out[e.id] = {
      ...e, ownerOk, revokeAt: rAt, revoked: !!rAt, expired, spent,
      remaining: e.maxCount ? Math.max(0, e.maxCount - spent) : null,
      active, autos: autos[e.id] || [],
    };
  }
  return out;
}

// The single active grant to auto-sign with right now (most recently issued that is
// active), or null. `cells` (id → cell) lets us confirm all targets are in scope.
function activeGrantFor(grants, targetIds, cells) {
  const list = Object.values(grants || {}).filter((g) => g.active)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
  for (const g of list) {
    if (g.maxCount && g.spent + targetIds.length > g.maxCount) continue; // would blow the count
    if (targetIds.every((id) => grantCoversCell(g, id, cells[id]))) return g;
  }
  return null;
}

// Is THIS auto-approval of `cellId` acceptable under its grant? (verify does the actual
// signature check with grant.grantPub; here we check the grant + window + scope + count.)
function autoApprovalOk(grant, approval, cellId, cell) {
  if (!grant) return { ok: false, reason: 'no such grant' };
  if (!grant.ownerOk) return { ok: false, reason: 'grant is not validly owner-signed' };
  const at = Date.parse(approval.at) || 0;
  if (Date.parse(grant.at) && at < Date.parse(grant.at)) return { ok: false, reason: 'approval predates the grant' };
  if (grant.expiresAt && at > Date.parse(grant.expiresAt)) return { ok: false, reason: 'grant had expired' };
  if (grant.revokeAt && at > Date.parse(grant.revokeAt)) return { ok: false, reason: 'grant was revoked before this approval' };
  if (!grantCoversCell(grant, cellId, cell)) return { ok: false, reason: 'Cell is outside the grant scope' };
  if (grant.maxCount) {
    const idx = (grant.autos || []).findIndex((a) => a.id === approval.id);
    if (idx >= 0 && idx >= grant.maxCount) return { ok: false, reason: 'grant count exceeded' };
  }
  return { ok: true };
}

module.exports = { isSensitive, grantCoversCell, deriveGrants, activeGrantFor, autoApprovalOk };
