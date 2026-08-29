'use strict';
// Shared ratification helpers. The "reviewed bundle" is the exact set + content a human sees
// before ratifying delegated (Autopilot) work; its hash lets `yay ratify --sign` prove it signs
// PRECISELY what was reviewed (TOCTOU protection). One implementation, used by both the CLI and
// the dashboard, so the render-time hash and the sign-time hash are computed identically.
const { sha256 } = require('./crypto');
const { canonical } = require('./util');

// Cells whose current effective approval is a grant auto-approval (delegated, awaiting ratification).
function autoCellIds(verified) {
  const results = (verified && verified.results) || {};
  return Object.keys(results).filter((id) => { const t = results[id].trust; return !!(t && t.auto); });
}

// A stable hash over {each delegated Cell's specHash + code hash + grant}. Any material change —
// spec edited, code changed, the delegated set changed, a different grant — yields a different hash.
function ratifyBundle(manifest, verified, autoIds) {
  const ids = (autoIds || autoCellIds(verified)).slice().sort();
  const per = {};
  for (const id of ids) {
    const c = (manifest.cells || {})[id] || {};
    const t = ((verified.results || {})[id] || {}).trust || {};
    per[id] = { spec: c.specHash || null, code: sha256(String(c.unitBody || '')), grant: t.grant || null };
  }
  return { ids, per, hash: sha256(canonical({ v: 1, cells: per })) };
}

module.exports = { autoCellIds, ratifyBundle };
