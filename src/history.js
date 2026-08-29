'use strict';
// Reconstruct a Cell's spec + code AS IT WAS when a given Brief signed it, straight from git —
// using the Brief's stored specHash as an exact, self-verifying anchor. Powers the Briefs-tab
// "As signed / Current / What changed" view: a Brief is a point-in-time record, so opening a Cell
// *through* it should show the version that was authorized, not today's. Read-only; needs git.
const path = require('path');
const cp = require('child_process');
const { MARK_BEGIN, MARK_END, langOf } = require('./util');
const { sha256 } = require('./crypto');
const { parseSpec, grabUnitBody } = require('./extract');

function git(dir, args) {
  return cp.execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}
function prefixBase(absFile) {
  const dir = path.dirname(absFile), base = path.basename(absFile);
  const prefix = git(dir, ['rev-parse', '--show-prefix']).trim(); // repo-root → file's dir (survives symlinked toplevels)
  return { dir, rel: prefix + base };
}
function showAt(dir, rel, commit) {
  try { return git(dir, ['show', commit + ':' + rel]); } catch (_) { return null; }
}
// The normalized marker-block for a Cell in raw content — byte-identical to extract.js, so
// sha256(it) equals the stored specHash. Returns null if the Cell isn't present in that version.
function normalizedBlock(content, cellId) {
  const lines = String(content).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const b = lines[i].match(MARK_BEGIN);
    if (b && b[1] === cellId) {
      const block = [lines[i]];
      for (let j = i + 1; j < lines.length; j++) { block.push(lines[j]); if (MARK_END.test(lines[j])) return block.map((l) => l.replace(/\s+$/, '')).join('\n'); }
      return null;
    }
  }
  return null;
}
// Extract a Cell's spec block + code body from raw content at a given language family.
function cellFromContent(content, cellId, family) {
  const lines = String(content).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const b = lines[i].match(MARK_BEGIN);
    if (b && b[1] === cellId) {
      const block = [lines[i]]; let end = -1;
      for (let j = i + 1; j < lines.length; j++) { block.push(lines[j]); if (MARK_END.test(lines[j])) { end = j; break; } }
      if (end === -1) return null;
      const spec = parseSpec(block);
      const unit = grabUnitBody(lines, end + 1, family);
      return { spec, block: block.map((l) => l.replace(/\s+$/, '')).join('\n'), code: unit ? unit.body : null };
    }
  }
  return null;
}
// Walk the file's history (newest→oldest, bounded) and return the version whose spec hashes to
// signedHash — the exact thing the Brief sealed. { found, commit, at, block, code } | { found:false }.
function cellAsSigned(root, file, cellId, signedHash, limit) {
  const abs = path.resolve(root, file);
  let dir, rel;
  try { ({ dir, rel } = prefixBase(abs)); } catch (_) { return { found: false, reason: 'not a git repository' }; }
  let commits;
  try { commits = git(dir, ['log', '--format=%H %cI', '-n', String(limit || 200), '--', rel]).trim().split('\n').filter(Boolean); }
  catch (_) { return { found: false, reason: 'no git history for this file' }; }
  const family = langOf(abs);
  for (const line of commits) {
    const sp = line.indexOf(' ');
    const commit = line.slice(0, sp), at = line.slice(sp + 1);
    const content = showAt(dir, rel, commit);
    if (content == null) continue;
    const norm = normalizedBlock(content, cellId);
    if (norm == null) continue;
    if (sha256(norm) === signedHash) {
      const cell = cellFromContent(content, cellId, family) || {};
      return { found: true, commit: commit.slice(0, 10), at, block: cell.block || norm, code: cell.code || null };
    }
  }
  return { found: false, reason: 'the signed version wasn’t found in this file’s git history' };
}
module.exports = { cellAsSigned, normalizedBlock, cellFromContent };
