'use strict';
// Build the manifest: scan a tree, extract every Cell (marker blocks), and use
// the AST analyzer to (a) attach the exact unit a Cell governs and (b) find
// UNTRACKED units — named code with no spec block → PINK. Falls back to a shallow
// regex for files the parser can't handle (e.g. TypeScript) so nothing is silently
// dropped.

const fs = require('fs');
const path = require('path');
const { walk, repoRoot } = require('./util');
const { sha256 } = require('./crypto');
const { extractFile } = require('./extract');
const { analyze, nearestUnitAfter } = require('./analyze');

const JS_LIKE = /\.(js|jsx|mjs|cjs|ts|tsx)$/;

// Fallback (parse failed): top-level `function name(` / `const name = (` only.
const COVER_FN = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/;

function untrackedRegex(file, rel, coveredNames, out) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch (_) { return; }
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(COVER_FN);
    if (!m) continue;
    const name = m[1] || m[2];
    if (!name || coveredNames.has(name)) continue;
    if (/∷YAY-END|∷YAY⟨/.test(lines[i - 1] || '')) continue;
    out.push({ name, file: rel, line: i + 1, kind: 'function', lang: path.extname(file).slice(1) });
  }
}

const baseName = (f) => String(f).split('/').pop();
// A module is named by its exposed namespace (global.X / export / module.exports),
// else by its filename. Works for ES modules, CommonJS, UMD/IIFE, and plain scripts.
function moduleNameOf(ana, rel) { return (ana && ana.namespace && ana.namespace.name) || baseName(rel); }
// A unit's sub-group: its class/object container, else Public API vs Internal.
function groupOf(unit, ana) {
  if (unit.container) return unit.container;
  const short = String(unit.name).split('.').pop();
  return (ana && ana.namespace && ana.namespace.publicNames && ana.namespace.publicNames.has(short)) ? 'Public API' : 'Internal';
}

function buildManifest(targetDir) {
  const root = repoRoot(targetDir);
  const files = walk(path.resolve(targetDir || root));
  const cells = {};
  const problems = [];
  const perFile = {};

  for (const file of files) {
    const rel = path.relative(root, file);
    let code = '';
    try { code = fs.readFileSync(file, 'utf8'); } catch (_) {}
    const codeLines = code.split(/\r?\n/);
    const ana = JS_LIKE.test(file) ? analyze(code) : { ok: false, units: [], loose: [] };
    const covered = new Set();

    let found;
    try { found = extractFile(file); } catch (e) { problems.push({ file: rel, error: e.message }); found = []; }
    for (const cell of found) {
      if (cell.malformed) { problems.push({ id: cell.id, file: rel, error: cell.malformed }); continue; }
      if (cells[cell.id]) { problems.push({ id: cell.id, file: rel, error: `duplicate Cell id (also in ${cells[cell.id].file})` }); continue; }
      let { unitName, unitBody, unitBodyStart, unitFound } = cell;
      let cellModule = moduleNameOf(ana, rel);
      let cellGroup = cell.spec.contains ? 'Modules' : 'Internal';
      if (ana.ok && !cell.spec.contains) {
        const u = nearestUnitAfter(ana.units, cell.endLine);
        if (u) {
          unitName = cell.spec.unit || u.name;
          unitBody = codeLines.slice(u.startLine - 1, u.endLine).join('\n');
          unitBodyStart = u.startLine - 1;
          unitFound = true;
          covered.add(u.startLine);
          cellGroup = groupOf(u, ana);
        }
      }
      cells[cell.id] = {
        id: cell.id, file: rel, line: cell.startLine,
        lang: (cell.spec.lang || path.extname(file).slice(1) || 'unknown').split(/[ ·]/)[0],
        spec: cell.spec, specBlock: cell.normalized, specHash: sha256(cell.normalized),
        unitName, unitBody, unitBodyStart, unitFound, module: cellModule, group: cellGroup,
        contains: parseList(cell.spec.contains), feeds: parseList(cell.spec.feeds),
      };
    }
    perFile[rel] = { file, ana, covered };
  }

  // UNTRACKED: AST units with no covering Cell + top-level imperative ("loose") code.
  const coveredNames = new Set(Object.values(cells).map((c) => c.unitName).filter(Boolean));
  const untracked = [];
  for (const rel of Object.keys(perFile)) {
    const { file, ana, covered } = perFile[rel];
    if (ana.ok) {
      for (const u of ana.units) {
        if (covered.has(u.startLine)) continue;
        untracked.push({ name: u.name, file: rel, line: u.startLine, kind: u.kind, lang: path.extname(file).slice(1), module: moduleNameOf(ana, rel), group: groupOf(u, ana) });
      }
      if (ana.loose.length) {
        untracked.push({ name: 'module-level code', file: rel, line: ana.loose[0], kind: 'loose', count: ana.loose.length, lang: path.extname(file).slice(1), module: moduleNameOf(ana, rel), group: 'module-level' });
      }
    } else if (JS_LIKE.test(file)) {
      untrackedRegex(file, rel, coveredNames, untracked);
    }
  }

  // Module-level flow (file → file), derived from the call graph: file A feeds
  // into file B if A calls a unit that B defines. Auto-structure, no annotations.
  const defs = {}, callsOf = {};
  for (const rel of Object.keys(perFile)) {
    const { ana } = perFile[rel];
    defs[rel] = new Set(ana.ok ? ana.units.map((u) => String(u.name).split('.').pop()) : []);
    callsOf[rel] = new Set(ana.ok ? ana.calls : []);
  }
  const edgeSet = new Set();
  for (const a of Object.keys(callsOf)) {
    for (const name of callsOf[a]) {
      for (const b of Object.keys(defs)) {
        if (b === a || !defs[b].has(name)) continue;
        if (defs[a].has(name)) continue; // A defines this name itself → not a cross-module call
        const ma = moduleNameOf(perFile[a].ana, a), mb = moduleNameOf(perFile[b].ana, b);
        if (ma !== mb) edgeSet.add(ma + ' >> ' + mb);
      }
    }
  }
  const moduleEdges = [...edgeSet].map((s) => s.split(' >> '));

  return { root, cells, problems, untracked, moduleEdges };
}

function parseList(v) {
  if (!v) return [];
  return v.replace(/[[\]]/g, '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean).filter((s) => s !== '—' && s !== '-');
}

module.exports = { buildManifest, parseList };
