'use strict';
// `yay adopt` — retrofit: scan existing code and insert DRAFT, unsigned spec
// blocks above top-level functions that don't have one yet. These are
// *descriptive* stubs the AI/human then prune to make prescriptive (see the
// Adopt-mode design in docs/). Deriving real `intent` prose from behaviour needs
// an LLM (roadmap); this MVP wires up the structure, ids, and a purity guess.

const fs = require('fs');
const path = require('path');
const { walk, repoRoot, MARK_BEGIN } = require('./util');

const TOP_FN = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?\(/;
const EFFECT = /\blocalStorage\b|\bconsole\s*\.|\bfetch\s*\(|\bprocess\s*\.|\bdocument\b|\bwindow\b|\bfs\s*\.|\bMath\.random\b|\bDate\.now\b/;

function existingIds(root) {
  const ids = new Set();
  for (const f of walk(root)) {
    const t = fs.readFileSync(f, 'utf8');
    let m; const re = new RegExp(MARK_BEGIN.source, 'g');
    while ((m = re.exec(t))) ids.add(m[1]);
  }
  return ids;
}

function nextId(ids) {
  let n = 1;
  for (;;) {
    const id = 'C-' + String(n).padStart(3, '0');
    if (!ids.has(id)) { ids.add(id); return id; }
    n++;
  }
}

function draftBlock(id, name, lang, body, indent) {
  const pure = EFFECT.test(body || '') ? 'no' : 'yes';
  const p = indent;
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
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const out = [];
  let added = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(TOP_FN);
    const prev = (lines[i - 1] || '');
    const alreadyTagged = /∷YAY-END/.test(prev) || /∷YAY⟨/.test(prev);
    if (m && !alreadyTagged) {
      const name = m[1] || m[2];
      const indent = (lines[i].match(/^\s*/) || [''])[0];
      // peek body for purity guess
      const body = lines.slice(i, i + 25).join('\n');
      out.push(draftBlock(nextId(ids), name, lang, body, indent));
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
  const files = walk(path.resolve(targetDir || root)).filter((f) => /\.(js|jsx|mjs|cjs|ts|tsx)$/.test(f));
  const report = [];
  let total = 0;
  for (const f of files) {
    const n = adoptFile(f, ids, dry);
    if (n) { report.push({ file: path.relative(root, f), added: n }); total += n; }
  }
  return { total, report, dry };
}

module.exports = { adopt };
