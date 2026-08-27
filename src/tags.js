'use strict';
// Brief TAGS — a small, project-chosen vocabulary that every Brief is tagged with, so the
// history of what was built can be sorted by concern over time. Neutral by default in the
// sense that the pool is the project's choice; once a pool is set, tagging is required on
// each Brief (Standard §5). Tags ride inside the signed Brief, so they are attributed and
// tamper-evident like the rest of the approval.
const fs = require('fs');
const path = require('path');

// Six curated, mutually distinct starter sets. Pick one at `yay init`; switch or extend
// later with `yay tags`. The `tags` list is the authoritative active pool once chosen.
const TAG_SETS = [
  { id: 'technical', name: 'Technical / code type', desc: 'By the kind of code — HTML, CSS, API, Database…',
    tags: ['HTML', 'CSS', 'JavaScript', 'Frontend', 'Backend', 'API', 'Database', 'Auth', 'Validation', 'Testing', 'Config', 'Build', 'DevOps', 'Utilities'] },
  { id: 'responsibility', name: 'Responsibility', desc: 'By what the code is responsible for — UI, State, Security…',
    tags: ['UI', 'State', 'Events', 'Routing', 'Business Logic', 'Data Access', 'API', 'Persistence', 'Security', 'Error Handling', 'Logging', 'Caching', 'Performance', 'Testing', 'Config', 'Infrastructure'] },
  { id: 'component', name: 'Component kind', desc: 'By the kind of unit — Component, Service, Model, Worker…',
    tags: ['Component', 'Hook', 'Service', 'Controller', 'Model', 'Repository', 'Middleware', 'Validator', 'Serializer', 'Adapter', 'Provider', 'Factory', 'Utility', 'Worker', 'Job', 'Command', 'Event', 'Listener', 'Test', 'Fixture'] },
  { id: 'layer', name: 'Layer', desc: 'By architectural layer — Presentation, Domain, Data, Infra…',
    tags: ['Presentation', 'Interaction', 'Application', 'Domain', 'Service', 'Integration', 'Data Access', 'Persistence', 'Infrastructure', 'Security'] },
  { id: 'area', name: 'App area', desc: 'By where it lives in the product — Header, Settings, Auth…',
    tags: ['App Shell', 'Header', 'Navigation', 'Sidebar', 'Toolbar', 'Main Content', 'Dashboard', 'Page', 'Form', 'Modal', 'Search', 'Notifications', 'Profile', 'Settings', 'Auth', 'Admin', 'Footer', 'Onboarding'] },
  { id: 'product', name: 'Product system', desc: 'By product subsystem — Experience, Identity, Data, Integration…',
    tags: ['Experience', 'Navigation', 'Interaction', 'Content', 'Application', 'Domain', 'Identity', 'Data', 'Communication', 'Integration', 'Background Jobs', 'Observability', 'Infrastructure'] },
];
const setById = (id) => TAG_SETS.find((s) => s.id === id) || null;

// "Custom" isn't a preset — it seeds blank placeholders the user relabels afterwards
// (in the Dashboard Tags tab, or by editing .yaylayer/tags.json directly).
const CUSTOM_SEED = ['Custom 1', 'Custom 2', 'Custom 3', 'Custom 4'];

function tagsPath(p) { return path.join(path.dirname(p.config), 'tags.json'); }
function loadTags(p) {
  try { const o = JSON.parse(fs.readFileSync(tagsPath(p), 'utf8')); return (o && Array.isArray(o.tags)) ? o : null; }
  catch (_) { return null; }
}
function saveTags(p, obj) { fs.writeFileSync(tagsPath(p), JSON.stringify(obj, null, 2) + '\n'); }

// Case/space-insensitive match; returns the pool's canonical casing when a tag is in-pool.
const norm = (t) => String(t == null ? '' : t).trim().toLowerCase().replace(/\s+/g, ' ');
function canonicalTag(pool, t) { const n = norm(t); const hit = (pool || []).find((x) => norm(x) === n); return hit || String(t).trim(); }
function isKnown(pool, t) { const n = norm(t); return (pool || []).some((x) => norm(x) === n); }
// Parse a comma/space separated tag string into a de-duped, canonical list.
function parseTags(pool, raw) {
  const seen = new Set(); const out = [];
  String(raw || '').split(/[,\n]/).map((s) => s.trim()).filter(Boolean).forEach((t) => {
    const c = canonicalTag(pool, t); const k = norm(c);
    if (!seen.has(k)) { seen.add(k); out.push(c); }
  });
  return out;
}
function unknownTags(pool, tags) { return (tags || []).filter((t) => !isKnown(pool, t)); }

module.exports = { TAG_SETS, setById, CUSTOM_SEED, tagsPath, loadTags, saveTags, canonicalTag, isKnown, parseTags, unknownTags, norm };
