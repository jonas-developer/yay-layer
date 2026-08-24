#!/usr/bin/env node
'use strict';
// yay — the YayLayer command line.
//   yay init            set up YayLayer in this repo
//   yay keygen --name   create your signing key (encrypted keystore + public key in the roster)
//   yay adopt [path]    scaffold draft specs over existing code
//   yay sign [--all]    sign (approve) the current specs   [local stand-in for the phone signer]
//   yay verify          the gate: paint every Cell green/yellow/red/unsigned
//   yay map [-o file]   write the HTML flowchart (defaults to yay-layer-map.html)
//   yay status          one-line summary

const fs = require('fs');
const path = require('path');

const U = require('../src/util');
const C = require('../src/crypto');
const { buildManifest } = require('../src/manifest');
const { verifyManifest } = require('../src/verify');
const { renderMap } = require('../src/map');
const { adopt } = require('../src/adopt');
const { HARNESSES, writeConstitution, resolveKeys } = require('../src/constitution');
const gate = require('../src/gate');
const phone = require('../src/phone');

function args(argv) {
  const flags = {}; const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    let key = null;
    if (a.startsWith('--')) key = a.slice(2);
    else if (/^-[A-Za-z]$/.test(a)) key = a.slice(1); // short flags like -o
    if (key !== null) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) flags[key] = argv[++i];
      else flags[key] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

// Read a hidden passphrase from a terminal (typing is not echoed).
function promptHidden(q) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(q);
    stdin.resume();
    stdin.setEncoding('utf8');
    if (stdin.isTTY) stdin.setRawMode(true);
    let input = '';
    const finish = (val) => {
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.removeListener('data', onData);
      stdin.pause();
      process.stdout.write('\n');
      resolve(val);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        const code = ch.charCodeAt(0);
        if (ch === '\n' || ch === '\r' || code === 4) return finish(input); // Enter / Ctrl-D
        if (code === 3) { process.stdout.write('\n'); process.exit(1); }     // Ctrl-C
        if (code === 127 || code === 8) { input = input.slice(0, -1); continue; } // backspace
        input += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// Read one plain line (for piped input, and visible interactive prompts).
function promptLine() {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let data = '';
    stdin.setEncoding('utf8');
    stdin.resume();
    const onData = (c) => {
      data += c;
      const nl = data.indexOf('\n');
      if (nl >= 0) { stdin.removeListener('data', onData); stdin.pause(); resolve(data.slice(0, nl).replace(/\r$/, '')); }
    };
    stdin.on('data', onData);
  });
}

// Ask a question on a TTY and read a visible line back.
async function ask(prompt) {
  process.stdout.write(prompt);
  return (await promptLine()).trim();
}

async function getPassphrase(flags, purpose) {
  if (flags.passphrase && flags.passphrase !== true) return flags.passphrase;
  if (process.env.YAY_PASSPHRASE) return process.env.YAY_PASSPHRASE;
  if (process.stdin.isTTY) {
    console.log(U.c.accent('▸ ') + (purpose || 'Enter your passphrase') +
      U.c.dim('   (typing is hidden — type it, then press Enter)'));
    return promptHidden('  passphrase: ');
  }
  return promptLine(); // piped input
}

function loadState() {
  const root = U.repoRoot();
  const p = U.paths(root);
  const config = U.readJSON(p.config, null);
  const lock = U.readJSON(p.lock, { approvals: [] });
  return { root, p, config, lock };
}

// Create a local signing key: encrypted keystore on disk + public key into the roster.
function createKey(p, config, name, pass) {
  const { pubB64, privDer } = C.generateKeypair();
  const ks = C.encryptKeystore(privDer, pass);
  fs.mkdirSync(p.keys, { recursive: true });
  const ksPath = path.join(p.keys, `${name}.keystore`);
  fs.writeFileSync(ksPath, JSON.stringify(ks, null, 2) + '\n', { mode: 0o600 });
  config.signers[name] = pubB64;
  config.owners = config.owners || [];
  if (!config.owners.includes(name)) config.owners.push(name);
  U.writeJSON(p.config, config);
  return ksPath;
}

