#!/usr/bin/env node
'use strict';
// yay — the YayLayer command line.
//   yay init            set up YayLayer in this repo
//   yay keygen --name   create your signing key (encrypted keystore + public key in the roster)
//   yay adopt [path]    scaffold draft specs over existing code
//   yay sign [--all]    sign (approve) the current specs   [local stand-in for the phone signer]
//   yay verify          the gate: paint every Cell green/yellow/red/unsigned
//   yay map [-o file]   write the HTML flowchart
//   yay status          one-line summary

const fs = require('fs');
const path = require('path');

const U = require('../src/util');
const C = require('../src/crypto');
const { buildManifest } = require('../src/manifest');
const { verifyManifest } = require('../src/verify');
const { renderMap } = require('../src/map');
const { adopt } = require('../src/adopt');

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

// Read one plain line (for piped/non-interactive input).
function promptLine() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.on('data', (c) => {
      data += c;
      const nl = data.indexOf('\n');
      if (nl >= 0) { process.stdin.pause(); resolve(data.slice(0, nl).replace(/\r$/, '')); }
    });
  });
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

// ── commands ──────────────────────────────────────────────
async function cmdInit(flags, positional) {
  // init sets up the folder you point it at — a directory argument, or the
  // current directory if none. It does NOT walk up to a git root, so it's
  // predictable: `.yaylayer/` lands exactly where you say.
  const target = path.resolve(positional[0] || process.cwd());
  if (!fs.existsSync(target)) return fail(`no such directory: ${target}`);

  if (typeof flags.project === 'string' && flags.project.includes('/')) {
    console.log(U.c.yellow('note: ') + '`--project` is a display NAME, not a path. To set up another folder, pass it as a directory:');
    console.log('  ' + U.c.bold(`yay init ${flags.project}`) + '\n');
  }

  const p = U.paths(target);
  if (fs.existsSync(p.config)) { console.log(U.c.dim('already initialized: ' + p.config)); return; }
  const nameFlag = (flags.project && flags.project !== true && !String(flags.project).includes('/')) ? flags.project : null;
  const project = nameFlag || path.basename(target);
  U.writeJSON(p.config, { project, created: new Date().toISOString(), signers: {}, owners: [] });
  U.writeJSON(p.lock, { project, approvals: [] });
  fs.mkdirSync(p.keys, { recursive: true });

  const rel = path.relative(process.cwd(), target) || '.';
  const where = rel === '.' ? '' : U.c.dim(` in ${rel}/`);
  console.log(U.c.green('✓ initialized YayLayer') + ` for "${project}"` + where);
  console.log('  ' + U.c.dim(`config → ${path.join(rel, '.yaylayer/config.json')} (commit this)`));
  console.log('  ' + U.c.dim('keys   → .yaylayer/keys/ (gitignored — private)'));
  const cd = rel === '.' ? '' : `cd ${rel} && `;
  console.log('\nNext:  ' + U.c.bold(`${cd}yay keygen --name <you>`) + '   then write Cells or ' + U.c.bold('yay adopt') + '.');
}

async function cmdKeygen(flags) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const name = (flags.name && flags.name !== true) ? flags.name : null;
  if (!name) return fail('give yourself a name:  yay keygen --name alice');
  const pass = await getPassphrase(flags, `Set a passphrase to encrypt ${name}'s key (you'll re-enter it each time you sign)`);
  if (!pass || pass.length < 6) return fail('passphrase must be at least 6 characters');
  const { pubB64, privDer } = C.generateKeypair();
  const ks = C.encryptKeystore(privDer, pass);
  fs.mkdirSync(p.keys, { recursive: true });
  const ksPath = path.join(p.keys, `${name}.keystore`);
  fs.writeFileSync(ksPath, JSON.stringify(ks, null, 2) + '\n', { mode: 0o600 });
  config.signers[name] = pubB64;
  if (!config.owners.includes(name)) config.owners.push(name);
  U.writeJSON(p.config, config);
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
  const ksPath = path.join(p.keys, `${name}.keystore`);
  if (!fs.existsSync(ksPath)) return fail(`no keystore for "${name}"`);
  const pass = await getPassphrase(flags, `Enter ${name}'s passphrase to sign`);
  let privDer;
  try { privDer = C.decryptKeystore(JSON.parse(fs.readFileSync(ksPath, 'utf8')), pass); }
  catch (e) { return fail(e.message); }

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
  approval.signature = C.sign(U.canonical(approval), privDer);
  lock.approvals = lock.approvals || [];
  lock.approvals.push(approval);
  U.writeJSON(p.lock, lock);
  console.log(U.c.green(`✓ signed ${Object.keys(items).length} Cell(s)`) + ` as "${name}" — approval ${approval.id}`);
  console.log('  ' + U.c.dim('seal appended to .yaylayer/lock.json (commit this)'));
}

function printReport(manifest, verified, details) {
  for (const prob of manifest.problems) {
    console.log(U.c.red('  ✗ ') + `${prob.id || ''} ${prob.file || ''} — ${prob.error}`);
  }
  const ids = Object.keys(verified.results).sort();
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
        meta.push(r.trust && r.trust.signed ? (r.trust.auto ? 'AUTO·' + (r.trust.grant || 'grant') : 'by ' + r.trust.signer) : 'unsigned');
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
  const verified = verifyManifest(manifest, lock, config);
  printReport(manifest, verified, !!(flags.details || flags.d));
  const blocked = !verified.passed || manifest.problems.length;
  console.log('\n  ' + (blocked ? U.c.red('GATE: BLOCKED') + U.c.dim(' (red, unsigned, or unspecified/pink code cannot reach main)')
    : U.c.green('GATE: PASS')));
  if (!flags.dir && process.argv.includes('--strict')) process.exit(blocked ? 1 : 0);
  if (flags.strict) process.exit(blocked ? 1 : 0);
}

function cmdMap(flags) {
  const { p, config, lock } = loadState();
  const manifest = buildManifest(flags.dir || p.root);
  const verified = verifyManifest(manifest, lock, config);
  const html = renderMap(manifest, verified, config && config.project);
  const out = (flags.o && flags.o !== true) ? flags.o : (flags.out && flags.out !== true ? flags.out : 'yaylayer-map.html');
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

  yay init [dir]              set up YayLayer in [dir] (or the current folder); --project sets its name
  yay keygen --name <you>     create your signing key
  yay adopt [path] [--dry]    scaffold draft specs over existing code
  yay sign [--all|--cell IDs] approve the current specs (local stand-in for the phone signer)
  yay verify [--strict] [-d]  the gate — paint every Cell; -d/--details prints each spec, code & checks
  yay map [-o file.html]      write the HTML flowchart
  yay status                  one-line summary

  docs: standard/STANDARD.md · CONSTITUTION.md · README.md`;

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const { flags, positional } = args(rest);
  switch (cmd) {
    case 'init': return cmdInit(flags, positional);
    case 'keygen': return cmdKeygen(flags);
    case 'sign': return cmdSign(flags);
    case 'verify': case 'check': return cmdVerify(flags);
    case 'map': return cmdMap(flags);
    case 'adopt': return cmdAdopt(flags, positional);
    case 'status': return cmdStatus();
    case undefined: case 'help': case '--help': case '-h': return console.log(HELP);
    default: console.error(U.c.red(`unknown command: ${cmd}`)); console.log(HELP); process.exitCode = 1;
  }
}
main().catch((e) => { console.error(U.c.red('error: ') + (e && e.message || e)); process.exitCode = 1; });
