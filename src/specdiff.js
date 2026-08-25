'use strict';
// Compute what changed in a Cell's SPEC versus its last committed (HEAD) version,
// so the phone can show a real diff before the human approves. Read-only + best-
// effort: outside a git repo, or for a brand-new/unchanged spec, it returns null.

const path = require('path');
const { MARK_BEGIN, MARK_END } = require('./util');

// Readable spec-field lines for a cell from raw file content (strips the // or # lead).
function specLinesFromContent(content, cellId) {
  const lines = String(content).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const b = lines[i].match(MARK_BEGIN);
    if (b && b[1] === cellId) {
      const out = [];
      for (let j = i + 1; j < lines.length; j++) {
        if (MARK_END.test(lines[j])) return out;
        out.push(lines[j].replace(/^\s*\/\/+\s?/, '').replace(/^\s*#\s?/, '').replace(/\s+$/, ''));
      }
      return out;
    }
  }
  return null; // cell not present in this version (i.e. it's new)
}

// Same, from the manifest cell's `normalized` block (markers + inner lines).
function normalizedToSpecLines(normalized) {
  return String(normalized || '').split('\n')
    .filter((l) => !MARK_BEGIN.test(l) && !MARK_END.test(l))
    .map((l) => l.replace(/^\s*\/\/+\s?/, '').replace(/^\s*#\s?/, '').replace(/\s+$/, ''));
}

// The committed (HEAD) content of a file, or null if not in git / not tracked.
// Uses git's own `--show-prefix` (repo-root → file's dir) instead of path.relative,
// which would break when the toplevel resolves symlinks (e.g. macOS /var → /private/var).
function gitHeadContent(root, absFile) {
  try {
    const cp = require('child_process'), opt = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
    const dir = path.dirname(absFile), base = path.basename(absFile);
    const prefix = cp.execFileSync('git', ['-C', dir, 'rev-parse', '--show-prefix'], opt).trim();
    return cp.execFileSync('git', ['-C', dir, 'show', 'HEAD:' + prefix + base], opt);
  } catch (_) { return null; }
}

// Minimal LCS line diff → [{t:' '|'-'|'+', text}]; null if identical or no previous.
function lineDiff(oldL, newL) {
  if (!oldL) return null;
  const a = oldL, b = newL, n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < n && j < m) { if (a[i] === b[j]) { out.push({ t: ' ', text: a[i] }); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', text: a[i++] }); else out.push({ t: '+', text: b[j++] }); }
  while (i < n) out.push({ t: '-', text: a[i++] });
  while (j < m) out.push({ t: '+', text: b[j++] });
  return out.some((d) => d.t !== ' ') ? out : null;
}

// The change to a cell's spec vs its last committed version (for phone review).
function specDiffForCell(root, cell) {
  try {
    const head = gitHeadContent(root, path.resolve(root, cell.file));
    if (head == null) return null;
    // manifest cells carry the block as `specBlock` (extract calls it `normalized`).
    const current = normalizedToSpecLines(cell.specBlock || cell.normalized);
    return lineDiff(specLinesFromContent(head, cell.id), current);
  } catch (_) { return null; }
}

module.exports = { specLinesFromContent, normalizedToSpecLines, gitHeadContent, lineDiff, specDiffForCell };