// ── commands ──────────────────────────────────────────────
async function cmdInit(flags, positional) {
  // Guided setup: create files → choose a signing key (local/mobile) → optional adopt.
  // Interactive on a TTY; fully scriptable via flags (--key, --name, --passphrase,
  // --adopt/--no-adopt) and safe (never hangs) when non-interactive.
  const target = path.resolve(positional[0] || process.cwd());
  if (!fs.existsSync(target)) return fail(`no such directory: ${target}`);
  if (typeof flags.project === 'string' && flags.project.includes('/')) {
    console.log(U.c.yellow('note: ') + '`--project` is a display NAME, not a path. To set up another folder, pass it as a directory:');
    console.log('  ' + U.c.bold(`yay init ${flags.project}`) + '\n');
  }

  const p = U.paths(target);
  const rel = path.relative(process.cwd(), target) || '.';
  const tty = !!process.stdin.isTTY;

  // 1 ── files
  let config = U.readJSON(p.config, null);
  if (config) {
    console.log(U.c.dim('• .yaylayer already exists here — continuing setup.'));
  } else {
    const nameFlag = (flags.project && flags.project !== true && !String(flags.project).includes('/')) ? flags.project : null;
    const project = nameFlag || path.basename(target);
    config = { project, created: new Date().toISOString(), signers: {}, owners: [] };
    U.writeJSON(p.config, config);
    U.writeJSON(p.lock, { project, approvals: [] });
    fs.mkdirSync(p.keys, { recursive: true });
    console.log(U.c.green('✓ initialized YayLayer') + ` for "${project}"` + (rel === '.' ? '' : U.c.dim(` in ${rel}/`)));
    console.log('  ' + U.c.dim(`config + lock → ${path.join(rel, '.yaylayer')}/ (commit these) · keys → gitignored`));
  }

  // 2 ── signing key
  let keyChoice = (typeof flags.key === 'string') ? flags.key.toLowerCase() : null;
  if (!keyChoice) {
    if (tty && !Object.keys(config.signers).length) {
      console.log('\n' + U.c.bold('Signing key') + ' — you need one to approve (sign) specs.');
      console.log('  ' + U.c.bold('1') + ') Local  ' + U.c.dim('— key stored on this machine, passphrase-encrypted (less safe)'));
      console.log('  ' + U.c.bold('2') + ') Mobile ' + U.c.dim('— key lives only on your phone, never on this machine (safer)'));
      const ans = await ask('  Choose 1 or 2 (Enter to skip): ');
      keyChoice = ans === '1' ? 'local' : ans === '2' ? 'mobile' : 'none';
    } else keyChoice = 'none';
  }

  if (keyChoice === 'mobile') {
    console.log('\n' + U.c.bold('Mobile signing') + U.c.dim(' — your key is created and stays on your phone; this machine never holds it.'));
    const nameFlag = (flags.name && flags.name !== true) ? flags.name : null;
    const pairNow = flags.pair ? true : (flags['no-pair'] ? false : (tty ? /^y/i.test((await ask('  Pair your phone now? (Y/n): ')) || 'y') : false));
    if (pairNow) await runPairing(p, config, nameFlag);
    else console.log('  ' + U.c.dim('skipped — pair anytime (same Wi-Fi) with ') + U.c.bold('yay pair') + U.c.dim('.'));
  } else if (keyChoice === 'local') {
    let name = (flags.name && flags.name !== true) ? flags.name : null;
    if (!name && tty) name = await ask('  Your signer name (e.g. alice, or "Alice Carlsen"): ');
    if (!name) name = 'you';
    if (config.signers[name]) {
      console.log(U.c.dim(`• key for "${name}" already exists — skipping.`));
    } else {
      const pass = await getPassphrase(flags, `Set a passphrase to encrypt ${name}'s key (you'll re-enter it each time you sign)`);
      if (!pass || pass.length < 6) fail('passphrase must be at least 6 characters — key not created. Run `yay keygen` later.');
      else {
        const ksPath = createKey(p, config, name, pass);
        console.log(U.c.green(`✓ local key created for "${name}"`) + U.c.dim(` → ${path.relative(process.cwd(), ksPath)} (encrypted, gitignored)`));
      }
    }
  }

  // 3 ── adopt existing code
  let doAdopt = flags.adopt ? true : (flags['no-adopt'] ? false : null);
  if (doAdopt === null) {
    doAdopt = tty ? /^y/i.test(await ask('\nDoes this project already have code to bring under YayLayer? Run `adopt` now? (y/N): ')) : false;
  }
  if (doAdopt) {
    const res = adopt(target, { dry: false });
    if (!res.total) console.log(U.c.dim('• adopt: no un-tagged top-level functions found.'));
    else {
      console.log(U.c.green(`✓ adopt: scaffolded ${res.total} draft Cell(s) across ${res.report.length} file(s)`));
      console.log(U.c.dim('  each is DERIVED + unsigned — prune them, then `yay sign`.'));
    }
  }

  // 4 ── instruct the AI harness(es) to follow YayLayer from the start
  let conSpec = (typeof flags.constitution === 'string') ? flags.constitution : (flags.constitution === true ? 'all' : null);
  if (conSpec === null && tty) {
    console.log('\n' + U.c.bold('Instruct your AI to follow YayLayer') + ' — write the Constitution where the tool auto-reads it.');
    for (const h of HARNESSES) console.log('  ' + U.c.accent(h.key.padEnd(9)) + U.c.dim(h.path.padEnd(34) + h.note));
    const ans = await ask('  Which? comma-separated keys, "all", or Enter to skip: ');
    conSpec = ans.trim() || 'none';
  }
  if (conSpec && conSpec !== 'none') {
    for (const r of writeConstitution(target, resolveKeys(conSpec))) {
      if (r.error) console.log(U.c.red('  ✗ ') + r.key + ' — ' + r.error);
      else console.log('  ' + U.c.green('✓ ') + r.action.padEnd(9) + ' ' + r.path + U.c.dim(`  (${r.label})`));
    }
  }

  const cd = rel === '.' ? '' : `cd ${rel} && `;
  console.log('\n' + U.c.bold('Done.') + ' Next: write/prune specs → ' + U.c.bold(`${cd}yay verify`) + ' → ' + U.c.bold('yay sign') + '.');
}

