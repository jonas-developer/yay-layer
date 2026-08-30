'use strict';
// The FOUNDATION SEAL — an owner-signed baseline of a project's fixed core, so that any
// change to it is REVEALED at verify time. It watches two things:
//
//   1. CONTENT drift — the hash of each sealed core file (for the AI-rule files, only the
//      YAYLAYER block, so the owner's own surrounding notes stay free).
//   2. STRUCTURAL drift — the set of TRACKED files in watched zones (repo root, .github, the
//      .yaylayer config), so a NEW or REMOVED file (a dropped payload, a rogue workflow) shows.
//
// It is CAUSE-AGNOSTIC: a hijacked AI, a disk/bit-rot corruption, a bad merge, or a fat-fingered
// edit all surface the same way — the current bytes no longer match what the Owner last vouched
// for. This is detection, not prevention: the human investigates and re-seals (owner key only).
//
// Pure + testable: the exported functions take a root and a caller-supplied list of tracked
// files (so the git dependency lives in the CLI, and the smoke tests can drive it directly).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Owner-chosen exclusions (globs) for TRACKED files that legitimately churn inside a watched
// zone (e.g. a committed CHANGELOG or version file). Gitignored files (.env…) are already out
// (the seal watches only the tracked set), so this is only for committed-but-churning files.
// The list is stored INSIDE the signed seal, so an exclusion is an owner-vouched act — the AI
// cannot add "ignore my-payload.js" without the phone key. Each exclusion is a signed blind spot.
function globToRe(g) {
  const esc = String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, ' ').replace(/\*/g, '[^/]*').replace(/ /g, '.*');
  return new RegExp('^' + esc + '$');
}
function isIgnored(rel, globs) {
  const f = String(rel).replace(/\\/g, '/');
  return (globs || []).some((g) => { try { return globToRe(g).test(f); } catch (_) { return false; } });
}

// The BEGIN/END markers `yay constitution` wraps the managed rules block in. Content-sealing a
// rule file hashes ONLY this block, so a project's own additions around it never trip the seal.
const BLOCK_BEGIN = '<!-- YAYLAYER:BEGIN';
const BLOCK_END = '<!-- YAYLAYER:END -->';
function extractBlock(text) {
  const i = text.indexOf(BLOCK_BEGIN);
  if (i < 0) return null;
  const j = text.indexOf(BLOCK_END, i);
  if (j < 0) return null;
  return text.slice(i, j + BLOCK_END.length);
}

// AI-rule files — content-sealed on their YAYLAYER block only (blockOnly:true).
const RULE_FILES = [
  'CLAUDE.md', 'AGENTS.md', '.cursorrules', 'GEMINI.md', '.windsurfrules', '.clinerules',
  '.github/copilot-instructions.md',
];
// Other core files — content-sealed whole (they have no managed block).
// `.gitignore` is sealed on purpose: it controls the structural blind spot (a rogue AI could
// add `payload.js` to it to make the file untracked → invisible to the zone watch), so any
// change to what's hidden is itself revealed and needs a re-seal.
const CORE_FILES = [
  '.github/workflows/yaylayer.yml', '.yaylayerignore', '.gitignore', 'CONSTITUTION.md', 'standard/STANDARD.md',
];
// Zones whose TRACKED file-set should stay stable — a new/removed file here is revealed.
// Root is watched at TOP LEVEL only (depth 0); the others recurse.
const WATCH_ZONES = [
  { dir: '.', recurse: false },
  { dir: '.github', recurse: true },
  { dir: '.yaylayer', recurse: false },
];

// Digest one sealed file. blockOnly → hash just the YAYLAYER block. Returns null if absent
// (a MISSING sealed file is itself a finding, surfaced by compareSeal, not an error here).
function fileDigest(root, rel, blockOnly) {
  let text;
  try { text = fs.readFileSync(path.join(root, rel), 'utf8'); } catch (_) { return null; }
  if (blockOnly) { const b = extractBlock(text); return b == null ? null : sha256(b); }
  return sha256(text);
}

