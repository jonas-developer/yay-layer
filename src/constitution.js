'use strict';
// Write the YayLayer Constitution into the instruction file that a given AI coding
// harness auto-reads, so a fresh session in this repo follows YayLayer from the
// very first file. The Constitution text is the single source (../CONSTITUTION.md);
// we just place it where each tool looks.
//
// Writes are marker-wrapped and idempotent: the block between YAYLAYER:BEGIN/END is
// managed by `yay` (re-running updates just that block); anything outside it is the
// user's and is preserved.

const fs = require('fs');
const path = require('path');

const BEGIN = '<!-- YAYLAYER:BEGIN (managed by `yay` — re-run `yay constitution` to update; edits inside are overwritten) -->';
const END = '<!-- YAYLAYER:END -->';

// File-based, auto-loaded instruction conventions per harness. `note` flags how
// standard each is — conventions move fast, so verify against your tool's docs.
const HARNESSES = [
  { key: 'claude', label: 'Claude Code', path: 'CLAUDE.md', note: 'auto-loaded at repo root' },
  { key: 'agents', label: 'AGENTS.md (Codex CLI + cross-tool standard)', path: 'AGENTS.md', note: 'read by OpenAI Codex CLI and a growing set of tools' },
  { key: 'copilot', label: 'GitHub Copilot', path: '.github/copilot-instructions.md', note: 'repo custom instructions' },
  { key: 'cursor', label: 'Cursor', path: '.cursorrules', note: 'legacy single-file (modern: .cursor/rules/*.mdc)' },
  { key: 'windsurf', label: 'Windsurf', path: '.windsurfrules', note: 'root rules file' },
  { key: 'cline', label: 'Cline', path: '.clinerules', note: 'root rules file' },
  { key: 'gemini', label: 'Gemini CLI', path: 'GEMINI.md', note: 'auto-loaded at repo root' },
  { key: 'generic', label: 'CONSTITUTION.md (wire into any tool yourself)', path: 'CONSTITUTION.md', note: 'plain copy; point your tool at it' },
];

const HEADER = [
  '# This project is built under YayLayer',
  '',
  'Follow the YayLayer Constitution below **exactly, from the very first file**:',
  'write the spec first, present the change-set with the colour you expect each',
  'Cell to earn, then STOP and wait for the human to approve it with `yay sign`',
  'before writing any implementation code. After it is signed, write code to match,',
  "then run `yay verify` and report the result. Never sign on the human's behalf.",
  '',
  '---',
  '',
  '',
].join('\n');

function constitutionText() {
  return fs.readFileSync(path.join(__dirname, '..', 'CONSTITUTION.md'), 'utf8').trim();
}
function block() {
  return `${BEGIN}\n${HEADER}${constitutionText()}\n${END}\n`;
}

function mergeInto(existing, blk) {
  const i = existing.indexOf(BEGIN);
  const j = existing.indexOf(END);
  if (i !== -1 && j !== -1 && j > i) {
    return existing.slice(0, i) + blk.trimEnd() + existing.slice(j + END.length);
  }
  const sep = existing.endsWith('\n') ? '\n' : '\n\n';
  return existing + sep + blk; // append, preserving the user's own content
}

function harnessByKey(key) { return HARNESSES.find((h) => h.key === key); }
function resolveKeys(spec) {
  if (!spec || spec === 'all') return HARNESSES.map((h) => h.key);
  return String(spec).split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}

// Write/merge the constitution into the chosen harness files. Returns a report
// [{ key, label, path, action:'created'|'updated'|'appended'|'unchanged' } | { key, error }].
function writeConstitution(root, keys) {
  const blk = block();
  const report = [];
  for (const key of keys) {
    const h = harnessByKey(key);
    if (!h) { report.push({ key, error: 'unknown harness' }); continue; }
    const abs = path.join(root, h.path);
    let action;
    if (fs.existsSync(abs)) {
      const before = fs.readFileSync(abs, 'utf8');
      const after = mergeInto(before, blk);
      if (after === before) action = 'unchanged';
      else { fs.writeFileSync(abs, after); action = before.includes(BEGIN) ? 'updated' : 'appended'; }
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, blk);
      action = 'created';
    }
    report.push({ key, label: h.label, path: h.path, action });
  }
  return report;
}

module.exports = { HARNESSES, writeConstitution, resolveKeys, harnessByKey };