function cmdGate(flags, positional) {
  const target = path.resolve(positional[0] || process.cwd());
  if (!fs.existsSync(target)) return fail(`no such directory: ${target}`);
  const scope = (flags.scope && flags.scope !== true) ? flags.scope : '';
  const pkg = (flags.pkg && flags.pkg !== true) ? flags.pkg : 'yay-layer';
  const opts = { force: !!flags.force, scope, pkg };

  const w = gate.writeWorkflow(target, opts);
  const wmark = w.action === 'skipped' ? U.c.dim('• skipped (exists — use --force) ') : U.c.green('✓ ' + w.action + ' ');
  console.log('  ' + wmark + w.path);

  if (flags.hook) {
    const h = gate.writeHook(target, opts);
    if (h.action === 'no-git') console.log('  ' + U.c.yellow('• pre-push hook: not a git repo (run `git init` first)'));
    else if (h.action === 'skipped') console.log('  ' + U.c.dim('• pre-push hook skipped (exists — use --force)'));
    else console.log('  ' + U.c.green('✓ created ') + h.path + U.c.dim('  (local feedback; bypass with git push --no-verify)'));
  }

  if (pkg === 'yay-layer') console.log('\n' + U.c.dim('note: yay-layer isn\'t on npm yet — until it is, use ') + U.c.bold('yay gate --pkg github:jonas-developer/yay-layer') + U.c.dim(' or edit the install line.'));
  console.log('\n' + gate.branchProtectionSteps());
  if (!flags.hook) console.log('\n' + U.c.dim('Tip: `yay gate --hook` also installs a local pre-push gate for solo/offline work.'));
}

