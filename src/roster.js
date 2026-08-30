'use strict';
// The SIGNED roster — who is allowed to sign, as a tamper-evident chain.
//
// Without this, anyone (a malignant AI) with repo write could add their own key
// to the roster file and then "approve" their own code — defeating the whole
// protocol. So the roster is not a plain file you trust: it is an append-only log
// of events, each SIGNED by an existing OWNER's key (which lives on a phone, not
// on the AI's machine). `deriveRoster` rebuilds the set of trusted signers using
// ONLY events whose signatures check out — so an unsigned edit has no effect.
//
// Semantics: 1-of-N. Any enrolled signer may approve a Cell ALONE. Enrolling a
// signer is itself an owner-signed act; it does not require co-approval.
//
// Bootstrapping truth: the first event (genesis) is self-signed — it IS the trust
// root. If the AI can rewrite every file it could swap genesis too, so the root
// must be anchored outside the repo (a fingerprint pinned in CI, or your eyes).
// `deriveRoster` exposes rootFp and enforces an optional pin.

const C = require('./crypto');
const { canonical } = require('./util');

// Bytes an event is signed over: the event minus its own signature.
function eventBytes(event) {
  const { signature, ...body } = event; // eslint-disable-line no-unused-vars
  return canonical(body);
}

// Human-verifiable fingerprint of a public key (for pinning / eyeballing).
function fingerprint(pub) {
  const h = C.sha256(pub).slice(0, 16).toUpperCase();
  return h.replace(/(.{4})(?=.)/g, '$1-'); // 3F2A-9C11-8D0E-1B44
}

// Replay the log into an effective roster, trusting only validly-signed events.
// opts.root (optional) pins the expected genesis fingerprint.
// Returns { roster:{name:[pub]}, roles:{name:'owner'|'signer'}, rootFp, problems, ok }.
function deriveRoster(log, opts) {
  const events = (log && log.events) || [];
  const roster = {};
  const roles = {};
  const problems = [];
  let rootFp = null;
  let policy = { rules: [] }; // signing policy — set by owner-signed `policy` events (latest wins)
  let foundation = null;      // foundation seal payload — set by owner-signed `foundation` events (latest wins)
  let foundationMode = 'off'; // off | guarded | strict

  const ownerKeys = () => {
    const out = [];
    for (const n of Object.keys(roles)) if (roles[n] === 'owner') out.push(...(roster[n] || []));
    return out;
  };
  const addKey = (name, pub) => { (roster[name] = roster[name] || []); if (!roster[name].includes(pub)) roster[name].push(pub); };

  if (!events.length) return { roster, roles, rootFp, problems: ['roster log is empty — no trust root established'], ok: false };

  events.forEach((e, i) => {
    if (i === 0) {
      if (e.type !== 'genesis') { problems.push('first roster event must be genesis'); return; }
      if (!e.name || !e.pub || !e.signature || !C.verify(eventBytes(e), e.signature, e.pub)) { problems.push('genesis signature invalid — trust root not established'); return; }
      addKey(e.name, e.pub); roles[e.name] = 'owner'; rootFp = fingerprint(e.pub);
      return;
    }
    if (!rootFp) { problems.push(`event ${e.id || i}: no valid trust root, ignored`); return; }
    // Authority: the event must be signed by a CURRENT owner's key.
    const authorized = e.signature && ownerKeys().some((k) => C.verify(eventBytes(e), e.signature, k));
    if (!authorized) { problems.push(`event ${e.id || i} (${e.type} ${e.name || ''}) is not signed by an owner — REJECTED`); return; }
    if (e.type === 'add-signer') {
      if (!e.name || !e.pub) { problems.push(`event ${e.id || i}: add-signer missing name/pub`); return; }
      addKey(e.name, e.pub);
      if (!roles[e.name]) roles[e.name] = (e.role === 'owner' ? 'owner' : 'signer');
    } else if (e.type === 'add-key') {
      if (!roster[e.name]) { problems.push(`event ${e.id || i}: add-key for unknown identity "${e.name}"`); return; }
      addKey(e.name, e.pub);
    } else if (e.type === 'revoke-key') {
      // Remove one compromised/rotated key; the identity survives if it has others.
      // (Past seals stay attributed — this only governs who can sign going forward.)
      if (!e.name || !e.pub) { problems.push(`event ${e.id || i}: revoke-key missing name/pub`); return; }
      if (roster[e.name]) { roster[e.name] = roster[e.name].filter((k) => k !== e.pub); if (!roster[e.name].length) { delete roster[e.name]; delete roles[e.name]; } }
    } else if (e.type === 'remove-signer') {
      // Remove an identity entirely (all its keys). History remains attributed.
      if (!e.name) { problems.push(`event ${e.id || i}: remove-signer missing name`); return; }
      delete roster[e.name]; delete roles[e.name];
    } else if (e.type === 'policy') {
      // Owner-signed signing policy. The rules are inside eventBytes, so they're
      // tamper-evident and chained like every other governance event. Latest wins;
      // an empty ruleset returns to neutral.
      policy = { rules: Array.isArray(e.rules) ? e.rules : [] };
    } else if (e.type === 'foundation') {
      // Owner-signed FOUNDATION SEAL — the baseline of the fixed core files (see foundation.js).
      // Being an owner-signed, chained roster event makes it un-removable: deleting it breaks
      // the pinned chain and is itself flagged. Latest wins; mode 'off' retires the seal.
      foundationMode = ['guarded', 'strict', 'off'].includes(e.mode) ? e.mode : 'guarded';
      foundation = (foundationMode === 'off') ? null : (e.seal || null);
    } else {
      problems.push(`event ${e.id || i}: unknown type "${e.type}"`);
    }
  });

  // Safety: never let a revocation leave the project with no owner (governance lockout).
  if (rootFp && !ownerKeys().length) problems.push('roster would have NO owner key left — governance locked out (revocation refused)');

  const pinned = opts && opts.root ? String(opts.root).toUpperCase() : null;
  if (pinned && rootFp && pinned !== rootFp) problems.push(`TRUST-ROOT MISMATCH: expected ${pinned}, found ${rootFp} — the roster may have been swapped`);

  return { roster, roles, rootFp, problems, ok: problems.length === 0, policy, foundation, foundationMode };
}

// Next event id given a log.
function nextEventId(log) {
  const n = ((log && log.events) || []).length + 1;
  return 'R-' + String(n).padStart(4, '0');
}

module.exports = { deriveRoster, eventBytes, fingerprint, nextEventId };
