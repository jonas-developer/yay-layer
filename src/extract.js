'use strict';
// Find YayLayer spec blocks in source, parse their fields, and grab the code
// body of the unit they sit above (so verify can do static code⇔spec checks).

const fs = require('fs');
const { MARK_BEGIN, MARK_END, langOf } = require('./util');

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

// Per-language declaration patterns for the lightweight body grabber. The name is
// captured in whichever group matches. Brace-family languages (JS/TS, C#, Solidity,
// Rust) share the brace matcher below; Python uses the indentation grabber. This is
// deliberately shallow — the full per-language AST adapter is the roadmap milestone.
const DECL = {
  js: /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/,
  csharp: /(?:public|private|protected|internal|static|virtual|override|sealed|abstract|partial|async|new|readonly|unsafe|extern|\s)*?[A-Za-z_][A-Za-z0-9_<>[\],.?]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(|(?:class|struct|interface|enum|record)\s+([A-Za-z_][A-Za-z0-9_]*)/,
  solidity: /function\s+([A-Za-z_][A-Za-z0-9_]*)|(?:contract|library|interface)\s+([A-Za-z_][A-Za-z0-9_]*)/,
  rust: /(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)|(?:struct|enum|trait|impl|mod)\s+([A-Za-z_][A-Za-z0-9_]*)/,
};

// Brace-matched body (C-family: JS/TS, C#, Solidity, Rust). Returns { name, body }.
function grabBraceBody(lines, fromLine, declRe) {
  for (let i = fromLine; i < Math.min(lines.length, fromLine + 6); i++) {
    const m = lines[i].match(declRe);
    if (!m) continue;
    const name = m[1] || m[2] || m[3];
    // brace-match from the declaration line to the matching close; body includes
    // the signature so line numbers line up with the file. `startLine` is 0-based.
    let depth = 0, started = false, end = i;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; started = true; }
        else if (ch === '}') { depth--; }
      }
      end = j;
      if (started && depth <= 0) break;
      if (!started && j >= i + 2) break; // no block body (e.g. arrow one-liner)
    }
    return { name, startLine: i, body: lines.slice(i, end + 1).join('\n') };
  }
  return null;
}

// Indentation-matched body (Python): the block continues while indented deeper
// than the `def`/`class` line; blank lines belong to the block.
function grabPythonBody(lines, fromLine) {
  const decl = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)|^(\s*)class\s+([A-Za-z_][A-Za-z0-9_]*)/;
  for (let i = fromLine; i < Math.min(lines.length, fromLine + 6); i++) {
    const m = lines[i].match(decl);
    if (!m) continue;
    const indent = (m[1] !== undefined ? m[1] : m[3]).length;
    const name = m[2] || m[4];
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (!lines[j].trim()) { end = j; continue; } // blank line → still inside the block
      const ind = (lines[j].match(/^(\s*)/)[1] || '').length;
      if (ind <= indent) break;
      end = j;
    }
    return { name, startLine: i, body: lines.slice(i, end + 1).join('\n') };
  }
  return null;
}

// Grab the body of the first unit declared at or after `fromLine`. `lang` selects
// the strategy; unknown/JS langs fall back to the JS declaration + brace matcher,
// so JS/TS (and css/html) behave exactly as before.
function grabUnitBody(lines, fromLine, lang) {
  if (lang === 'python') return grabPythonBody(lines, fromLine);
  return grabBraceBody(lines, fromLine, DECL[lang] || DECL.js);
}

// Extract every Cell from one file.
function extractFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  const lang = langOf(file);
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
    const unit = grabUnitBody(lines, end + 1, lang);
    cells.push({
      id, file, startLine: i + 1, endLine: end + 1,
      normalized, spec,
      unitName: spec.unit || (unit && unit.name) || null,
      unitBody: unit ? unit.body : null,
      unitBodyStart: unit ? unit.startLine : null,
      unitFound: !!unit,
    });
    i = end;
  }
  return cells;
}

module.exports = { extractFile, parseSpec, grabUnitBody };