function cmdConstitution(flags, positional) {
  const target = path.resolve(positional[0] || process.cwd());
  if (flags.list || flags.l) {
    console.log(U.c.bold('YayLayer can instruct these AI harnesses:'));
    for (const h of HARNESSES) console.log('  ' + U.c.accent(h.key.padEnd(9)) + h.path.padEnd(34) + U.c.dim(h.note));
    console.log(U.c.dim('\nWrite one or more: ') + U.c.bold('yay constitution --for claude,agents,cursor') + U.c.dim('  (or --for all)'));
    return;
  }
  const spec = (typeof flags.for === 'string') ? flags.for : (flags.for === true ? 'all' : null);
  if (!spec) {
    console.log('Pick harness(es): ' + U.c.bold('yay constitution --for claude,agents') + U.c.dim('  ·  list them with ') + U.c.bold('--list'));
    return;
  }
  for (const r of writeConstitution(target, resolveKeys(spec))) {
    if (r.error) console.log(U.c.red('  ✗ ') + r.key + ' — ' + r.error);
    else console.log('  ' + U.c.green('✓ ') + r.action.padEnd(9) + ' ' + r.path + U.c.dim(`  (${r.label})`));
  }
  console.log(U.c.dim('\nThe text between the YAYLAYER markers is managed by yay; anything outside it is yours. Commit these files.'));
}

async function cmdKeygen(flags) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const name = (flags.name && flags.name !== true) ? flags.name : null;
  if (!name) return fail('give yourself a name:  yay keygen --name alice');
  if (config.signers[name]) return fail(`a key for "${name}" already exists`);
  const pass = await getPassphrase(flags, `Set a passphrase to encrypt ${name}'s key (you'll re-enter it each time you sign)`);
  if (!pass || pass.length < 6) return fail('passphrase must be at least 6 characters');
  const ksPath = createKey(p, config, name, pass);
  console.log(U.c.green(`✓ key created for "${name}"`));
  console.log('  public key → roster in .yaylayer/config.json');
  console.log('  private key → ' + U.c.dim(path.relative(process.cwd(), ksPath)) + U.c.dim('  (gitignored, encrypted)'));
  console.log(U.c.yellow('\n  ⚠ MVP local keystore.') + ' In production the private key lives only on your phone (Face ID),');
  console.log('    backed up as a 24-word mnemonic. Never commit .yaylayer/keys/. See README.');
}

