'use strict';
// Run the PROJECT's own test suite (not the per-Cell prover) so the dashboard and
// the gate can show a full picture: Cell colours + prover + your real tests.
// Best-effort + bounded; command resolution prefers an explicit setting.

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// The command to run: --test flag > config.test > package.json "test" script.
function resolveTestCmd(root, config, flags) {
  if (flags && flags.test && flags.test !== true) return String(flags.test);
  if (config && config.test) return String(config.test);
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const t = pkg.scripts && pkg.scripts.test;
    if (t && !/no test specified/i.test(t)) return 'npm test'; // real test script present
  } catch (_) {}
  return null;
}

// Run `cmd` in the repo root, capturing combined output + exit code (bounded).
function runTests(root, cmd, timeoutMs) {
  return new Promise((resolve) => {
    if (!cmd) return resolve({ configured: false, cmd: null, ok: false, code: null, output: 'No test command configured. Add a "test" script to package.json, set "test" in .yaylayer/config.json, or pass --test "…".', ms: 0 });
    const started = Date.now();
    cp.exec(cmd, { cwd: root, timeout: timeoutMs || 300000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const combined = ((stdout || '') + (stderr || ''));
      resolve({
        configured: true, cmd,
        ok: !err,
        code: err ? (err.code == null ? 1 : err.code) : 0,
        timedOut: !!(err && err.killed),
        output: combined.slice(-20000) || (err ? String(err.message) : ''),
        ms: Date.now() - started,
      });
    });
  });
}

module.exports = { resolveTestCmd, runTests };
