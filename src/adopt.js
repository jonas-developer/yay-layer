'use strict';
// `yay adopt` — retrofit: insert DRAFT, unsigned spec blocks above every named
// unit (function, method, arrow-prop, class method — at any nesting depth) that
// doesn't have one yet, using the AST analyzer. Falls back to a shallow top-level
// regex for files the parser can't handle (e.g. TypeScript).
//
// Deriving real `intent` prose from behaviour needs an LLM (roadmap); this wires
// up the structure, ids, indentation and a purity guess.

const fs = require('fs');
const path = require('path');
const { walk, repoRoot, MARK_BEGIN } = require('./util');
const { analyze, nearestUnitAfter } = require('./analyze');
const { extractFile } = require('./extract');

const JS_LIKE = /\.(js|jsx|mjs|cjs|ts|tsx)$/;
const EFFECT = /\blocalStorage\b|\bconsole\s*\.|\bfetch\s*\(|\bprocess\s*\.|\bdocument\b|\bwindow\b|\bfs\s*\.|\bMath\.random\b|\bDate\.now\b/;
const TOP_FN = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/;

function existingIds(root) {
  const ids = new Set();
  for (const f of walk(root)) {
    let t; try { t = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    let m; const re = new RegExp(MARK_BEGIN.source, 'g');
    while ((m = re.exec(t))) ids.add(m[1]);
  }
  return ids;
}
function nextId(ids) {
  let n = 1;
  for (;;) { const id = 'C-' + String(n).padStart(3, '0'); if (!ids.has(id)) { ids.add(id); return id; } n++; }
}

function draftBlock(id, name, lang, body, indent) {
  const pure = EFFECT.test(body || '') ? 'no' : 'yes';
  const p = indent || '';
  return [
    `${p}//∷YAY⟨${id}⟩ v0  DERIVED — unconfirmed, not human-reviewed`,
    `${p}//  unit:    ${name}`,
    `${p}//  lang:    ${lang}`,
    `${p}//  intent:  TODO — describe what this does in one sentence [inferred]`,
    `${p}//  pure:    ${pure}`,
    `${p}//  in:      TODO`,
    `${p}//  out:     TODO`,
    `${p}//∷YAY-END⟨${id}⟩`,
  ].join('\n');
}

function adoptFile(file, ids, dry) {
  const lang = path.extname(file).slice(1);
  const code = fs.readFileSync(file, 'utf8');
  const lines = code.split(/\r?\n/);
  const ana = analyze(code);
  if (!ana.ok) return adoptFileRegex(file, ids, dry, lines, lang); // TS / unparseable

  // Units already governed by an existing Cell (skip those).
  const covered = new Set();
  for (const c of extractFile(file)) {
    if (c.malformed) continue;
    const u = nearestUnitAfter(ana.units, c.endLine);
    if (u) covered.add(u.startLine);
  }

  const inserts = [];
  for (const u of ana.units) {
    if (covered.has(u.startLine)) continue;
    const indent = (lines[u.startLine - 1].match(/^\s*/) || [''])[0];
    const body = lines.slice(u.startLine - 1, u.endLine).join('\n');
    inserts.push({ line: u.startLine, text: draftBlock(nextId(ids), u.name, lang, body, indent) });
  }
  if (!inserts.length) return 0;
  if (!dry) {
    inserts.sort((a, b) => b.line - a.line); // bottom-to-top keeps line numbers valid
    const out = lines.slice();
    for (const ins of inserts) out.splice(ins.line - 1, 0, ins.text);
    fs.writeFileSync(file, out.join('\n'));
  }
  return inserts.length;
}

// Shallow fallback for files acorn can't parse.
function adoptFileRegex(file, ids, dry, lines, lang) {
  const out = [];
  let added = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TOP_FN);
    const prev = lines[i - 1] || '';
    if (m && !/∷YAY-END|∷YAY⟨/.test(prev)) {
      const name = m[1] || m[2];
      const indent = (lines[i].match(/^\s*/) || [''])[0];
      out.push(draftBlock(nextId(ids), name, lang, lines.slice(i, i + 25).join('\n'), indent));
      added++;
    }
    out.push(lines[i]);
  }
  if (added && !dry) fs.writeFileSync(file, out.join('\n'));
  return added;
}

function adopt(targetDir, { dry = false } = {}) {
  const root = repoRoot(targetDir);
  const ids = existingIds(root);
  const files = walk(path.resolve(targetDir || root)).filter((f) => JS_LIKE.test(f));
  const report = [];
  let total = 0;
  for (const f of files) {
    let n = 0;
    try { n = adoptFile(f, ids, dry); } catch (_) { continue; }
    if (n) { report.push({ file: path.relative(root, f), added: n }); total += n; }
  }
  return { total, report, dry };
}

module.exports = { adopt };