async function cmdSign(flags) {
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  const name = (flags.name && flags.name !== true) ? flags.name : config.owners[0];
  if (!name || !config.signers[name]) return fail(`unknown signer "${name}" — run \`yay keygen --name ${name || '<you>'}\``);
  const manifest = buildManifest(flags.dir || p.root);
  let ids = Object.keys(manifest.cells);
  if (flags.cell && flags.cell !== true) ids = String(flags.cell).split(',').map((s) => s.trim());
  if (!ids.length) return fail('no Cells to sign');
  const items = {};
  for (const id of ids) {
    if (!manifest.cells[id]) { console.log(U.c.yellow(`  skip ${id}: not found`)); continue; }
    items[id] = manifest.cells[id].specHash;
  }
  const n = (lock.approvals || []).length + 1;
  const approval = {
    id: 'A-' + String(n).padStart(4, '0'),
    project: config.project,
    prev: n > 1 ? lock.approvals[lock.approvals.length - 1].id : 'genesis',
    nonce: C.randomNonce(),
    at: new Date().toISOString(),
    signer: name,
    items,
  };

  if (flags.phone) {
    // Sign on the paired phone over the LAN — the private key never touches this machine.
    const verified = verifyManifest(manifest, lock, config, { mutate: false });
    const SEALCOLORS = { GREEN: '#1f9d57', YELLOW: '#c9860f', RED: '#cf4436', UNSIGNED: '#7f8796', PINK: '#e0559b' };
    const summary = Object.keys(items).map((id) => {
      const c = manifest.cells[id]; const r = (verified.results[id] || {});
      return { id, unit: c.unitName || (c.spec && c.spec.unit) || '', intent: (c.spec && c.spec.intent) || '', state: r.state || 'UNSIGNED', color: SEALCOLORS[r.state] || '#7f8796' };
    });
    const s = await phone.signOverLan({ project: config.project, approval, summary, expectPubB64: config.signers[name] });
    console.log('\n' + U.c.bold('Approve on your phone') + ' — on the same Wi-Fi, open:');
    console.log('   ' + U.c.accent(s.url));
    console.log(U.c.dim('   or on THIS computer: ') + U.c.accent(s.local));
    console.log(U.c.dim(`   reviewing ${summary.length} change(s) as "${name}" · Ctrl-C to cancel`));
    let r; try { r = await s.done; } finally { s.close(); }
    approval.signature = r.signature;
  } else {
    const ksPath = path.join(p.keys, `${name}.keystore`);
    if (!fs.existsSync(ksPath)) return fail(`no keystore for "${name}" — if this signer is a phone, use \`yay sign --phone\``);
    const pass = await getPassphrase(flags, `Enter ${name}'s passphrase to sign`);
    let privDer;
    try { privDer = C.decryptKeystore(JSON.parse(fs.readFileSync(ksPath, 'utf8')), pass); }
    catch (e) { return fail(e.message); }
    approval.signature = C.sign(U.canonical(approval), privDer);
  }

  lock.approvals = lock.approvals || [];
  lock.approvals.push(approval);
  U.writeJSON(p.lock, lock);
  console.log(U.c.green(`✓ signed ${Object.keys(items).length} Cell(s)`) + ` as "${name}" — approval ${approval.id}`);
  console.log('  ' + U.c.dim('seal appended to .yaylayer/lock.json (commit this)'));
}

// Shared pairing flow (used by `yay pair` and by `yay init` when Mobile is chosen).
async function runPairing(p, config, nameFlag) {
  const s = await phone.pairOverLan({ project: config.project });
  console.log('\n' + U.c.bold('Pair your phone') + ' — on the SAME Wi-Fi, open this on your phone:');
  console.log('   ' + U.c.accent(s.url));
  console.log(U.c.dim('   or, to try it on THIS computer: ') + U.c.accent(s.local) + U.c.dim('  (localhost works; a plain-http LAN address disables signing)'));
  console.log(U.c.dim('   create your key there; it will show a 6-digit code. (Ctrl-C to cancel.)'));
  let r; try { r = await s.done; } finally { s.close(); }
  const name = nameFlag || r.name;
  console.log('\n  Your phone should show code: ' + U.c.bold(r.code));
  const ans = await ask('  Does it match exactly? (y/N): ');
  if (!/^y/i.test(ans)) { console.log(U.c.red('  pairing aborted — code did not match (possible wrong device)')); return false; }
  config.signers = config.signers || {};
  if (config.signers[name]) console.log(U.c.yellow(`  note: replacing the existing key for "${name}"`));
  config.signers[name] = r.pubB64;
  config.owners = config.owners || [];
  if (!config.owners.includes(name)) config.owners.push(name);
  config.devices = config.devices || {};
  config.devices[name] = { type: 'phone', pairedAt: new Date().toISOString() };
  U.writeJSON(p.config, config);
  console.log(U.c.green(`✓ paired "${name}"`) + U.c.dim(' — public key added to the roster (commit .yaylayer/config.json).'));
  return true;
}