// Restrict a caller-supplied tracked-file list to a zone's own files (posix-relative paths).
function filesInZone(tracked, zone) {
  const prefix = zone.dir === '.' ? '' : zone.dir.replace(/\\/g, '/').replace(/\/$/, '') + '/';
  return (tracked || []).map((f) => f.replace(/\\/g, '/')).filter((f) => {
    if (zone.dir === '.') return !f.includes('/'); // top-level only
    if (!f.startsWith(prefix)) return false;
    return zone.recurse ? true : !f.slice(prefix.length).includes('/');
  }).sort();
}

// Build the seal payload the Owner signs. `tracked` is the repo's tracked-file list (e.g. from
// `git ls-files`); `opts.files`/`opts.zones` override the defaults (owner --add/--remove).
function buildSeal(root, tracked, opts = {}) {
  const ruleFiles = opts.ruleFiles || RULE_FILES;
  const coreFiles = opts.coreFiles || CORE_FILES;
  const zones = opts.zones || WATCH_ZONES;
  const ignore = opts.ignore || [];
  const extra = opts.extra || []; // owner-added globs (`yay protect --add`): content-seal matching tracked files
  const files = {};
  // Only seal rule/core files that actually exist — you can't vouch for what's not there.
  for (const rel of ruleFiles) { if (isIgnored(rel, ignore)) continue; const d = fileDigest(root, rel, true); if (d) files[rel] = { hash: d, block: true }; }
  for (const rel of coreFiles) { if (isIgnored(rel, ignore)) continue; const d = fileDigest(root, rel, false); if (d) files[rel] = { hash: d, block: false }; }
  // Owner-added extras: any tracked file matching an --add glob (whole-file hash).
  if (extra.length) for (const rel of (tracked || []).map((f) => f.replace(/\\/g, '/'))) {
    if (files[rel] || isIgnored(rel, ignore) || !isIgnored(rel, extra)) continue; // reuse glob-match via isIgnored
    const d = fileDigest(root, rel, false); if (d) files[rel] = { hash: d, block: false };
  }
  const zoneSets = {};
  for (const z of zones) zoneSets[z.dir] = { recurse: !!z.recurse, files: filesInZone(tracked, z).filter((f) => !isIgnored(f, ignore)) };
  return { version: 1, files, zones: zoneSets, ignore, extra };
}

// Compare the CURRENT tree against a signed seal → the findings a human should see.
//   changed[]      — a sealed file whose bytes/block no longer match
//   missing[]      — a sealed file that has vanished
//   addedFiles[]   — a tracked file that appeared in a watched zone since sealing
//   removedFiles[] — a tracked file that vanished from a watched zone
function compareSeal(root, seal, tracked) {
  const ignore = (seal && seal.ignore) || []; // the SIGNED exclusions — applied to the current tree too
  const changed = [], missing = [];
  for (const rel of Object.keys((seal && seal.files) || {})) {
    const want = seal.files[rel];
    const now = fileDigest(root, rel, !!want.block);
    if (now == null) missing.push(rel);
    else if (now !== want.hash) changed.push(rel);
  }
  const addedFiles = [], removedFiles = [];
  // Structural check needs the tracked-file list; skip it (content-only) when it's unavailable,
  // so we never report false "removed" for every zone file.
  if (Array.isArray(tracked)) for (const dir of Object.keys((seal && seal.zones) || {})) {
    const z = seal.zones[dir];
    const before = new Set(z.files || []);
    const after = new Set(filesInZone(tracked, { dir, recurse: z.recurse }).filter((f) => !isIgnored(f, ignore)));
    for (const f of after) if (!before.has(f)) addedFiles.push(f);
    for (const f of before) if (!after.has(f)) removedFiles.push(f);
  }
  const clean = !changed.length && !missing.length && !addedFiles.length && !removedFiles.length;
  return { clean, changed, missing, addedFiles: addedFiles.sort(), removedFiles: removedFiles.sort() };
}

module.exports = { buildSeal, compareSeal, fileDigest, extractBlock, filesInZone, sha256, RULE_FILES, CORE_FILES, WATCH_ZONES };
