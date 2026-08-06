'use strict';
// Build the manifest: scan a tree, extract every Cell, hash each spec.
// The manifest is the map `id -> { specHash, file, spec, ... }` that verify,
// sign, and map all read from. It is derived fresh from the real files every
// time — never trusted from a stored copy.

const fs = require('fs');
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
        unitBodyStart: cell.unitBodyStart,
        unitFound: cell.unitFound,
        contains: parseList(cell.spec.contains),
        feeds: parseList(cell.spec.feeds),
      };
    }
  }
  const coveredNames = new Set(Object.values(cells).map((cell) => cell.unitName).filter(Boolean));
  const untracked = findUntracked(root, files, coveredNames);
  return { root, cells, problems, untracked };
}

// A top-level function / arrow / function-expression. Used to spot code that has
// NO YayLayer spec above it → PINK (untracked, the "never even described" state).
const COVER_FN = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/;
const JS_LIKE = /\.(js|jsx|mjs|cjs|ts|tsx)$/;

function findUntracked(root, files, coveredNames) {
  const out = [];
  for (const file of files) {
    if (!JS_LIKE.test(file)) continue; // MVP: coverage detection is JS/TS only
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch (_) { continue; }
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(COVER_FN);
      if (!m) continue;
      const name = m[1] || m[2];
      if (!name || coveredNames.has(name)) continue;
      if (/∷YAY-END|∷YAY⟨/.test(lines[i - 1] || '')) continue; // sits directly under a spec block
      out.push({ name, file: path.relative(root, file), line: i + 1, lang: path.extname(file).slice(1) });
    }
  }
  return out;
}

function parseList(v) {
  if (!v) return [];
  return v.replace(/[[\]]/g, '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).filter((s) => s !== '—' && s !== '-');
}

module.exports = { buildManifest, parseList };
