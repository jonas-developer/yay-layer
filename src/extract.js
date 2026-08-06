'use strict';
// Find YayLayer spec blocks in source, parse their fields, and grab the code
// body of the unit they sit above (so verify can do static code⇔spec checks).

const fs = require('fs');
const { MARK_BEGIN, MARK_END } = require('./util');

// Parse the "key: value" lines inside a spec block. Continuation lines (comment
// lines with no "key:") append to the previous field.
function parseSpec(blockLines) {
  const fields = {};
  let last = null;
  for (const raw of blockLines) {
    const line = raw.replace(/^\s*\/\/+/, '').replace(/^\s*#/, '').trim(); // strip // or # comment lead
    if (!line || line.startsWith('∷YAY')) continue;
    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (m) {
      last = m[1].toLowerCase();
      fields[last] = m[2].trim();
    } else if (last) {
      fields[last] += ' ' + line;
    }
  }
  return fields;
}

// Grab the body of the first function/const declared at or after `fromLine`,
// by brace matching. Returns { name, body } or null. Deliberately lightweight —
// the full AST adapter (roadmap) replaces this with a real parser.
function grabUnitBody(lines, fromLine) {
  const decl = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/;
  for (let i = fromLine; i < Math.min(lines.length, fromLine + 6); i++) {
    const m = lines[i].match(decl);
    if (!m) continue;
    const name = m[1] || m[2];
    // find first "{" from here, then brace-match
    let depth = 0, started = false, body = '';
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; started = true; }
        if (started) body += ch;
        if (ch === '}') { depth--; if (depth === 0) return { name, body }; }
      }
      if (started) body += '\n';
    }
    return { name, body };
  }
  return null;
}

// Extract every Cell from one file.
function extractFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const cells = [];
  for (let i = 0; i < lines.length; i++) {
    const b = lines[i].match(MARK_BEGIN);
    if (!b) continue;
    const id = b[1];
    const block = [lines[i]];
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      block.push(lines[j]);
      const e = lines[j].match(MARK_END);
      if (e) { end = j; break; }
    }
    if (end === -1) {
      cells.push({ id, file, startLine: i + 1, endLine: lines.length, malformed: 'missing ∷YAY-END marker' });
      continue;
    }
    // normalized spec text (markers + inner lines, trailing ws stripped) → hashed later
    const normalized = block.map((l) => l.replace(/\s+$/, '')).join('\n');
    const spec = parseSpec(block);
    const unit = grabUnitBody(lines, end + 1);
    cells.push({
      id, file, startLine: i + 1, endLine: end + 1,
      normalized, spec,
      unitName: spec.unit || (unit && unit.name) || null,
      unitBody: unit ? unit.body : null,
      unitFound: !!unit,
    });
    i = end;
  }
  return cells;
}

module.exports = { extractFile, parseSpec, grabUnitBody };
