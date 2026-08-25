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

// The approval command depends on how THIS project signs (chosen at `yay init`):
// a phone-signed project must tell the AI to have the human approve on their phone.
// `yay sign` auto-uses the project's established method, so the command is always
// just `yay sign` — the note explains where the signature actually happens.
function signGuidance(method) {
  if (method === 'phone') {
    return { cmd: '`yay sign`', note: 'This project signs on a **phone**: `yay sign` automatically opens the phone approval (prints a QR/URL) and the signing key never touches this machine. You cannot sign — only the human’s phone can.' };
  }
  if (method === 'local') {
    return { cmd: '`yay sign`', note: 'This project signs with a **local key**: `yay sign` prompts for the human’s passphrase.' };
  }
  return { cmd: '`yay sign`', note: '`yay sign` uses whichever signing method this project is set up with.' };
}

function header(method) {
  const g = signGuidance(method);
  const waits = method === 'phone';
  return [
    '# This project is built under YayLayer',
    '',
    'Follow the YayLayer Constitution below **exactly, from the very first file**.',
    '',
    '**The loop for every observable change:**',
    '1. Write/update the spec block(s) FIRST — no implementation code yet.',
    '2. Draft a one-paragraph **Mission** — what the human asked you to build, in your own',
    '   fine-tuned words (not their verbatim text) — and present the change-set headed by it,',
    '   with the colour you expect each Cell to earn. Then request approval by running',
    `   \`yay sign --mission "<that paragraph>"\` yourself. ${waits ? 'It BLOCKS until the human approves on their phone, where they can EDIT the mission before signing (allow a few minutes; use a long command timeout).' : 'The human enters their passphrase to sign.'}`,
    `3. **The moment ${g.cmd} returns a completed signature, continue on your own** — implement the code`,
    '   to match the signed spec, then run `yay verify` and report the result. Do NOT stop to ask',
    '   "should I implement now?" — a returned signature IS the go-ahead.',
    '4. When `yay verify` passes, COMMIT the code and `.yaylayer/` together in ONE commit',
    '   (e.g. `git add -A && git commit -m "C-xxx: <intent> (signed)"`). This makes the seal durable',
    '   (the CI gate reads committed state) and gives the next spec change a clean before/after diff.',
    '   Do NOT `git push` unless the human asks.',
    '5. If approval fails, is declined, or times out, STOP and ask — never implement unapproved specs.',
    '',
    '**When the human adds new requests before signing the pending mission:** decide by coherence, and keep one mission = one coherent intent.',
    '- If the additions BELONG to the same mission (logically part of the same intent), SUGGEST folding them in: cancel the pending approval, add the new spec(s), and re-present ONE updated mission covering everything, then sign.',
    '- If they are a DIFFERENT concern, ask the human to SIGN (or decline) the current mission FIRST, then start the new concern as its own separate mission.',
    'Never mix unrelated concerns into one mission, and never leave a stale pending approval hanging.',
    '',
    '**Specs are never perfect — treat `yay verify` as a spec-STRENGTHENING loop, not just a pass/fail gate.**',
    'When it flags a Cell as weak — `ensures` not machine-verified (prose), inputs (`in:`) under-declared, a',
    'dangling reference, a unit-name mismatch, or a prover/adversary counterexample — do NOT leave it green.',
    'Propose a STRONGER spec (a checkable `ensures` as a boolean JS expression over `out` and the inputs;',
    'tighter `in:` domains; the corrected clause), present it, get it RE-SIGNED, then reconcile the code.',
    'For SIDE-EFFECTING code (canvas/DOM/IO), declare its effect surface with `records: <param>` and write',
    '`ensures` over the recorded trace — `calls(name)` (arg-arrays), `sets(name)` (assigned values),',
    '`didCall(name)`, `didSet(name, value)` — so effects become machine-checkable instead of unprovable.',
    'A signed-but-unproven Cell is a to-do, not a finish line. Run `yay adversary` to hunt weak spots.',
    '',
    `Never sign on the human's behalf${waits ? ' (only their phone holds the key — you cannot)' : ''}. ${g.note}`.trim(),
    '',
    '---',
    '',
    '',
  ].join('\n');
}

function constitutionText() {
  return fs.readFileSync(path.join(__dirname, '..', 'CONSTITUTION.md'), 'utf8').trim();
}
function block(method) {
  return `${BEGIN}\n${header(method)}${constitutionText()}\n${END}\n`;
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
function writeConstitution(root, keys, method) {
  const blk = block(method);
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
