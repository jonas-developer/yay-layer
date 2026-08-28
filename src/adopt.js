'use strict';
// `yay adopt` — retrofit: insert DRAFT, unsigned spec blocks above every named
// unit (function, method, arrow-prop, class method — at any nesting depth) that
// doesn't have one yet, using the AST analyzer. Falls back to a shallow top-level
// regex for files the parser can't handle (rare — severe syntax errors only).
//
// Deriving real `intent` prose from behaviour needs an LLM (roadmap); this wires
// up the structure, ids, indentation and a purity guess.

const fs = require('fs');
const path = require('path');
const { walk, repoRoot, MARK_BEGIN, langOf, commentLeadOf } = require('./util');
const { analyze, nearestUnitAfter } = require('./analyze');
const { extractFile } = require('./extract');

const JS_LIKE = /\.(js|jsx|mjs|cjs|ts|tsx)$/;
const ADOPT_FAMILIES = new Set(['js', 'brace', 'python', 'ruby']); // langs `yay adopt` can scaffold
// Purity GUESS per language family (drafts only — the human prunes; verify re-checks).
const EFFECT = /\blocalStorage\b|\bconsole\s*\.|\bfetch\s*\(|\bprocess\s*\.|\bdocument\b|\bwindow\b|\bfs\s*\.|\bMath\.random\b|\bDate\.now\b/;
const EFFECT_PY = /\bprint\s*\(|\binput\s*\(|\bopen\s*\(|\bos\s*\.|\bsys\s*\.|\bsubprocess\s*\.|\bsocket\s*\.|\brequests\s*\.|\burllib\b|\brandom\s*\.|\btime\s*\.\s*time\s*\(|\bdatetime\b.*\bnow\s*\(|^\s*global\s+[A-Za-z_]/m;
const EFFECT_RB = /\bputs\b|\bgets\b|\bFile\s*\.|\bIO\s*\.|\b\$std(out|in|err)\b|\brand\b|\bTime\s*\.\s*now\b|\bNet::|\bsystem\s*\(/;
function effectGuess(lang, body) {
  const l = String(lang || '').toLowerCase();
  const re = /^py(thon)?w?$/.test(l) ? EFFECT_PY : /^(rb|ruby|ex|exs)$/.test(l) ? EFFECT_RB : EFFECT;
  return re.test(body || '');
}
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

function draftBlock(id, name, lang, body, indent, lead) {
  const pure = effectGuess(lang, body) ? 'no' : 'yes';
  const p = indent || '';
  const cc = lead || '//'; // comment lead: '#' for Python, '//' elsewhere
  return [
    `${p}${cc}∷YAY⟨${id}⟩ v0  DERIVED — unconfirmed, not human-reviewed`,
    `${p}${cc}  unit:    ${name}`,
    `${p}${cc}  lang:    ${lang}`,
    `${p}${cc}  intent:  TODO — describe what this does in one sentence [inferred]`,
    `${p}${cc}  pure:    ${pure}`,
    `${p}${cc}  in:      TODO`,
    `${p}${cc}  out:     TODO`,
    `${p}${cc}∷YAY-END⟨${id}⟩`,
  ].join('\n');
}

// Conservative, keyword-led declaration patterns per body-FAMILY: indent in group 1,
// unit name in group 2. Same safety stance as manifest's untracked scan — anchored on
// declaration keywords or an access modifier, never control-flow, so `yay adopt` can't
// scaffold a bogus unit. Families with no safe pattern here are simply not scaffolded.
const ADOPT_PATS = {
  python: [/^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/],
  ruby: [/^(\s*)(?:def|defp)\s+(?:self\.)?([A-Za-z_][A-Za-z0-9_?!]*)/],
  brace: [
    /^(\s*)(?:pub\s+|export\s+|public\s+|private\s+|protected\s+|internal\s+|static\s+|final\s+|open\s+|override\s+|async\s+)*(?:fn|func|fun|function|sub)\s+([A-Za-z_][A-Za-z0-9_]*)/,
    /^(\s*)(?:public|private|protected|internal)(?:\s+(?:static|virtual|override|sealed|abstract|async|partial|new|readonly|unsafe|extern|final))*\s+[A-Za-z_][A-Za-z0-9_<>[\],.?]*\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:<[^>]*>)?\s*\(/,
  ],
};

// Retrofit a non-JS file: insert a DRAFT block above each un-specced unit, using the
// language's comment lead. Skips units already governed by a spec block.
function adoptFileLang(file, ids, dry, fam) {
  const pats = ADOPT_PATS[fam];
  if (!pats) return 0;
  const lead = commentLeadOf(file);
  const langStr = path.extname(file).slice(1);
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const covered = new Set();
  for (const c of extractFile(file)) { if (!c.malformed && c.unitName) covered.add(c.unitName); }
  const out = [];
  let added = 0;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const isComment = t.startsWith('//') || t.startsWith('#') || t.startsWith('/*') || t.startsWith('*');
    const prev = lines[i - 1] || '';
    if (!isComment && !/∷YAY-END|∷YAY⟨/.test(prev)) {
      for (const pat of pats) {
        const m = lines[i].match(pat);
        if (!m) continue;
        const indent = m[1] || '';
        const name = m[2];
        if (name && !covered.has(name)) {
          out.push(draftBlock(nextId(ids), name, langStr, lines.slice(i, i + 25).join('\n'), indent, lead));
          covered.add(name);
          added++;
        }
        break; // first matching pattern wins for this line
      }
    }
    out.push(lines[i]);
  }
  if (added && !dry) fs.writeFileSync(file, out.join('\n'));
  return added;
}

function adoptFile(file, ids, dry) {
  const fam = langOf(file);
  if (fam !== 'js') return adoptFileLang(file, ids, dry, fam); // brace / python / ruby
  const lang = path.extname(file).slice(1);
  const code = fs.readFileSync(file, 'utf8');
  const lines = code.split(/\r?\n/);
  const ana = analyze(code);
  if (!ana.ok) return adoptFileRegex(file, ids, dry, lines, lang); // unparseable (rare)

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

// Shallow fallback for files the parser cannot handle.
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
  const files = walk(path.resolve(targetDir || root)).filter((f) => ADOPT_FAMILIES.has(langOf(f)));
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
