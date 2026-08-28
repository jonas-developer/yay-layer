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
    // Comment-agnostic: strip ANY leading comment punctuation (// # -- ; % ! ' (* <!-- *)
    // and any trailing block-comment closer (*/ *) -->). This is what lets a spec
    // block live in essentially any language's comments, not just // and #.
    const line = raw
      .replace(/^\s*(?:\/\/+|#+|--+|;+|%+|!+|'+|\(\*|<!--|\*+)\s?/, '')
      .replace(/\s*(?:\*\/|\*\)|-->)\s*$/, '')
      .trim();
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

// The JS/TS declaration pattern (unchanged): function decls and const/let/var
// (arrow/function) assignments. Kept precise so JS/TS analysis behaves exactly as before.
const JS_DECL = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/;

// For the generic brace grabber: a keyword that introduces a unit by name, a
// type/container keyword, and identifier-before-`(` (a definition or a call). We
// EXCLUDE control-flow keywords from the identifier-before-`(` case so `if (`,
// `for (`, `return foo(` etc. are never mistaken for a unit.
const FN_KW = /\b(?:fn|def|defp|func|fun|function|sub)\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_]*)/;
const TYPE_KW = /\b(?:class|struct|interface|enum|record|trait|impl|contract|library|module|namespace|object|protocol|actor)\s+([A-Za-z_][A-Za-z0-9_]*)/;
const CALLISH = /([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'foreach', 'return', 'new', 'sizeof', 'typeof', 'nameof', 'await', 'throw', 'using', 'lock', 'fixed', 'with', 'do', 'else', 'when', 'unless', 'case', 'elif', 'elsif', 'match', 'require', 'import', 'package', 'use', 'and', 'or', 'not', 'in', 'is', 'as']);

// Brace-match from line `i` to the line closing its first `{` block; returns the
// end line index. `body` includes the signature so file line numbers line up.
function braceEnd(lines, i) {
  let depth = 0, started = false, end = i;
  for (let j = i; j < lines.length; j++) {
    for (const ch of lines[j]) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; }
    }
    end = j;
    if (started && depth <= 0) break;
    if (!started && j >= i + 2) break; // no block body on this decl
  }
  return end;
}

// JS/TS grabber (declaration + brace) — unchanged behaviour.
function grabJsBody(lines, fromLine) {
  for (let i = fromLine; i < Math.min(lines.length, fromLine + 6); i++) {
    const m = lines[i].match(JS_DECL);
    if (!m) continue;
    const end = braceEnd(lines, i);
    return { name: m[1] || m[2], startLine: i, body: lines.slice(i, end + 1).join('\n') };
  }
  return null;
}

// Generic C-family grabber (Go, Java, C/C++, Kotlin, Swift, PHP, Scala, Dart, C#,
// Solidity, Rust, …). Body content isn't used for non-JS checks, so precision of
// the body doesn't matter — we only need the unit's NAME and that it EXISTS.
function grabGenericBraceBody(lines, fromLine) {
  for (let i = fromLine; i < Math.min(lines.length, fromLine + 6); i++) {
    const line = lines[i];
    let name = null;
    const fk = line.match(FN_KW);
    if (fk) name = fk[1];
    if (!name) {
      CALLISH.lastIndex = 0; let m;
      while ((m = CALLISH.exec(line))) { if (!CONTROL.has(m[1])) { name = m[1]; break; } }
    }
    if (!name) { const tk = line.match(TYPE_KW); if (tk) name = tk[1]; }
    if (!name) continue;
    const end = braceEnd(lines, i);
    return { name, startLine: i, body: lines.slice(i, end + 1).join('\n') };
  }
  return null;
}

// Indentation grabber (Python): block continues while indented deeper than the
// `def`/`class` line; blank lines belong to the block.
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

// def…end grabber (Ruby, Elixir): from `def name` to the matching `end` at the
// same-or-lower indent. Best-effort — body precision isn't needed for these langs.
function grabEndBody(lines, fromLine) {
  const decl = /^(\s*)(?:def|defp)\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_?!]*)/;
  for (let i = fromLine; i < Math.min(lines.length, fromLine + 6); i++) {
    const m = lines[i].match(decl);
    if (!m) continue;
    const indent = m[1].length;
    const endRe = new RegExp('^\\s{0,' + indent + '}end\\b');
    let end = i;
    for (let j = i + 1; j < lines.length; j++) { end = j; if (endRe.test(lines[j])) break; }
    return { name: m[2], startLine: i, body: lines.slice(i, end + 1).join('\n') };
  }
  return null;
}

// Grab the body of the first unit at or after `fromLine`, by body-FAMILY. JS keeps
// its precise grabber; css/html/other reuse it (same as before, matches nothing new).
function grabUnitBody(lines, fromLine, family) {
  if (family === 'python') return grabPythonBody(lines, fromLine);
  if (family === 'ruby') return grabEndBody(lines, fromLine);
  if (family === 'brace') return grabGenericBraceBody(lines, fromLine);
  return grabJsBody(lines, fromLine);
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
      detectedUnit: (unit && unit.name) || null, // the ACTUAL name found in the code (any language) — lets verify flag a spec⇔code rename in Python/Ruby/brace files too, not just via the JS AST
      unitBody: unit ? unit.body : null,
      unitBodyStart: unit ? unit.startLine : null,
      unitFound: !!unit,
    });
    i = end;
  }
  return cells;
}

module.exports = { extractFile, parseSpec, grabUnitBody };