async function cmdPair(flags) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const nameFlag = (flags.name && flags.name !== true) ? flags.name : null;
  const ok = await runPairing(p, config, nameFlag);
  if (ok) console.log('  ' + U.c.dim('now approve change-sets with ') + U.c.bold('yay sign --phone'));
}

function printReport(manifest, verified, details, problemsOnly) {
  for (const prob of manifest.problems) {
    console.log(U.c.red('  ✗ ') + `${prob.id || ''} ${prob.file || ''} — ${prob.error}`);
  }
  const allIds = Object.keys(verified.results).sort();
  const ids = problemsOnly ? allIds.filter((id) => verified.results[id].state !== 'GREEN') : allIds;
  if (problemsOnly && !ids.length && !manifest.problems.length) {
    console.log('  ' + U.c.green(`✓ all ${allIds.length} Cell(s) green — nothing to review.`));
  }
  const ind = '        ';
  for (const id of ids) {
    const r = verified.results[id];
    const st = U.STATE[r.state];
    const who = r.trust && r.trust.signed ? (r.trust.auto ? 'auto' : r.trust.signer) : '';
    console.log('  ' + st.color(st.glyph) + ' ' + st.color(r.state.padEnd(8)) + ' ' +
      U.c.accent(id.padEnd(8)) + ' ' + U.c.dim(`${r.file}:${r.line}`) + (who ? U.c.dim('  · ' + who) : ''));
    if (r.notes.length) for (const note of r.notes) {
      const paint = note.level === 'red' ? U.c.red : note.level === 'yellow' ? U.c.yellow : U.c.dim;
      const sym = note.level === 'red' ? '✗' : note.level === 'yellow' ? '⚠' : '–';
      console.log('      ' + paint(sym + ' ' + note.text));
    } else if (details) console.log('      ' + U.c.green('✓ all checks passed'));

    if (details) {
      const cell = manifest.cells[id];
      if (cell) {
        console.log('      ' + U.c.accent('spec'));
        for (const l of (cell.specBlock || '').split('\n')) console.log(ind + U.c.dim(l));
        if (cell.unitBody) {
          const bad = new Set((r.badLines || []).map((s) => s.trim()));
          console.log('      ' + U.c.accent('code'));
          for (const l of cell.unitBody.split('\n')) {
            const isBad = l.trim() && bad.has(l.trim());
            console.log(ind + (isBad ? U.c.red('▶ ' + l) : U.c.dim(l)));
          }
        }
        const meta = [];
        const when = (v) => (v ? String(v).slice(0, 16).replace('T', ' ') : '');
        if (r.trust && r.trust.signed) {
          meta.push((r.trust.auto ? 'AUTO·' + (r.trust.grant || 'grant') : 'by ' + r.trust.signer) + (r.trust.at ? ' on ' + when(r.trust.at) : ''));
        } else meta.push('unsigned');
        if (r.trust && r.trust.firstAt && r.trust.firstAt !== r.trust.at) meta.push('first signed ' + when(r.trust.firstAt));
        meta.push('spec ' + cell.specHash.slice(0, 12) + '…');
        if (cell.feeds && cell.feeds.length) meta.push('feeds → ' + cell.feeds.join(', '));
        if (cell.contains && cell.contains.length) meta.push('contains ' + cell.contains.join(', '));
        console.log('      ' + U.c.accent('meta') + ' ' + U.c.dim(meta.join(' · ')));
      }
      console.log('');
    }
  }
  const c = verified.counts;
  console.log('\n  ' + U.c.green(`${c.GREEN} green`) + '  ' + U.c.yellow(`${c.YELLOW} yellow`) + '  ' +
    U.c.red(`${c.RED} red`) + '  ' + U.c.gray(`${c.UNSIGNED} unsigned`) + '  ' + U.c.pink(`${c.PINK} pink`));
  if (c.PINK) console.log('  ' + U.c.pink(`◆ ${c.PINK} unspecified code section(s) — never described or signed. Run `) + U.c.bold('yay adopt') + U.c.pink('.'));
}

