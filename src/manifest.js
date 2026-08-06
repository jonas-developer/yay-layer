'use strict';
// Build the manifest: scan a tree, extract every Cell, hash each spec.
// The manifest is the map `id -> { specHash, file, spec, ... }` that verify,
// sign, and map all read from. It is derived fresh from the real files every
// time — never trusted from a stored copy.

const path = require('path');
const { walk, repoRoot } = require('./util');
const { sha256 } = require('./crypto');
const { extractFile } = require('./extract');

function buildManifest(targetDir) {
  const root = repoRoot(targetDir);
  const files = walk(path.resolve(targetDir || root));
  const cells = {};
  const problems = [];
  for (const file of files) {
    let found;
    try { found = extractFile(file); } catch (e) { problems.push({ file, error: e.message }); continue; }
    for (const cell of found) {
      const rel = path.relative(root, cell.file);
      if (cell.malformed) { problems.push({ id: cell.id, file: rel, error: cell.malformed }); continue; }
      if (cells[cell.id]) {
        problems.push({ id: cell.id, file: rel, error: `duplicate Cell id (also in ${cells[cell.id].file})` });
        continue;
      }
      cells[cell.id] = {
        id: cell.id,
        file: rel,
        line: cell.startLine,
        lang: (cell.spec.lang || path.extname(file).slice(1) || 'unknown').split(/[ ·]/)[0],
        spec: cell.spec,
        specBlock: cell.normalized,
        specHash: sha256(cell.normalized),
        unitName: cell.unitName,
        unitBody: cell.unitBody,
        unitFound: cell.unitFound,
        contains: parseList(cell.spec.contains),
        feeds: parseList(cell.spec.feeds),
      };
    }
  }
  return { root, cells, problems };
}

function parseList(v) {
  if (!v) return [];
  return v.replace(/[[\]]/g, '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).filter((s) => s !== '—' && s !== '-');
}

module.exports = { buildManifest, parseList };