function cmdVerify(flags) {
  const { p, config, lock } = loadState();
  const manifest = buildManifest(flags.dir || p.root);
  if (!Object.keys(manifest.cells).length && !manifest.problems.length && !(manifest.untracked || []).length) {
    console.log(U.c.dim('no code found. Write a spec block (see README/STANDARD), or run `yay adopt`.')); return;
  }
  const verified = verifyManifest(manifest, lock, config, { mutate: !flags['no-mutate'] });
  printReport(manifest, verified, !!(flags.details || flags.d), !!(flags.problems || flags.issues || flags.p));
  const blocked = !verified.passed || manifest.problems.length;
  console.log('\n  ' + (blocked ? U.c.red('GATE: BLOCKED') + U.c.dim(' (red, unsigned, or unspecified/pink code cannot reach main)')
    : U.c.green('GATE: PASS')));
  if (!flags.dir && process.argv.includes('--strict')) process.exit(blocked ? 1 : 0);
  if (flags.strict) process.exit(blocked ? 1 : 0);
}

// Per-Cell "last changed" timeline, DERIVED (not stored in the spec):
//   1. lock chain — the most recent signed approval that included the Cell
//   2. git — last commit that touched the Cell's file
//   3. filesystem mtime — last resort
// Timestamps are epoch ms; `source` says which signal won.
function cellChanges(root, lock, cells) {
  const signedLast = Object.create(null);
  for (const ap of (lock && lock.approvals) || []) {
    const t = ap.at ? Date.parse(ap.at) : NaN;
    if (isNaN(t) || !ap.items) continue;
    for (const id of Object.keys(ap.items)) signedLast[id] = Math.max(signedLast[id] || 0, t);
  }
  // git per-file, cached: last commit (%cI of -1) and first commit (%cI of --reverse head).
  const gitCache = Object.create(null);
  const git = (rel, first) => {
    const key = (first ? 'A:' : 'Z:') + rel;
    if (key in gitCache) return gitCache[key];
    let t = 0;
    try {
      const a = first ? ['log', '--reverse', '--format=%cI', '--', rel] : ['log', '-1', '--format=%cI', '--', rel];
      const out = require('child_process')
        .execFileSync('git', ['-C', root, ...a], { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().split('\n')[0].trim();
      if (out) t = Date.parse(out) || 0;
    } catch (_) {}
    return (gitCache[key] = t);
  };
  const statMs = (rel, kind) => { try { const s = fs.statSync(path.join(root, rel)); return (kind === 'birth' ? s.birthtimeMs : s.mtimeMs) || 0; } catch (_) { return 0; } };

  const out = [];
  const times = Object.create(null);
  for (const id of Object.keys(cells)) {
    const c = cells[id];
    if (c.contains && c.contains.length) continue; // leaf Cells (specs), not modules
    const s = signedLast[id] || 0;
    const g = git(c.file, false) || 0;
    let at = Math.max(s, g), source = s >= g ? 'signed' : 'code';
    if (!at) { at = statMs(c.file, 'mtime'); source = 'file'; }
    if (at) out.push({ id: 'u:' + id, at, source });
    times[id] = {
      createdCode: git(c.file, true) || statMs(c.file, 'birth') || null,
      changedCode: g || statMs(c.file, 'mtime') || null,
    };
  }
  out.sort((a, b) => b.at - a.at);
  return { changes: out, times };
}

function cmdMap(flags) {
  const { p, config, lock } = loadState();
  const manifest = buildManifest(flags.dir || p.root);
  const verified = verifyManifest(manifest, lock, config, { mutate: !flags['no-mutate'] });
  const { changes, times } = cellChanges(manifest.root, lock, manifest.cells);
  const html = renderMap(manifest, verified, config && config.project, changes, times);
  const out = (flags.o && flags.o !== true) ? flags.o : (flags.out && flags.out !== true ? flags.out : 'yay-layer-map.html');
  fs.writeFileSync(out, html);
  console.log(U.c.green('✓ map written → ') + out + U.c.dim(`  (${Object.keys(verified.results).length} items)`));
}

function cmdAdopt(flags, positional) {
  const target = positional[0] || '.';
  const res = adopt(target, { dry: !!flags.dry });
  if (!res.total) { console.log(U.c.dim('nothing to adopt — no un-tagged top-level functions found.')); return; }
  console.log((res.dry ? U.c.yellow('(dry run) ') : U.c.green('✓ ')) + `${res.total} draft Cell(s) across ${res.report.length} file(s):`);
  for (const r of res.report) console.log('  ' + U.c.dim(r.file) + '  +' + r.added);
  console.log('\n  Next: prune each DERIVED spec, then ' + U.c.bold('yay sign') + '.');
}

function cmdStatus() {
  const { p, config, lock } = loadState();
  if (!config) return console.log(U.c.dim('not initialized — run `yay init`'));
  const manifest = buildManifest(p.root);
  const verified = verifyManifest(manifest, lock, config);
  const c = verified.counts;
  console.log(U.c.bold(config.project) + U.c.dim(`  · ${Object.keys(manifest.cells).length} Cells · ${Object.keys(config.signers).length} signer(s)`));
  console.log('  ' + U.c.green(`${c.GREEN}●`) + ' ' + U.c.yellow(`${c.YELLOW}●`) + ' ' + U.c.red(`${c.RED}●`) + ' ' + U.c.gray(`${c.UNSIGNED}○`) + '  ' + (verified.passed ? U.c.green('PASS') : U.c.red('BLOCKED')));
}

function fail(msg) { console.error(U.c.red('error: ') + msg); process.exitCode = 1; }

const HELP = `yay — a protocol for provable, signed AI code

  yay init [dir]              guided setup: files → signing key → adopt → instruct your AI
                             flags: --project <name> --key local|mobile --name <you> --adopt|--no-adopt --constitution <keys|all>
  yay constitution --for <k> write the Constitution where an AI harness auto-reads it
                             (--for claude,agents,cursor,copilot,windsurf,cline,gemini,generic | all · --list)
  yay keygen --name <you>     create your signing key
  yay adopt [path] [--dry]    scaffold draft specs over existing code
  yay pair [--name you]      pair your phone as the signer (key stays on the phone, over LAN)
  yay sign [--all|--cell IDs] approve the current specs  ·  --phone signs on the paired phone
  yay verify [--strict] [-d]  the gate — paint every Cell; -d/--details prints each spec, code & checks
                             --problems shows only non-green Cells · --no-mutate skips prover mutation grading
  yay map [-o file.html]      write the HTML flowchart (default: yay-layer-map.html)
  yay gate [dir]              write the CI gate workflow (+ --hook local pre-push) & print the
                             branch-protection steps · flags: --scope <dir> --pkg <spec> --hook --force
  yay status                  one-line summary

  docs: standard/STANDARD.md · CONSTITUTION.md · README.md`;

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { flags, positional } = args(rest);
  switch (cmd) {
    case 'init': return cmdInit(flags, positional);
    case 'keygen': return cmdKeygen(flags);
    case 'sign': return cmdSign(flags);
    case 'pair': return cmdPair(flags);
    case 'verify': case 'check': return cmdVerify(flags);
    case 'map': return cmdMap(flags);
    case 'adopt': return cmdAdopt(flags, positional);
    case 'constitution': case 'rules': return cmdConstitution(flags, positional);
    case 'gate': case 'ci': return cmdGate(flags, positional);
    case 'status': return cmdStatus();
    case undefined: case 'help': case '--help': case '-h': return console.log(HELP);
    default: console.error(U.c.red(`unknown command: ${cmd}`)); console.log(HELP); process.exitCode = 1;
  }
}
main().catch((e) => { console.error(U.c.red('error: ') + (e && e.message || e)); process.exitCode = 1; });
