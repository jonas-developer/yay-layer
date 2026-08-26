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
const { specDiffForCell } = require('../src/specdiff');
const dashboardMod = require('../src/dashboard');
const { resolveTestCmd, runTests } = require('../src/testrun');
const { adversaryManifest, eligible: advEligible } = require('../src/adversary');
const gate = require('../src/gate');
const phone = require('../src/phone');
const rosterMod = require('../src/roster');
const plan = require('../src/plan');
const E2E = require('../src/e2e');
const grantsMod = require('../src/grants');

// Load .env / .env.local into process.env (without overriding what's already set).
// Lets users keep their own ANTHROPIC_API_KEY in a gitignored .env file.
function loadDotenv() {
  for (const f of ['.env', '.env.local']) {
    let t; try { t = fs.readFileSync(path.join(process.cwd(), f), 'utf8'); } catch (_) { continue; }
    for (const line of t.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || (m[1] in process.env)) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
}

// Resolve the LLM provider + key + model for `yay plan` / plan-in-map.
// Prefers config.plan (set at init), then flags, then whichever key is in env.
function resolvePlanAuth(config, flags) {
  flags = flags || {};
  const pc = (config && config.plan) || {};
  let provider = (flags.provider && flags.provider !== true) ? String(flags.provider).toLowerCase()
    : (pc.provider || (process.env.ANTHROPIC_API_KEY ? 'anthropic' : ((process.env.OPENAI_API_KEY || process.env.OPENAI_BASE_URL) ? 'openai' : null)));
  if (!provider) return { error: 'set ANTHROPIC_API_KEY or OPENAI_API_KEY in your .env, or pass --provider (anthropic|openai|custom).' };
  const baseUrl = (flags['base-url'] && flags['base-url'] !== true) ? flags['base-url'] : (pc.baseUrl || process.env.OPENAI_BASE_URL || null);
  // custom = any OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, a private gateway…). Key optional.
  if (provider === 'custom' && !baseUrl) return { error: 'custom provider needs an endpoint — pass --base-url <url> (or set it during `yay init`).' };
  const apiKey = provider === 'anthropic' ? process.env.ANTHROPIC_API_KEY : (process.env.OPENAI_API_KEY || process.env.YAY_PLAN_API_KEY || '');
  if (provider === 'anthropic' && !apiKey) return { error: 'ANTHROPIC_API_KEY is not set in your .env.' };
  if (provider === 'openai' && !apiKey) return { error: 'OPENAI_API_KEY is not set in your .env.' };
  const model = (flags.model && flags.model !== true) ? flags.model : (pc.model || (provider === 'anthropic' ? 'claude-sonnet-5' : (provider === 'openai' ? 'gpt-4o' : null)));
  if (provider === 'custom' && !model) return { error: 'custom provider needs a model — pass --model <id> (or set it during `yay init`).' };
  return { provider, apiKey, model, baseUrl };
}

function rosterPath(p) { return path.join(path.dirname(p.config), 'roster.json'); }
function loadRoster(p) { return U.readJSON(rosterPath(p), null); }
// Freedom mode: the append-only, owner-signed grants log (committed) + the machine-held
// grant private keys (in the gitignored keys/, used for UNATTENDED auto-signing).
function grantsPath(p) { return path.join(path.dirname(p.config), 'grants.json'); }
function loadGrants(p) { return U.readJSON(grantsPath(p), null); }
function grantKeyPath(p, id) { return path.join(p.keys, `grant-${id}.json`); }
function parseDuration(s) {
  const m = String(s).trim().match(/^(\d+)\s*([smhd])$/i);
  if (!m) return null;
  const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}

// Infer how this project signs, for method-aware Constitution guidance.
function signMethodOf(config) {
  const kinds = new Set();
  for (const n of Object.keys((config && config.signers) || {})) {
    const list = Array.isArray(config.signers[n]) ? config.signers[n] : [config.signers[n]];
    for (const k of list) if (k && typeof k === 'object' && k.kind) kinds.add(k.kind);
  }
  if (config && config.devices && Object.keys(config.devices).length) kinds.add('phone');
  const hasPhone = kinds.has('phone'), hasLocal = kinds.has('local');
  if (hasPhone && !hasLocal) return 'phone';
  if (hasLocal && !hasPhone) return 'local';
  return null; // unknown or mixed → generic guidance
}

// Decide how `yay sign` signs when no explicit flag is given: use the project's
// established method so you never have to type --phone. Explicit --phone/--local win.
function resolveSignMethod(config, p, name, flags) {
  if (flags.phone) return 'phone';
  if (flags.local) return 'local';
  const m = signMethodOf(config);
  if (m) return m; // project clearly signs one way
  // mixed/unknown: a local keystore on this machine → local, else the phone
  return fs.existsSync(path.join(p.keys, `${name}.keystore`)) ? 'local' : 'phone';
}
function trustRootPin(flags) { return (flags.root && flags.root !== true) ? flags.root : (process.env.YAY_TRUST_ROOT || null); }

// Print a scannable QR of a URL to the terminal (graceful if the lib is absent).
function printQR(url) {
  try { require('qrcode-terminal').generate(url, { small: true }, (q) => console.log(q)); }
  catch (_) { console.log(U.c.dim('   (install qrcode-terminal for a scannable QR)')); }
}
// Self-signed TLS for phone signing, ON BY DEFAULT (--no-https opts out). Cert cached in the gitignored
// keys dir; generated with openssl. Returns { key, cert } or null (→ falls back to http).
function tlsCert(p, flags) {
  // HTTPS is the default (SSL over the LAN); --no-https opts out for plain http.
  if (flags['no-https']) return null;
  const cp = require('child_process');
  const ip = phone.lanIP();
  fs.mkdirSync(p.keys, { recursive: true });
  // The cert's SubjectAltName is bound to the current LAN IP; if we switched networks
  // the cached cert would fail hostname validation, so track the IP and regenerate on change.
  const freshFor = (crtP, ipP) => fs.existsSync(crtP) && fs.existsSync(ipP) && fs.readFileSync(ipP, 'utf8').trim() === ip;

  // Prefer mkcert: a LOCALLY-TRUSTED cert → no browser warning (real server auth + encryption).
  try {
    const caRoot = cp.execFileSync('mkcert', ['-CAROOT'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (caRoot && fs.existsSync(path.join(caRoot, 'rootCA.pem'))) {
      const keyP = path.join(p.keys, 'tls-mkcert.key'), crtP = path.join(p.keys, 'tls-mkcert.crt'), ipP = path.join(p.keys, 'tls-mkcert.ip');
      if (!fs.existsSync(keyP) || !freshFor(crtP, ipP)) {
        cp.execFileSync('mkcert', ['-key-file', keyP, '-cert-file', crtP, ip, 'localhost', '127.0.0.1', '::1'], { stdio: 'ignore' });
        fs.writeFileSync(ipP, ip);
      }
      return { key: fs.readFileSync(keyP, 'utf8'), cert: fs.readFileSync(crtP, 'utf8'), trusted: true, caRoot, ip };
    }
  } catch (_) { /* mkcert absent → fall through to self-signed */ }

  // Fallback: self-signed via openssl — still encrypted, but a one-time "not private" warning.
  const keyP = path.join(p.keys, 'tls.key'), crtP = path.join(p.keys, 'tls.crt'), ipP = path.join(p.keys, 'tls.ip');
  try {
    if (!fs.existsSync(keyP) || !freshFor(crtP, ipP)) {
      cp.execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyP, '-out', crtP, '-days', '825', '-subj', '/CN=yaylayer', '-addext', 'subjectAltName=IP:' + ip + ',DNS:localhost'], { stdio: 'ignore' });
      fs.writeFileSync(ipP, ip);
    }
    return { key: fs.readFileSync(keyP, 'utf8'), cert: fs.readFileSync(crtP, 'utf8'), trusted: false, ip };
  } catch (_) { console.log(U.c.yellow('  ⚠ could not create an HTTPS cert (is openssl installed?) — falling back to http. Pass --no-https to silence.')); return null; }
}

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
// Add a public key to an identity (one identity may hold several keys: local +
// phone …). Idempotent; migrates a legacy single-string entry to a list.
function addSignerKey(config, name, pub, kind) {
  config.signers = config.signers || {};
  const cur = config.signers[name];
  let list;
  if (Array.isArray(cur)) list = cur.slice();
  else if (typeof cur === 'string') list = [{ pub: cur, kind: 'local' }];
  else if (cur && cur.pub) list = [cur];
  else list = [];
  const has = list.some((k) => (typeof k === 'string' ? k : k.pub) === pub);
  if (!has) list.push({ pub, kind: kind || 'key', addedAt: new Date().toISOString() });
  config.signers[name] = list;
  config.owners = config.owners || [];
  if (!config.owners.includes(name)) config.owners.push(name);
  return has ? 'exists' : 'added';
}

function createKey(p, config, name, pass) {
  const { pubB64, privDer } = C.generateKeypair();
  const ks = C.encryptKeystore(privDer, pass);
  fs.mkdirSync(p.keys, { recursive: true });
  const ksPath = path.join(p.keys, `${name}.keystore`);
  fs.writeFileSync(ksPath, JSON.stringify(ks, null, 2) + '\n', { mode: 0o600 });
  addSignerKey(config, name, pubB64, 'local');
  U.writeJSON(p.config, config);
  // Establish the signed trust root on the very first key (genesis, self-signed).
  const rp = rosterPath(p);
  if (!fs.existsSync(rp)) {
    const ev = { id: 'R-0001', type: 'genesis', name, pub: pubB64, role: 'owner', by: name, prev: 'genesis', nonce: C.randomNonce(), at: new Date().toISOString() };
    ev.signature = C.sign(rosterMod.eventBytes(ev), privDer);
    U.writeJSON(rp, { project: config.project, events: [ev] });
    console.log('  ' + U.c.dim('trust root established → ' + rosterMod.fingerprint(pubB64)) + U.c.dim(' (pin this in CI)'));
  }
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
      console.log('  ' + U.c.bold('2') + ') Mobile, LAN ' + U.c.dim('— key lives only on your phone; phone ⇄ laptop directly over your Wi-Fi (private, no server)'));
      console.log('  ' + U.c.bold('3') + ') Mobile, relay ' + U.c.dim('— same, but via relay.yaylayer.com for when off your LAN (end-to-end encrypted; the relay never sees your code)'));
      const ans = await ask('  Choose 1, 2 or 3 (Enter to skip): ');
      keyChoice = ans === '1' ? 'local' : (ans === '2' || ans === '3') ? 'mobile' : 'none';
      if (ans === '3') config.transport = 'relay';
    } else keyChoice = 'none';
  }
  // Flag overrides (scriptable): --relay picks the hosted-relay transport; --lan the LAN one.
  if (flags.relay) { keyChoice = 'mobile'; config.transport = 'relay'; }
  if (flags.lan && config.transport === 'relay') delete config.transport;
  if (keyChoice === 'mobile') U.writeJSON(p.config, config); // persist the transport choice

  if (keyChoice === 'mobile') {
    const via = config.transport === 'relay' ? ' (via relay.yaylayer.com)' : ' (over your Wi-Fi)';
    console.log('\n' + U.c.bold('Mobile signing') + via + U.c.dim(' — your key is created and stays on your phone; this machine never holds it.'));
    const nameFlag = (flags.name && flags.name !== true) ? flags.name : null;
    const pairNow = flags.pair ? true : (flags['no-pair'] ? false : (tty ? /^y/i.test((await ask('  Pair your phone now? (Y/n): ')) || 'y') : false));
    if (pairNow) await runPairing(p, config, flags);
    else console.log('  ' + U.c.dim('skipped — pair anytime with ') + U.c.bold('yay pair') + U.c.dim('.'));
  } else if (keyChoice === 'local') {
    let name = (flags.name && flags.name !== true) ? flags.name : null;
    if (!name && tty) name = await ask('  Your signer name (e.g. alice, or "Alice Carlsen"): ');
    if (!name) name = 'you';
    if (fs.existsSync(path.join(p.keys, `${name}.keystore`))) {
      console.log(U.c.dim(`• local key for "${name}" already exists — skipping.`));
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
    const cMethod = keyChoice === 'mobile' ? 'phone' : keyChoice === 'local' ? 'local' : signMethodOf(config);
    for (const r of writeConstitution(target, resolveKeys(conSpec), cMethod)) {
      if (r.error) console.log(U.c.red('  ✗ ') + r.key + ' — ' + r.error);
      else console.log('  ' + U.c.green('✓ ') + r.action.padEnd(9) + ' ' + r.path + U.c.dim(`  (${r.label})`));
    }
  }

  // 5 ── optional: AI System Plan generation baked into the map (needs an API key)
  let planAns = flags.plan ? 'y' : (flags['no-plan'] ? 'n' : null);
  if (planAns === null && tty) {
    console.log('\n' + U.c.bold('AI System Plan') + U.c.dim(' — a presentation-grade overview generated by an LLM and shown in the map.'));
    console.log('  ' + U.c.dim('This calls an LLM, so it needs your own API key (stored in .env, gitignored).'));
    planAns = /^y/i.test((await ask('  Enable System Plan generation in the map? (y/N): ')) || 'n') ? 'y' : 'n';
  }
  if (planAns === 'y') {
    let provider = (flags.provider && flags.provider !== true) ? String(flags.provider).toLowerCase() : null;
    if (!provider && tty) {
      const a = (await ask('  Provider — [a]nthropic, [o]penai, or [c]ustom (local / OpenAI-compatible)? (a/o/c): ')) || 'a';
      provider = /^c/i.test(a) ? 'custom' : (/^o/i.test(a) ? 'openai' : 'anthropic');
    }
    provider = provider || 'anthropic';
    const plan = { enabled: true, provider };
    if (provider === 'custom') {
      let baseUrl = (flags['base-url'] && flags['base-url'] !== true) ? flags['base-url'] : '';
      if (!baseUrl && tty) baseUrl = (await ask('  Endpoint URL (e.g. http://localhost:11434/v1 for Ollama): ')).trim();
      let model = (flags.model && flags.model !== true) ? flags.model : '';
      if (!model && tty) model = (await ask('  Model id (e.g. llama3.1): ')).trim();
      plan.baseUrl = baseUrl; plan.model = model || 'llama3.1';
      let key = (flags['api-key'] && flags['api-key'] !== true) ? flags['api-key'] : '';
      if (!key && tty) key = (await promptHidden('  API key if your endpoint needs one (blank for local): ')).trim();
      config.plan = plan; U.writeJSON(p.config, config);
      if (key) { writeEnvVar(target, 'OPENAI_API_KEY', key); ensureGitignored(target, '.env'); }
      console.log('  ' + U.c.green('✓ custom provider set') + U.c.dim(` → ${baseUrl || '(no URL yet)'} · model ${plan.model} · \`yay map\` will use it.`));
    } else {
      const envVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
      let key = (flags['api-key'] && flags['api-key'] !== true) ? flags['api-key'] : (process.env[envVar] || '');
      if (!key && tty) key = (await promptHidden(`  Paste your ${envVar} (hidden, stored in .env): `)).trim();
      plan.model = provider === 'anthropic' ? 'claude-sonnet-5' : 'gpt-4o';
      config.plan = plan; U.writeJSON(p.config, config);
      if (key) {
        writeEnvVar(target, envVar, key); ensureGitignored(target, '.env');
        console.log('  ' + U.c.green(`✓ ${envVar} saved to .env`) + U.c.dim(' (gitignored) · System Plan enabled — `yay map` will generate it.'));
      } else {
        console.log('  ' + U.c.yellow('• no key provided') + U.c.dim(` — add ${envVar}=… to .env later; System Plan is enabled and will run once the key is present.`));
      }
    }
  }

  const cd = rel === '.' ? '' : `cd ${rel} && `;
  console.log('\n' + U.c.bold('Done.') + ' Next: write/prune specs → ' + U.c.bold(`${cd}yay verify`) + ' → ' + U.c.bold('yay sign') + '.');
}

// Append or update KEY=value in <dir>/.env without disturbing other lines.
function writeEnvVar(dir, key, value) {
  const envPath = path.join(dir, '.env');
  let txt = ''; try { txt = fs.readFileSync(envPath, 'utf8'); } catch (_) {}
  const line = key + '=' + value;
  const re = new RegExp('^' + key + '=.*$', 'm');
  txt = re.test(txt) ? txt.replace(re, line) : (txt + (txt && !txt.endsWith('\n') ? '\n' : '') + line + '\n');
  fs.writeFileSync(envPath, txt, { mode: 0o600 });
}
function ensureGitignored(dir, entry) {
  const gi = path.join(dir, '.gitignore');
  let txt = ''; try { txt = fs.readFileSync(gi, 'utf8'); } catch (_) {}
  if (txt.split(/\r?\n/).some((l) => l.trim() === entry)) return;
  fs.writeFileSync(gi, txt + (txt && !txt.endsWith('\n') ? '\n' : '') + entry + '\n');
}

function cmdGate(flags, positional) {
  const target = path.resolve(positional[0] || process.cwd());
  if (!fs.existsSync(target)) return fail(`no such directory: ${target}`);
  const scope = (flags.scope && flags.scope !== true) ? flags.scope : '';
  const pkg = (flags.pkg && flags.pkg !== true) ? flags.pkg : 'yay-layer';
  // Pin the trust root in CI so a swapped roster fails there too. Default to the
  // current project's root fingerprint if we can read it.
  let root = (flags.root && flags.root !== true) ? flags.root : '';
  if (!root) { try { const d = rosterMod.deriveRoster(U.readJSON(path.join(target, '.yaylayer', 'roster.json'), null) || {}); if (d.rootFp) root = d.rootFp; } catch (_) {} }
  const opts = { force: !!flags.force, scope, pkg, root };

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
  const cMethod = signMethodOf(U.readJSON(U.paths(target).config, null));
  for (const r of writeConstitution(target, resolveKeys(spec), cMethod)) {
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
  if (fs.existsSync(path.join(p.keys, `${name}.keystore`))) return fail(`a local key for "${name}" already exists`);
  const pass = await getPassphrase(flags, `Set a passphrase to encrypt ${name}'s key (you'll re-enter it each time you sign)`);
  if (!pass || pass.length < 6) return fail('passphrase must be at least 6 characters');
  const ksPath = createKey(p, config, name, pass);
  console.log(U.c.green(`✓ key created for "${name}"`));
  console.log('  public key → roster in .yaylayer/config.json');
  console.log('  private key → ' + U.c.dim(path.relative(process.cwd(), ksPath)) + U.c.dim('  (gitignored, encrypted)'));
  console.log(U.c.yellow('\n  ⚠ Local keystore') + U.c.dim(' — this key is a file on THIS machine (passphrase-encrypted). It has no'));
  console.log(U.c.dim('    recovery phrase; if you lose it, keep a 2nd owner key. For a phone key with a'));
  console.log(U.c.dim('    24-word recovery backup that never touches this machine, use ') + U.c.bold('yay pair') + U.c.dim('. Never commit .yaylayer/keys/.'));
}

// ── route phone requests through a RUNNING dashboard (one origin, scan-once) ──
function dashboardReg(p) {
  const d = U.readJSON(path.join(path.dirname(p.config), 'dashboard.json'), null);
  return d && d.port ? d : null;
}
async function dfetch(info, pathname, opts) {
  const base = `${info.scheme}://127.0.0.1:${info.port}`;
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (info.scheme === 'https') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // self-signed localhost
  try { return await fetch(base + pathname, opts); }
  finally { if (info.scheme === 'https') { if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev; } }
}
// → { result, info } from the phone via the dashboard, { busy } if one's in flight,
// or null if there's no live dashboard (caller falls back to the ephemeral server).
async function routeThroughDashboard(p, mode, payload) {
  const info = dashboardReg(p); if (!info) return null;
  let ping; try { ping = await dfetch(info, '/api/ping').then((r) => r.json()); } catch (_) { return null; }
  if (!ping || ping.yay !== 'dashboard') return null;
  const rq = await dfetch(info, '/api/request', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode, ...payload }) });
  if (rq.status === 409) { console.log(U.c.yellow('  a request is already awaiting the phone on the dashboard — finish it first.')); return { busy: true, info }; }
  console.log('\n' + U.c.bold('→ sent to your phone') + U.c.dim(` — approve on the dashboard you already have open (${info.phoneUrl || info.scheme + '://<this-mac>:' + info.port + '/phone'}). Ctrl-C to cancel.`));
  for (;;) {
    let r; try { r = await dfetch(info, '/api/result').then((x) => x.json()); } catch (_) { return null; }
    if (r.gone) { console.log(U.c.red('  the dashboard request was cancelled.')); return null; }
    if (r.result) return { result: r.result, info };
  }
}
async function dashboardFinal(info, final) { try { await dfetch(info, '/api/final', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ final }) }); } catch (_) {} }

// ── route phone requests through the HOSTED relay (relay.yaylayer.com), end-to-end
// encrypted. Chosen when the project's transport is 'relay' (never for plain LAN/local).
// The relay is untrusted: it only shuttles opaque ciphertext, so the laptop verifies
// every answer itself here (the relay can't).
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
function relayBase(flags) {
  return (flags && flags['relay-url'] && flags['relay-url'] !== true) ? String(flags['relay-url']).replace(/\/$/, '')
    : (process.env.YAY_RELAY_URL ? String(process.env.YAY_RELAY_URL).replace(/\/$/, '') : 'https://relay.yaylayer.com');
}
function phoneTransport(config, flags) {
  if (flags && flags.relay) return 'relay';
  if (flags && flags.lan) return 'lan';
  return (config && config.transport === 'relay') ? 'relay' : 'lan';
}
// The relay session (channel + E2E key) persists so the human scans ONCE; later requests
// go to the same channel and appear on the phone page already open. Secret → gitignored.
function ensureRelaySession(p, flags) {
  const regPath = path.join(path.dirname(p.config), 'relay.json');
  let reg = U.readJSON(regPath, null); let fresh = false;
  if (!reg || !reg.channel || !reg.key) {
    reg = { base: relayBase(flags), channel: E2E.newChannel(), key: E2E.b64url(E2E.newKey()), createdAt: new Date().toISOString() };
    U.writeJSON(regPath, reg); ensureGitignored(p.root, '.yaylayer/relay.json'); fresh = true;
  }
  const base = relayBase(flags) !== 'https://relay.yaylayer.com' ? relayBase(flags) : (reg.base || relayBase(flags));
  return { base, channel: reg.channel, keyBytes: E2E.fromB64url(reg.key), url: base + '/#' + reg.channel + '.' + reg.key, fresh };
}
function relayFetch(sess, pathname, opts) {
  opts = opts || {}; opts.headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  return fetch(sess.base + pathname, opts);
}
async function relayFinal(sess, final) { try { await relayFetch(sess, '/api/final', { method: 'POST', body: JSON.stringify({ ch: sess.channel, blob: E2E.seal(sess.keyBytes, final) }) }); } catch (_) {} }
// Verify the phone's decrypted answer exactly as the dashboard's verifySubmit does, so
// callers get the SAME result shape whether they went via LAN or the relay.
function verifyRelayAnswer(mode, wire, b, expectPubs) {
  if (mode === 'pair') {
    const { name, pubB64, proof } = b || {};
    if (!name || !pubB64 || !proof) return { error: 'phone answer missing name/pubB64/proof' };
    if (wire.genesis) {
      const ev = { ...wire.genesis, name: String(name), pub: pubB64, by: String(name) };
      if (!C.verify(U.canonical(ev), proof, pubB64)) return { error: 'genesis self-signature failed' };
      return { result: { name: String(name), pubB64, code: phone.confirmCode(pubB64), genesisEvent: { ...ev, signature: proof } } };
    }
    if (!C.verify(wire.challenge, proof, pubB64)) return { error: 'key possession proof failed' };
    return { result: { name: String(name), pubB64, proof, code: phone.confirmCode(pubB64) } };
  }
  if (!b || !b.signature) return { error: 'phone answer missing signature' };
  let target = wire.approval || wire.event;
  const editedBrief = (b.brief !== undefined && wire.approval && wire.approval.brief);
  if (editedBrief) target = { ...wire.approval, brief: { ...wire.approval.brief, text: String(b.brief) } };
  if (!(expectPubs || []).some((pub) => pub && C.verify(U.canonical(target), b.signature, pub))) return { error: 'the phone signature did not verify against an authorized key' };
  return { result: editedBrief ? { signature: b.signature, brief: String(b.brief) } : { signature: b.signature } };
}
async function routeThroughRelay(p, mode, payload, flags) {
  const sess = ensureRelaySession(p, flags);
  const wire = { mode };
  ['approval', 'event', 'summary', 'challenge', 'genesis', 'project'].forEach((k) => { if (payload[k] !== undefined) wire[k] = payload[k]; });
  try {
    const rq = await relayFetch(sess, '/api/request', { method: 'POST', body: JSON.stringify({ ch: sess.channel, blob: E2E.seal(sess.keyBytes, wire) }) });
    if (!rq.ok) { console.log(U.c.red('  relay rejected the request (HTTP ' + rq.status + ').')); return null; }
  } catch (e) { console.log(U.c.red('  could not reach the relay (' + sess.base + '): ' + (e && e.message || e))); return null; }
  if (sess.fresh) {
    console.log('\n' + U.c.bold('→ scan ONCE to sign on your phone (over the relay):'));
    printQR(sess.url);
    console.log('   ' + U.c.accent(sess.url));
    console.log(U.c.dim('   later requests appear on that page automatically. Ctrl-C to cancel.'));
  } else {
    console.log('\n' + U.c.bold('→ sent to your phone') + U.c.dim(' — approve on the relay page you already have open. Ctrl-C to cancel.'));
  }
  const expectPubs = payload.expectPubB64 || payload.ownerPubs || [];
  for (;;) {
    let r; try { r = await relayFetch(sess, '/api/result?ch=' + encodeURIComponent(sess.channel)).then((x) => x.json()); } catch (_) { await sleepMs(1500); continue; }
    if (r && r.state === 'answered') {
      const b = E2E.open(sess.keyBytes, r.blob);
      if (!b) { console.log(U.c.red('  could not decrypt the phone answer — key mismatch (re-pair to reset the channel).')); return null; }
      const out = verifyRelayAnswer(mode, wire, b, expectPubs);
      if (out.error) { await relayFinal(sess, { ok: false, reason: out.error }); console.log(U.c.red('  ' + out.error + ' — nothing was written.')); return null; }
      return { result: out.result, sess };
    }
    await sleepMs(1500);
  }
}

async function cmdSign(flags) {
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  const name = (flags.name && flags.name !== true) ? flags.name : config.owners[0];
  if (!name || !U.pubKeysOf(config.signers[name]).length) return fail(`unknown signer "${name}" — run \`yay keygen --name ${name || '<you>'}\` or \`yay pair\``);
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
  // BRIEF (Standard §5): a short prose record of what the human ordered, signed
  // together with the specs → attributed + tamper-evident. It is the DEFAULT: a human
  // at a TTY is prompted for it; automation (the AI) passes --brief; --no-brief is
  // the explicit escape for a trivial re-sign. Kept in the approval so canonical(approval)
  // covers it on every signing path.
  let briefText = (flags.brief && flags.brief !== true) ? String(flags.brief).trim()
    : (flags['brief-file'] && flags['brief-file'] !== true && fs.existsSync(flags['brief-file'])) ? fs.readFileSync(flags['brief-file'], 'utf8').trim()
      : '';
  if (!briefText && !flags['no-brief']) {
    if (process.stdin.isTTY) {
      console.log(U.c.accent('▸ ') + U.c.bold('Brief') + U.c.dim(' — in one line, what are you approving here (what you ordered)?'));
      briefText = await ask('  brief: ');
    }
    if (!briefText) return fail('a Brief is required (Standard §5) — pass --brief "<what you ordered>", or --no-brief for a trivial re-sign.');
  }
  if (briefText) approval.brief = { text: briefText, orderedBy: 'human (AI-drafted, human-approved)' };

  // ── Freedom mode ── if an active grant covers ALL target Cells (none sensitive), the
  // machine auto-approves with the grant key — no phone, no passphrase. Queued for ratify.
  if (!flags['no-auto']) {
    const glog = loadGrants(p);
    if (glog && glog.events && glog.events.length) {
      const rlog = loadRoster(p);
      const drv = rosterMod.deriveRoster(rlog || { events: [] });
      const ownerPubs = Object.keys(drv.roles || {}).filter((n) => drv.roles[n] === 'owner').reduce((a, n) => a.concat(drv.roster[n] || []), []);
      const grants = grantsMod.deriveGrants(glog, ownerPubs, lock.approvals);
      const cellsById = {}; Object.keys(items).forEach((id) => { if (manifest.cells[id]) cellsById[id] = manifest.cells[id]; });
      const g = grantsMod.activeGrantFor(grants, Object.keys(items), cellsById);
      if (g) {
        const rec = U.readJSON(grantKeyPath(p, g.id), null);
        if (rec && rec.priv) {
          approval.autoApproved = true; approval.grant = g.id; approval.signer = g.by || config.owners[0] || 'owner';
          approval.signature = C.sign(U.canonical(approval), Buffer.from(rec.priv, 'base64'));
          lock.approvals = lock.approvals || []; lock.approvals.push(approval); U.writeJSON(p.lock, lock);
          console.log(U.c.yellow(`⚡ auto-approved ${Object.keys(items).length} Cell(s)`) + U.c.dim(` under grant ${g.id} — approval ${approval.id} (freedom mode).`));
          if (approval.brief) console.log('  ' + U.c.dim('brief: ') + approval.brief.text);
          const left = g.remaining != null ? Math.max(0, g.remaining - 1) : '∞';
          console.log('  ' + U.c.dim(`delegated, NOT human-reviewed — ratify later with `) + U.c.bold('yay ratify') + U.c.dim(`. ${left} auto-approval(s) left · grant expires ${String(g.expiresAt).slice(0, 16).replace('T', ' ')}.`));
          return;
        }
        console.log(U.c.yellow(`  grant ${g.id} is active but its key is missing on this machine — falling back to a normal signature.`));
      }
    }
  }

  const method = resolveSignMethod(config, p, name, flags);
  if (method === 'phone') {
    // Sign on the paired phone over the LAN — the private key never touches this machine.
    const verified = verifyManifest(manifest, lock, config, { mutate: false });
    const SEALCOLORS = { GREEN: '#1f9d57', YELLOW: '#c9860f', RED: '#cf4436', UNSIGNED: '#7f8796', PINK: '#e0559b' };
    const summary = Object.keys(items).map((id) => {
      const c = manifest.cells[id]; const r = (verified.results[id] || {});
      return {
        id, unit: c.unitName || (c.spec && c.spec.unit) || '', intent: (c.spec && c.spec.intent) || '',
        state: r.state || 'UNSIGNED', color: SEALCOLORS[r.state] || '#7f8796',
        file: c.file || '', line: c.line || 0,
        spec: c.spec || {}, // full parsed spec so the phone can show details on tap
        notes: (r.notes || []).map((nt) => ({ level: nt.level, text: nt.text })),
        diff: specDiffForCell(p.root, c), // what changed vs the last committed spec (null = new/unchanged)
      };
    });
    const pubs = U.pubKeysOf(config.signers[name]);
    if (phoneTransport(config, flags) === 'relay') {
      // Hosted relay (relay.yaylayer.com), end-to-end encrypted. Works off-LAN.
      const routed = await routeThroughRelay(p, 'approve', { approval, summary, expectPubB64: pubs }, flags);
      if (!routed || !routed.result) return; // routeThroughRelay logged why
      if (routed.result.brief !== undefined && approval.brief) approval.brief.text = routed.result.brief; // human edited it on the phone
      approval.signature = routed.result.signature;
      await relayFinal(routed.sess, { ok: true, message: 'Signed ✓ — leave the page open for the next request.' });
    } else {
    // If a dashboard is running, route through it — the request pops up on the phone
    // the human already has open (scan-once). Otherwise spin the one-shot LAN server.
    const routed = await routeThroughDashboard(p, 'approve', { approval, summary, expectPubB64: pubs });
    if (routed && routed.busy) return;
    if (routed && routed.result) {
      if (routed.result.brief !== undefined && approval.brief) approval.brief.text = routed.result.brief; // human edited it on the phone
      approval.signature = routed.result.signature;
      await dashboardFinal(routed.info, { ok: true, message: 'Signed ✓ — you can leave this open for the next request.' });
    } else {
      const tls = tlsCert(p, flags);
      const s = await phone.signOverLan({ project: config.project, approval, summary, expectPubB64: pubs, tls });
      console.log('\n' + U.c.bold('Approve on your phone') + ' — scan with your phone camera (same Wi-Fi):');
      console.log('   ' + U.c.accent(s.url) + U.c.dim('   (or ' + s.local + ' on this computer)'));
      printQR(s.url);
      if (s.fellBack) console.log(U.c.yellow('   ⚠ the preferred phone port was busy (another yay sign/serve running?) — using a different address; your phone may ask to Restore.'));
      if (tls) console.log(U.c.dim('   https: tap through the one-time "not private" warning (Advanced → visit).'));
      console.log(U.c.dim(`   reviewing ${summary.length} change(s) as "${name}" · Ctrl-C to cancel · tip: run \`yay dashboard\` to scan once and skip the QR each time`));
      let r; try { r = await s.done; } finally { s.close(); }
      if (r && r.timedOut) return fail('no approval received in time — nothing was signed. Re-run when ready.');
      if (r && r.brief !== undefined && approval.brief) approval.brief.text = r.brief; // human edited it on the phone
      approval.signature = r.signature;
    }
    }
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
  if (approval.brief) console.log('  ' + U.c.bold('brief: ') + U.c.accent(approval.brief.text));
  console.log('  ' + U.c.dim('seal appended to .yaylayer/lock.json (commit this)'));
}

// Shared pairing flow (used by `yay pair` and by `yay init` when Mobile is chosen).
async function runPairing(p, config, flags) {
  flags = flags || {};
  const nameFlag = (flags.name && flags.name !== true) ? flags.name : null;
  const tls = tlsCert(p, flags);
  // No signed trust root yet? Run PHONE-AS-GENESIS: the phone self-signs the
  // genesis event and becomes the owner/root — no local key is ever created.
  const rlogPre = loadRoster(p);
  const isGenesis = !(rlogPre && rlogPre.events && rlogPre.events.length);
  const genesis = isGenesis
    ? { id: 'R-0001', type: 'genesis', role: 'owner', prev: 'genesis', nonce: C.randomNonce(), at: new Date().toISOString() }
    : null;
  const challenge = C.randomNonce() + C.randomNonce();
  let r, finishPhone, closeServer = () => {};
  if (phoneTransport(config, flags) === 'relay') {
    // Hosted relay (relay.yaylayer.com), end-to-end encrypted.
    const routed = await routeThroughRelay(p, 'pair', { challenge, genesis }, flags);
    if (!routed || !routed.result) return false;
    r = routed.result; finishPhone = (f) => relayFinal(routed.sess, f);
  } else {
  // Route through a running dashboard (one origin, scan-once) if present; else the one-shot LAN server.
  const routed = await routeThroughDashboard(p, 'pair', { challenge, genesis });
  if (routed && routed.busy) return false;
  if (routed && routed.result) {
    r = routed.result;
    finishPhone = (f) => dashboardFinal(routed.info, f);
  } else {
    const s = await phone.pairOverLan({ project: config.project, tls, genesis, challenge });
    console.log('\n' + U.c.bold('Pair your phone') + ' — scan with your phone camera (same Wi-Fi):');
    console.log('   ' + U.c.accent(s.url) + U.c.dim('   (or ' + s.local + ' on this computer)'));
    printQR(s.url);
    if (s.fellBack) console.log(U.c.yellow('   ⚠ the preferred phone port was busy (another yay sign/serve running?) — using a different address; the phone may ask to Restore.'));
    if (tls) console.log(U.c.dim('   https: tap through the one-time "not private" warning (Advanced → visit).'));
    console.log(U.c.dim('   create your key there; it shows a 6-digit code. (Ctrl-C to cancel.)'));
    finishPhone = async (finalMsg) => { s.setFinal(finalMsg); await Promise.race([s.settled, new Promise((res) => setTimeout(res, 8000))]); };
    closeServer = () => s.close();
    r = await s.done;
  }
  }
  try {
    if (r && r.timedOut) { console.log(U.c.red('  pairing timed out — no phone responded.')); return false; }
    const name = nameFlag || r.name;
    console.log('\n  Your phone should show code: ' + U.c.bold(r.code));
    const ans = await ask('  Does it match exactly? (y/N): ');
    if (!/^y/i.test(ans)) {
      console.log(U.c.red('  pairing aborted — code did not match (possible wrong device)'));
      await finishPhone({ ok: false, reason: 'the code did not match on the laptop' });
      return false;
    }

    if (!isGenesis) {
      const rlog = loadRoster(p);
      // A signed trust root exists → the phone key must be authorized by an existing
      // OWNER (signed roster event), or the gate won't trust it.
      const drv = rosterMod.deriveRoster(rlog);
      if ((drv.roster[name] || []).includes(r.pubB64)) {
        console.log(U.c.dim(`  this phone key is already enrolled for "${name}".`));
        await finishPhone({ ok: true, message: 'Already paired — you can close this.' });
        return true;
      }
      const owners = Object.keys(drv.roles).filter((n) => drv.roles[n] === 'owner');
      const byFlag = (flags.by && flags.by !== true) ? flags.by : null;
      const authOwner = (byFlag && fs.existsSync(path.join(p.keys, `${byFlag}.keystore`))) ? byFlag
        : owners.find((n) => fs.existsSync(path.join(p.keys, `${n}.keystore`)));
      if (!authOwner) {
        addSignerKey(config, name, r.pubB64, 'phone'); U.writeJSON(p.config, config);
        console.log(U.c.yellow('  ⚠ phone captured, but NOT enrolled in the signed roster') + U.c.dim(' — no owner key on this machine to authorize it.'));
        console.log('  ' + U.c.dim('From a machine holding an owner key, run: ') + U.c.bold(`yay enroll --name "${name}" --pubkey ${r.pubB64} --phone`));
        await finishPhone({ ok: false, reason: 'no owner on the laptop authorized this phone yet — run yay enroll' });
        return true;
      }
      const pass = await getPassphrase(flags, `Enter ${authOwner}'s passphrase to authorize adding your phone`);
      let priv;
      try { priv = C.decryptKeystore(JSON.parse(fs.readFileSync(path.join(p.keys, `${authOwner}.keystore`), 'utf8')), pass); }
      catch (e) { console.log(U.c.red('  ' + e.message)); await finishPhone({ ok: false, reason: 'the laptop could not unlock the owner key' }); return false; }
      const type = drv.roster[name] ? 'add-key' : 'add-signer';
      const role = drv.roles[name] || (flags.role === 'owner' ? 'owner' : 'signer');
      const ev = { id: rosterMod.nextEventId(rlog), type, name, pub: r.pubB64, role, by: authOwner, prev: rlog.events[rlog.events.length - 1].id, nonce: C.randomNonce(), at: new Date().toISOString() };
      ev.signature = C.sign(rosterMod.eventBytes(ev), priv);
      const test = rosterMod.deriveRoster({ ...rlog, events: rlog.events.concat([ev]) });
      if (test.problems.length) { console.log(U.c.red('  refusing to write — ' + test.problems.join('; '))); await finishPhone({ ok: false, reason: 'the roster event did not validate' }); return false; }
      rlog.events.push(ev);
      U.writeJSON(rosterPath(p), rlog);
      addSignerKey(config, name, r.pubB64, 'phone'); U.writeJSON(p.config, config);
      console.log(U.c.green(`✓ paired "${name}"`) + U.c.dim(` — phone key added to the SIGNED roster (authorized by ${authOwner}). Commit .yaylayer/. Sign with `) + U.c.bold('yay sign --phone') + U.c.dim('.'));
      await finishPhone({ ok: true, message: 'Paired — you can close this. The laptop has your key.' });
      return true;
    }

    // Phone-as-genesis: the phone self-signed the genesis event. Its signature is
    // the trust root; the private key never leaves the phone, and no local key exists.
    const g = r.genesisEvent;
    if (!g || g.pub !== r.pubB64) { console.log(U.c.red('  pairing failed — no valid genesis signature from the phone.')); await finishPhone({ ok: false, reason: 'no valid genesis signature from the phone' }); return false; }
    const check = rosterMod.deriveRoster({ project: config.project, events: [g] });
    if (!check.ok) { console.log(U.c.red('  refusing to establish trust root — ' + check.problems.join('; '))); await finishPhone({ ok: false, reason: 'the genesis event did not validate' }); return false; }
    U.writeJSON(rosterPath(p), { project: config.project, events: [g] });
    addSignerKey(config, name, r.pubB64, 'phone');
    config.devices = config.devices || {}; config.devices[name] = config.devices[name] || {}; config.devices[name].phonePairedAt = new Date().toISOString();
    U.writeJSON(p.config, config);
    console.log('\n' + U.c.green(`✓ trust root established on your phone for "${name}"`) + U.c.dim(' — no local key needed.'));
    console.log('  ' + U.c.dim('root fingerprint → ') + U.c.bold(rosterMod.fingerprint(r.pubB64)) + U.c.dim('  (pin this in CI)'));
    console.log('  ' + U.c.dim('commit ') + U.c.bold('.yaylayer/') + U.c.dim(', then approve change-sets with ') + U.c.bold('yay sign --phone'));
    await finishPhone({ ok: true, message: 'You’re the trust root now — you can close this.' });
    return true;
  } finally { closeServer(); }
}

// Get an OWNER to sign a governance event `ev` (enroll / revoke / reroot).
// Uses a local owner keystore when present, else authorizes on an owner's PHONE
// (so a phone-only owner can manage the roster with no key on this machine).
// Returns the signed `ev`, or null if it couldn't be authorized. `ev.by` is set
// before signing so it's covered by the signature.
async function authorizeRosterEvent(p, config, log, ev, flags, summary) {
  const drv = rosterMod.deriveRoster(log);
  const owners = Object.keys(drv.roles).filter((n) => drv.roles[n] === 'owner');
  if (!owners.length) { console.log(U.c.red('  no owner in the roster to authorize with.')); return null; }
  const byFlag = (flags.by && flags.by !== true) ? flags.by : null;
  if (byFlag && drv.roles[byFlag] !== 'owner') { console.log(U.c.red(`  "${byFlag}" is not an owner.`)); return null; }
  const wantPhone = !!flags.phone;
  const localOwner = wantPhone ? null
    : ((byFlag && fs.existsSync(path.join(p.keys, `${byFlag}.keystore`))) ? byFlag
      : owners.find((n) => fs.existsSync(path.join(p.keys, `${n}.keystore`))));
  if (localOwner) {
    ev.by = localOwner;
    const pass = await getPassphrase(flags, `Enter ${localOwner}'s passphrase to authorize`);
    try { ev.signature = C.sign(rosterMod.eventBytes(ev), C.decryptKeystore(JSON.parse(fs.readFileSync(path.join(p.keys, `${localOwner}.keystore`), 'utf8')), pass)); }
    catch (e) { console.log(U.c.red('  ' + e.message)); return null; }
    return ev;
  }
  // Phone authorization: any current owner's phone can sign the event bytes.
  ev.by = byFlag || owners[0];
  const ownerPubs = owners.reduce((a, n) => a.concat(drv.roster[n] || []), []);
  if (phoneTransport(config, flags) === 'relay') {
    const routed = await routeThroughRelay(p, 'authorize', { event: ev, summary, ownerPubs }, flags);
    if (!routed || !routed.result) return null;
    ev.signature = routed.result.signature; await relayFinal(routed.sess, { ok: true, message: 'Authorized ✓' }); return ev;
  }
  // Route through a running dashboard (one origin) if there is one; else ephemeral.
  const routed = await routeThroughDashboard(p, 'authorize', { event: ev, summary, ownerPubs });
  if (routed && routed.busy) return null;
  if (routed && routed.result) { ev.signature = routed.result.signature; await dashboardFinal(routed.info, { ok: true, message: 'Authorized ✓ — you can leave this open.' }); return ev; }
  const tls = tlsCert(p, flags);
  const s = await phone.authorizeOverLan({ project: config.project, event: ev, summary, ownerPubs, tls });
  console.log('\n' + U.c.bold('Authorize on an owner’s phone') + ' — scan (same Wi-Fi):');
  console.log('   ' + U.c.accent(s.url) + U.c.dim('   (or ' + s.local + ' on this computer)'));
  printQR(s.url);
  if (s.fellBack) console.log(U.c.yellow('   ⚠ the preferred phone port was busy — using a different address; the phone may ask to Restore.'));
  if (tls) console.log(U.c.dim('   https: tap through the one-time "not private" warning.'));
  console.log(U.c.dim('   review the change on the phone and approve. (Ctrl-C to cancel.)'));
  let r; try { r = await s.done; } finally { s.close(); }
  if (r && r.timedOut) { console.log(U.c.red('  authorization timed out — no phone responded.')); return null; }
  ev.signature = r.signature;
  return ev;
}

// ── Freedom mode commands ──────────────────────────────────────────────────
function listGrants(p, config, lock) {
  const glog = loadGrants(p);
  if (!glog || !glog.events.filter((e) => e.type === 'grant').length) { console.log(U.c.dim('no grants issued — start freedom mode with `yay grant --for 2h --count 20`.')); return; }
  const drv = rosterMod.deriveRoster(loadRoster(p) || { events: [] });
  const ownerPubs = Object.keys(drv.roles || {}).filter((n) => drv.roles[n] === 'owner').reduce((a, n) => a.concat(drv.roster[n] || []), []);
  const grants = grantsMod.deriveGrants(glog, ownerPubs, (lock && lock.approvals) || []);
  console.log(U.c.bold('Grants (freedom mode):'));
  for (const id of Object.keys(grants)) {
    const g = grants[id];
    const status = g.active ? U.c.green('● active') : g.revoked ? U.c.red('revoked') : g.expired ? U.c.dim('expired ') : U.c.dim('spent  ');
    console.log('  ' + status + ' ' + U.c.bold(id) + U.c.dim(` · ${g.scope && g.scope.cells ? g.scope.cells.length + ' Cell(s)' : 'non-sensitive'} · ${g.spent}/${g.maxCount || '∞'} used · expires ${String(g.expiresAt).slice(0, 16).replace('T', ' ')}`));
  }
}
async function grantRevoke(p, config, rlog, flags, positional) {
  if (!rlog) return fail('no signed roster — nothing to revoke against.');
  const glog = loadGrants(p);
  const gEvents = (glog && glog.events || []).filter((e) => e.type === 'grant');
  if (!gEvents.length) return fail('no grants to revoke.');
  const target = positional[1] || ((flags.grant && flags.grant !== true) ? flags.grant : gEvents[gEvents.length - 1].id);
  const prev = glog.events[glog.events.length - 1].id;
  const ev = { id: 'GR-' + String(glog.events.length + 1).padStart(3, '0'), type: 'grant-revoke', grant: target, prev, nonce: C.randomNonce(), at: new Date().toISOString() };
  const summary = { title: `Revoke grant ${target} — stop freedom mode`, rows: [{ k: 'revokes', v: target }], warn: 'After this, NO new auto-approvals under this grant are accepted. Auto-approvals already made stay valid but must still be ratified.' };
  const signed = await authorizeRosterEvent(p, config, rlog, ev, flags, summary);
  if (!signed) return;
  glog.events.push(signed); U.writeJSON(grantsPath(p), glog);
  console.log('\n' + U.c.green(`✓ grant ${target} revoked`) + U.c.dim(' — freedom mode off for it. Commit ') + U.c.bold('.yaylayer/grants.json') + U.c.dim('.'));
}
async function cmdGrant(flags, positional) {
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  const sub = positional[0];
  const rlog = loadRoster(p);
  if (sub === 'list' || flags.list) return listGrants(p, config, lock);
  if (sub === 'revoke' || flags.revoke) return grantRevoke(p, config, rlog, flags, positional);
  if (!rlog) return fail('freedom mode needs a signed trust root — pair your phone or run `yay keygen` first.');
  const durMs = parseDuration((flags.for && flags.for !== true) ? flags.for : '2h');
  if (!durMs) return fail('bad --for duration — use e.g. 2h, 90m, 1d.');
  const count = (flags.count && flags.count !== true) ? parseInt(flags.count, 10) : 20;
  if (!(count > 0)) return fail('--count must be a positive number.');
  const scope = (flags.cell && flags.cell !== true) ? { cells: String(flags.cell).split(',').map((s) => s.trim()).filter(Boolean) } : {};
  const gk = C.generateKeypair();
  const glog = loadGrants(p) || { project: config.project, events: [] };
  const id = 'G-' + String(glog.events.filter((e) => e.type === 'grant').length + 1).padStart(3, '0');
  const prev = glog.events.length ? glog.events[glog.events.length - 1].id : 'genesis';
  const expiresAt = new Date(Date.now() + durMs).toISOString();
  const ev = { id, type: 'grant', grantPub: gk.pubB64, scope, expiresAt, maxCount: count, prev, nonce: C.randomNonce(), at: new Date().toISOString() };
  const scopeStr = scope.cells ? `${scope.cells.length} named Cell(s)` : 'all non-sensitive Cells';
  const summary = { title: 'Grant FREEDOM MODE (auto-approval)', rows: [
    { k: 'scope', v: scopeStr }, { k: 'expires', v: expiresAt.slice(0, 16).replace('T', ' ') }, { k: 'max', v: `${count} auto-approvals` },
  ], warn: 'While active, the AI auto-approves in-scope changes WITHOUT contacting your phone. Sensitive / code-pinned Cells still need a real signature. Stop anytime with `yay grant revoke`.' };
  const signed = await authorizeRosterEvent(p, config, rlog, ev, flags, summary);
  if (!signed) return; // authorizeRosterEvent already reported why
  glog.events.push(signed); U.writeJSON(grantsPath(p), glog);
  fs.mkdirSync(p.keys, { recursive: true });
  U.writeJSON(grantKeyPath(p, id), { pub: gk.pubB64, priv: Buffer.from(gk.privDer).toString('base64') });
  console.log('\n' + U.c.green(`✓ freedom mode ON — grant ${id}`) + U.c.dim(` (${scopeStr}; until ${expiresAt.slice(0, 16).replace('T', ' ')} or ${count} approvals).`));
  console.log('  ' + U.c.dim('the AI now auto-approves in-scope change-sets with no phone contact. Commit ') + U.c.bold('.yaylayer/grants.json') + U.c.dim(' (key stays in gitignored keys/).'));
  console.log('  ' + U.c.dim('ratify later with ') + U.c.bold('yay ratify') + U.c.dim(' · stop with ') + U.c.bold('yay grant revoke') + U.c.dim(' · check with ') + U.c.bold('yay grant list') + U.c.dim('.'));
}
async function cmdRatify(flags) {
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  const manifest = buildManifest(flags.dir || p.root);
  const verified = verifyManifest(manifest, lock, config, { mutate: false, roster: loadRoster(p), grants: loadGrants(p), root: trustRootPin(flags) });
  const auto = Object.keys(verified.results).filter((id) => verified.results[id].trust && verified.results[id].trust.auto);
  if (!auto.length) { console.log(U.c.green('✓ nothing to ratify') + U.c.dim(' — no auto-approved Cells awaiting your signature.')); return; }
  console.log(U.c.bold(`${auto.length} auto-approved Cell(s) awaiting ratification:`));
  for (const id of auto) { const r = verified.results[id]; const c = manifest.cells[id]; console.log('  ' + U.c.yellow('⚡ ') + id + U.c.dim(` · ${(c && c.unitName) || ''} · grant ${r.trust.grant}`)); }
  if (!flags.sign && !flags.yes) {
    console.log('\n' + U.c.dim('review these, then ratify (sign them for real) with ') + U.c.bold('yay ratify --sign') + U.c.dim(' — or leave them delegated.'));
    return;
  }
  // Ratify = a normal HUMAN signature over exactly these Cells (never auto again).
  flags.cell = auto.join(','); flags['no-auto'] = true;
  if (!flags.brief) flags.brief = 'Ratify delegated (auto-approved) changes';
  return cmdSign(flags);
}

async function cmdPair(flags) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const ok = await runPairing(p, config, flags);
  if (ok) console.log('  ' + U.c.dim('now approve change-sets with ') + U.c.bold('yay sign --phone'));
}

// Enroll another signer — an OWNER-signed event, so the AI (which lacks an owner
// key) can never add a signer by editing files. (Owner authorizes with their local
// key here; phone-authorized enrollment is the next increment.)
async function cmdEnroll(flags) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const log = loadRoster(p);
  if (!log) return fail('no signed roster yet — create the first key (`yay init` / `yay keygen`) to establish the trust root, then enroll others.');
  const name = (flags.name && flags.name !== true) ? flags.name : null;
  const pub = (flags.pubkey && flags.pubkey !== true) ? flags.pubkey : ((flags.pub && flags.pub !== true) ? flags.pub : null);
  if (!name || !pub) return fail('usage: yay enroll --name "Alice Carlsen" --pubkey <base64> [--role owner|signer] [--phone]');
  const role = flags.role === 'owner' ? 'owner' : 'signer';
  const drv = rosterMod.deriveRoster(log);
  const type = drv.roster[name] ? 'add-key' : 'add-signer';
  const ev = { id: rosterMod.nextEventId(log), type, name, pub, role, by: null, prev: log.events[log.events.length - 1].id, nonce: C.randomNonce(), at: new Date().toISOString() };
  const summary = {
    title: (type === 'add-key' ? `Add another key for "${name}" in ` : `Add ${role} "${name}" to `) + config.project + '?',
    rows: [{ k: name + ' · ' + role, v: 'key ' + rosterMod.fingerprint(pub) }],
    warn: role === 'owner' ? 'Owner rights: they can enroll and revoke signers.' : '',
  };
  const signed = await authorizeRosterEvent(p, config, log, ev, flags, summary);
  if (!signed) return;
  const test = rosterMod.deriveRoster({ ...log, events: log.events.concat([signed]) });
  if (test.problems.length) return fail('refusing to write — event would not authorize: ' + test.problems.join('; '));
  log.events.push(signed);
  U.writeJSON(rosterPath(p), log);
  addSignerKey(config, name, pub, role === 'owner' ? 'owner' : 'signer'); // mirror for convenience
  U.writeJSON(p.config, config);
  console.log(U.c.green(`✓ enrolled "${name}" as ${role}`) + U.c.dim(` (authorized by ${signed.by}) — commit .yaylayer/roster.json`));
}

async function cmdRevoke(flags) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const log = loadRoster(p);
  if (!log || !log.events || !log.events.length) return fail('no signed roster to revoke from');
  const name = (flags.name && flags.name !== true) ? flags.name : null;
  if (!name) return fail('usage: yay revoke --name "Alice" [--pubkey <base64>] [--phone]   (omit --pubkey to remove the whole identity)');
  const drv = rosterMod.deriveRoster(log);
  if (!drv.roster[name]) return fail(`"${name}" is not in the roster`);
  const pub = (flags.pubkey && flags.pubkey !== true) ? flags.pubkey : ((flags.pub && flags.pub !== true) ? flags.pub : null);
  if (pub && !drv.roster[name].includes(pub)) return fail(`that key is not one of ${name}'s keys`);

  // Early lockout check: never leave the project with zero owner keys.
  const simRoster = {}, simRoles = {};
  for (const nm of Object.keys(drv.roster)) simRoster[nm] = drv.roster[nm].slice();
  Object.assign(simRoles, drv.roles);
  if (pub) { simRoster[name] = simRoster[name].filter((k) => k !== pub); if (!simRoster[name].length) { delete simRoster[name]; delete simRoles[name]; } }
  else { delete simRoster[name]; delete simRoles[name]; }
  const ownerKeysLeft = Object.keys(simRoles).filter((nm) => simRoles[nm] === 'owner').reduce((a, nm) => a + (simRoster[nm] || []).length, 0);
  if (!ownerKeysLeft) return fail('refusing — that would leave the roster with NO owner key (governance lockout). Enroll another owner first, then revoke.');

  const ev = pub
    ? { id: rosterMod.nextEventId(log), type: 'revoke-key', name, pub, by: null, prev: log.events[log.events.length - 1].id, nonce: C.randomNonce(), at: new Date().toISOString() }
    : { id: rosterMod.nextEventId(log), type: 'remove-signer', name, by: null, prev: log.events[log.events.length - 1].id, nonce: C.randomNonce(), at: new Date().toISOString() };
  const summary = pub
    ? { title: `Revoke a key of "${name}" in ${config.project}?`, rows: [{ k: name, v: 'key ' + rosterMod.fingerprint(pub) }], warn: 'That key can no longer sign after this. Past approvals stay attributed.' }
    : { title: `Remove signer "${name}" from ${config.project}?`, rows: [{ k: name, v: drv.roster[name].length + ' key(s)' }], warn: 'All of their keys lose signing rights. Past approvals stay attributed.' };
  const signed = await authorizeRosterEvent(p, config, log, ev, flags, summary);
  if (!signed) return;
  const test = rosterMod.deriveRoster({ ...log, events: log.events.concat([signed]) });
  if (test.problems.length) return fail('refusing to write — ' + test.problems.join('; '));
  log.events.push(signed);
  U.writeJSON(rosterPath(p), log);
  // Mirror into config for display (best-effort).
  if (config.signers && config.signers[name]) {
    if (pub) { config.signers[name] = U.pubKeysOf(config.signers[name]).filter((k) => k !== pub).map((k) => ({ pub: k })); if (!config.signers[name].length) { delete config.signers[name]; if (config.owners) config.owners = config.owners.filter((o) => o !== name); } }
    else { delete config.signers[name]; if (config.owners) config.owners = config.owners.filter((o) => o !== name); }
    U.writeJSON(p.config, config);
  }
  console.log(U.c.green(`✓ ${pub ? 'revoked a key of' : 'removed'} "${name}"`) + U.c.dim(` (authorized by ${signed.by}) — commit .yaylayer/roster.json. Update CI if you pinned this key.`));
}

async function cmdReroot(flags) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const log = loadRoster(p);
  const oldFp = (log && log.events && log.events.length) ? rosterMod.deriveRoster(log).rootFp : null;
  console.log(U.c.yellow('⚠ Re-root') + ' establishes a BRAND-NEW trust root and retires the current one.');
  console.log(U.c.dim('  This is a trust DISCONTINUITY: signers under the old root are dropped, the CI'));
  console.log(U.c.dim('  --root pin must be repointed, and existing specs must be re-signed under the new'));
  console.log(U.c.dim('  key. Use it only when the old root key is lost or compromised.'));
  if (oldFp) console.log(U.c.dim('  current root → ') + U.c.bold(oldFp));
  if (!flags.force) {
    const ans = await ask('  Type "reroot" to confirm: ');
    if ((ans || '').trim() !== 'reroot') return console.log('  aborted — nothing changed.');
  }
  // Archive the old roster + reset the config mirror; the new genesis re-populates it.
  if (log) { U.writeJSON(rosterPath(p).replace(/\.json$/, `.${oldFp || 'old'}.json`), log); fs.unlinkSync(rosterPath(p)); }
  config.signers = {}; config.owners = []; U.writeJSON(p.config, config);
  console.log('\n' + U.c.bold('Establish the new trust root:'));
  if (flags.phone || flags.key === 'mobile') {
    await runPairing(p, config, flags); // no roster now → phone-as-genesis
  } else {
    const name = (flags.name && flags.name !== true) ? flags.name : (process.stdin.isTTY ? await ask('  New owner name: ') : 'you');
    const pass = await getPassphrase(flags, `Set a passphrase for the new owner key "${name}"`);
    if (!pass || pass.length < 6) return fail('passphrase must be at least 6 characters — no new root created (old one archived).');
    createKey(p, config, name, pass);
    console.log(U.c.green(`✓ new local owner key for "${name}"`));
  }
  console.log('\n' + U.c.bold('Next:') + U.c.dim(' re-sign specs under the new root ') + U.c.bold('yay sign --all') + U.c.dim(', then repoint CI ') + U.c.bold('yay gate') + U.c.dim(' (new fingerprint above).'));
  if (oldFp) console.log(U.c.dim('  old roster archived → .yaylayer/roster.' + oldFp + '.json'));
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
  // Legibility: green ≠ proven. Show how many green Cells are machine-proven vs only signed.
  if (c.GREEN) console.log('  ' + U.c.dim('of green: ') + U.c.green(`${c.proven || 0} machine-proven`) + U.c.dim(' · ') +
    (c.unproven ? U.c.yellow(`${c.unproven} signed but unproven`) + U.c.dim(' — strengthen these `ensures` (they carry a promise nothing checks)') : U.c.dim('0 unproven')));
  if (c.PINK) console.log('  ' + U.c.pink(`◆ ${c.PINK} unspecified code section(s) — never described or signed. Run `) + U.c.bold('yay adopt') + U.c.pink('.'));
}

function cmdVerify(flags) {
  const { p, config, lock } = loadState();
  const manifest = buildManifest(flags.dir || p.root);
  if (!Object.keys(manifest.cells).length && !manifest.problems.length && !(manifest.untracked || []).length) {
    console.log(U.c.dim('no code found. Write a spec block (see README/STANDARD), or run `yay adopt`.')); return;
  }
  const verified = verifyManifest(manifest, lock, config, { mutate: !flags['no-mutate'], roster: loadRoster(p), grants: loadGrants(p), root: trustRootPin(flags) });
  printReport(manifest, verified, !!(flags.details || flags.d), !!(flags.problems || flags.issues || flags.p));
  if (verified.signedRoster) console.log('  ' + U.c.dim('trust root ' + verified.rootFp));
  else console.log('  ' + U.c.yellow('⚠ roster is unsigned') + U.c.dim(' — no signed trust root; run `yay init`/`yay keygen` to establish one.'));
  for (const pb of verified.rosterProblems || []) console.log('  ' + U.c.red('✗ roster: ') + pb);
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

// Shared System-Plan (re)generation — used by `yay plan` and the dashboard button.
// Costly (an LLM call), so it only runs when explicitly invoked. Returns a result
// object rather than exiting, so the dashboard can report it.
async function regeneratePlan(p, config, lock, flags) {
  const auth = resolvePlanAuth(config, flags);
  if (auth.error) return { ok: false, error: auth.error };
  const manifest = buildManifest(flags.dir || p.root);
  if (!Object.keys(manifest.cells).length) return { ok: false, error: 'no Cells to plan yet — write/adopt some specs first.' };
  const verified = verifyManifest(manifest, lock, config, { mutate: false, roster: loadRoster(p), grants: loadGrants(p), root: trustRootPin(flags) });
  const digest = plan.buildDigest(manifest, config.project);
  let result;
  try { result = await plan.synthesize(digest, auth); }
  catch (e) { return { ok: false, error: 'plan synthesis failed: ' + e.message }; }
  U.writeJSON(path.join(path.dirname(p.config), 'plan.json'), { provider: auth.provider, model: auth.model, at: new Date().toISOString(), digestHash: C.sha256(U.canonical(digest)), counts: verified.counts, ...result });
  return { ok: true, provider: auth.provider, model: auth.model, subsystems: (result.subsystems || []).length };
}

async function cmdPlan(flags) {
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  const auth = resolvePlanAuth(config, flags);
  if (auth.error) return fail(auth.error + ' (each user brings their own key.)');
  console.log(U.c.dim(`synthesizing system plan with ${auth.provider}/${auth.model}${auth.baseUrl ? ' @ ' + auth.baseUrl : ''} …`));
  const r = await regeneratePlan(p, config, lock, flags);
  if (!r.ok) return fail(r.error);
  console.log(U.c.green('✓ system plan written → .yaylayer/plan.json') + U.c.dim(`  (${r.subsystems} subsystem(s))`));
  console.log('  ' + U.c.dim('view it in ') + U.c.bold('yay map') + U.c.dim(' (System Plan tab) or the dashboard. Re-run `yay plan` to refresh.'));
}

// Synthesize the plan into plan.json if enabled & specs changed. Never throws —
// a missing key / network error just skips the plan and leaves the map intact.
async function maybePlanForMap(p, config, manifest, verified, flags) {
  if (!(config && config.plan && config.plan.enabled) || flags['no-plan']) return;
  if (!Object.keys(manifest.cells).length) return;
  const planFile = path.join(path.dirname(p.config), 'plan.json');
  const auth = resolvePlanAuth(config, flags);
  if (auth.error) { console.log(U.c.yellow('• System Plan skipped: ') + U.c.dim(auth.error)); return; }
  const digest = plan.buildDigest(manifest, config.project);
  const hash = C.sha256(U.canonical(digest));
  const cached = U.readJSON(planFile, null);
  if (cached && cached.digestHash === hash && !flags.replan) { console.log(U.c.dim('• System Plan up to date (specs unchanged).')); return; }
  console.log(U.c.dim(`synthesizing System Plan with ${auth.provider}/${auth.model} …`));
  try {
    const result = await plan.synthesize(digest, auth);
    U.writeJSON(planFile, { provider: auth.provider, model: auth.model, at: new Date().toISOString(), digestHash: hash, counts: verified.counts, ...result });
    console.log('  ' + U.c.green('✓ System Plan updated'));
  } catch (e) { console.log(U.c.yellow('• System Plan skipped: ') + U.c.dim(e.message)); }
}

// Build the full tabbed map HTML from the CURRENT repo state. Reused by `yay map`
// (static export) and by `yay dashboard` (live). Reads the cached plan.json — it
// never regenerates the plan (that costs an LLM call; only `yay map`/`yay plan` do).
function buildMapHTML(p, config, lock, flags) {
  const manifest = buildManifest(flags.dir || p.root);
  // Per-Cell spec diff vs last commit, so each Cell's detail can show what changed there.
  for (const id of Object.keys(manifest.cells)) { manifest.cells[id].diff = specDiffForCell(p.root, manifest.cells[id]); }
  const verified = verifyManifest(manifest, lock, config, { mutate: !flags['no-mutate'], roster: loadRoster(p), grants: loadGrants(p), root: trustRootPin(flags) });
  const { changes, times } = cellChanges(manifest.root, lock, manifest.cells);
  const planDoc = flags['no-plan'] ? null : U.readJSON(path.join(path.dirname(p.config), 'plan.json'), null);
  // governance for the Signers tab: authoritative roster + device kind + approvals.
  const rlog = loadRoster(p);
  const drv = rosterMod.deriveRoster(rlog || { events: [] }, { root: trustRootPin(flags) });
  const cfgSigners = (config && config.signers) || {};
  const kindByPub = {};
  for (const n of Object.keys(cfgSigners)) { const e = cfgSigners[n]; if (Array.isArray(e)) e.forEach((k) => { if (k && k.pub) kindByPub[k.pub] = { kind: k.kind, addedAt: k.addedAt }; }); }
  const approvalsBy = {}; for (const a of (lock.approvals || [])) approvalsBy[a.signer] = (approvalsBy[a.signer] || 0) + 1;
  const rosterNames = Object.keys(drv.roster);
  const signers = (rosterNames.length ? rosterNames : Object.keys(cfgSigners)).sort().map((name) => {
    const pubs = drv.roster[name] || U.pubKeysOf(cfgSigners[name]);
    return { name, role: drv.roles[name] || 'signer', approvals: approvalsBy[name] || 0,
      keys: pubs.map((pub) => ({ fp: rosterMod.fingerprint(pub), kind: (kindByPub[pub] && kindByPub[pub].kind) || '', addedAt: (kindByPub[pub] && kindByPub[pub].addedAt) || null })) };
  });
  const gov = { signedRoster: !!(rlog && rlog.events && rlog.events.length), rootFp: drv.rootFp, problems: drv.problems, signers };
  // Briefs ledger (Standard §5): every approval that carries a brief, newest first.
  // Each brief's seal is re-verified here so the ledger can flag a tampered/forged one.
  const briefs = (lock.approvals || []).filter((a) => a.brief && a.brief.text).map((a) => {
    const b = a.brief;
    const { signature, ...rest } = a;
    const trustedPubs = (drv.roster && drv.roster[a.signer]) || U.pubKeysOf(cfgSigners[a.signer]) || [];
    let valid = false;
    try { valid = !!signature && trustedPubs.some((pub) => pub && C.verify(U.canonical(rest), signature, pub)); } catch (_) { valid = false; }
    return { id: a.id, at: a.at, signer: a.signer, text: b.text, orderedBy: (b.orderedBy || ''), cells: Object.keys(a.items || {}), valid };
  }).reverse();
  return { html: renderMap(manifest, verified, config && config.project, changes, times, planDoc, gov, briefs), count: Object.keys(verified.results).length };
}

// A cheap fingerprint of the state the map depends on, so the dashboard can tell
// the page "something changed, reload" without rebuilding the whole map each poll.
function stateVersion(p) {
  const parts = [];
  const dir = path.dirname(p.config);
  for (const f of ['config.json', 'lock.json', 'roster.json', 'plan.json']) {
    try { parts.push(f + ':' + fs.statSync(path.join(dir, f)).mtimeMs); } catch (_) { parts.push(f + ':0'); }
  }
  try { for (const f of U.walk(p.root)) { if (/\.(js|ts|jsx|tsx|py|css|html)$/.test(f) && !f.includes('.yaylayer')) parts.push(f + ':' + fs.statSync(f).mtimeMs); } } catch (_) {}
  return C.sha256(parts.join('|')).slice(0, 16);
}

// `yay adversary` — spec-only adversarial testing: an LLM sees ONLY each Cell's spec
// (never the code) and writes probes that try to break it, run against the real code.
async function cmdAdversary(flags) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const auth = resolvePlanAuth(config, flags);
  if (auth.error) return fail(auth.error + ' — the adversary needs an LLM (each user brings their own key).');
  const manifest = buildManifest(flags.dir || p.root);
  const only = (flags.cell && flags.cell !== true) ? String(flags.cell).split(',').map((s) => s.trim()) : null;
  const ids = Object.keys(manifest.cells).filter((id) => advEligible(manifest.cells[id]) && (!only || only.includes(id)));
  if (!ids.length) return fail('no eligible Cells — need a leaf Cell with a runnable unit and an ensures/out/throws promise.');
  console.log(U.c.dim(`spec-only adversary (${auth.provider}/${auth.model}) — writing probes from the specs ALONE, then running them against ${ids.length} Cell(s)…`));
  const res = await adversaryManifest(manifest, auth, { cells: only });
  let broke = 0, survived = 0, skipped = 0;
  for (const id of Object.keys(res).sort()) {
    const r = res[id], name = (manifest.cells[id].unitName || '');
    if (r.status === 'broke') { broke++; console.log('  ' + U.c.red('✗ ' + id) + U.c.dim(' ' + name) + ' — ' + U.c.red('BROKE: ') + r.counterexample); }
    else if (r.status === 'survived') { survived++; console.log('  ' + U.c.green('✓ ' + id) + U.c.dim(' ' + name + ' — survived adversarial probing')); }
    else { skipped++; console.log('  ' + U.c.yellow('– ' + id) + U.c.dim(' ' + name + ' — ' + (r.reason || r.status))); }
  }
  console.log('\n  ' + (broke ? U.c.red(broke + ' broke') : U.c.green('0 broke')) + U.c.dim(` · ${survived} survived · ${skipped} skipped`));
  console.log('  ' + U.c.dim('probes were written from the spec only — a break is a real spec↔code violation, not a code echo.'));
  if (broke) process.exitCode = 1;
}

// `yay test` — run the project's own test suite (package.json "test" / config.test /
// --test). Exit non-zero on failure so CI and the gate can use it.
async function cmdTest(flags) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const cmd = resolveTestCmd(p.root, config, flags);
  if (!cmd) return fail('no test command — add a "test" script to package.json, set "test" in .yaylayer/config.json, or pass --test "…".');
  console.log(U.c.dim('running: ') + cmd);
  const r = await runTests(p.root, cmd);
  if (r.output) process.stdout.write(r.output.replace(/\n?$/, '\n'));
  console.log(r.ok ? U.c.green(`✓ tests passed`) + U.c.dim(` (${r.ms} ms)`) : U.c.red(`✗ tests failed — exit ${r.code}`));
  if (!r.ok) process.exitCode = 1;
}

// `yay dashboard` — a persistent live control panel (map that auto-refreshes).
// Leave it running; re-reads the repo on every load so it always shows current state.
async function cmdDashboard(flags) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const port = (flags.port && flags.port !== true) ? Number(flags.port) : (Number(process.env.YAY_DASHBOARD_PORT) || 48757);
  const tls = tlsCert(p, flags);
  // The cert the phone should install to trust this dashboard: the mkcert ROOT CA
  // (so any yay project is trusted), or — for a self-signed run — the leaf cert itself.
  let caPem = null, caFilename = null;
  if (tls && tls.trusted && tls.caRoot) {
    try { caPem = fs.readFileSync(path.join(tls.caRoot, 'rootCA.pem'), 'utf8'); caFilename = 'yaylayer-rootCA.crt'; } catch (_) {}
  } else if (tls) { caPem = tls.cert; caFilename = 'yaylayer-cert.crt'; }
  let s;
  try {
    s = await dashboardMod.startDashboard({
      buildMapHTML: () => { const st = loadState(); return buildMapHTML(st.p, st.config, st.lock, flags); },
      version: () => stateVersion(p),
      testInfo: () => { const st = loadState(); return { configured: !!resolveTestCmd(st.p.root, st.config, flags), cmd: resolveTestCmd(st.p.root, st.config, flags) }; },
      runTests: () => { const st = loadState(); return runTests(st.p.root, resolveTestCmd(st.p.root, st.config, flags)); },
      regenPlan: () => { const st = loadState(); return regeneratePlan(st.p, st.config, st.lock, flags); },
      diffs: () => {
        const st = loadState();
        const m = buildManifest(flags.dir || st.p.root);
        const out = [];
        for (const id of Object.keys(m.cells)) {
          const c = m.cells[id];
          const d = specDiffForCell(st.p.root, c);
          if (d && d.length) out.push({ id, unit: c.unitName || '', file: c.file, diff: d });
        }
        return out;
      },
      adversary: async () => {
        const st = loadState();
        const auth = resolvePlanAuth(st.config, flags);
        if (auth.error) return { error: auth.error };
        const m = buildManifest(flags.dir || st.p.root);
        const res = await adversaryManifest(m, auth);
        return { results: Object.keys(res).map((id) => ({ id, unit: (m.cells[id].unitName || ''), ...res[id] })) };
      },
      // Human-initiated sign from the dashboard: run `yay sign --brief "…"` as a child,
      // which discovers THIS dashboard (via .yaylayer/dashboard.json) and routes the request
      // to the phone. Reuses the whole sign path (brief, verify summary, seal-writing).
      signPending: (brief) => new Promise((resolve) => {
        const child = require('child_process').spawn(process.execPath, [process.argv[1], 'sign', '--brief', brief], { cwd: p.root });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
        child.on('exit', (code) => resolve(code === 0
          ? { ok: true, output: out.replace(/\x1b\[[0-9;]*m/g, '').trim() }
          : { ok: false, error: (out.replace(/\x1b\[[0-9;]*m/g, '').trim() || ('sign exited ' + code)) }));
      }),
    }, { port, tls, caPem, caFilename });
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') return fail(`port ${port} is already in use — a dashboard may already be running (open http://localhost:${port}), or pass --port.`);
    return fail(e.message || String(e));
  }
  // Register so the CLI (yay sign/pair/…) can find this dashboard and route through it.
  const regPath = path.join(path.dirname(p.config), 'dashboard.json');
  U.writeJSON(regPath, { scheme: tls ? 'https' : 'http', port: s.port, phoneUrl: s.url + '/phone', startedAt: new Date().toISOString() });
  ensureGitignored(p.root, '.yaylayer/dashboard.json');
  const cleanup = () => { try { fs.unlinkSync(regPath); } catch (_) {} };
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('exit', cleanup);

  console.log('\n' + U.c.green('✓ yay dashboard is live') + U.c.dim(' — keep this running; scan ONCE, then approvals appear here automatically.'));
  console.log('   ' + U.c.bold('this computer → ') + U.c.accent(s.local) + U.c.dim('   (the live map + buttons)'));
  console.log('   ' + U.c.bold('phone → ') + U.c.accent(s.url + '/phone') + U.c.dim('   (scan the QR below — same Wi-Fi as this computer)'));
  printQR(s.url + '/phone');
  if (tls && tls.trusted) {
    console.log(U.c.dim('   https: ') + U.c.green('locally-trusted cert (mkcert)') + U.c.dim(' — no warning on this computer.'));
    if (caPem) console.log(U.c.dim('   phone warning-free (one-time): open ') + U.c.accent(s.url + '/trust') + U.c.dim(' on the phone → install + trust the certificate (guided).'));
  } else if (tls) {
    console.log(U.c.dim('   https: self-signed (encrypted) — tap through the one-time "not private" warning on the phone (Advanced → visit).'));
    if (caPem) console.log(U.c.dim('   or make it warning-free: open ') + U.c.accent(s.url + '/trust') + U.c.dim(' on the phone; better still ') + U.c.accent('brew install mkcert && mkcert -install') + U.c.dim(' then restart.'));
  }
  const tc = resolveTestCmd(p.root, config, flags);
  console.log('   ' + U.c.dim('buttons (this computer): ') + U.c.bold('▶ Run tests') + U.c.dim(tc ? ` (${tc})` : ' (none)') + U.c.dim(' · ') + U.c.bold('⚔ Adversary') + U.c.dim(' · ') + U.c.bold('⟲ System Plan') + U.c.dim(' · ') + U.c.bold('≷ Changes'));
  console.log('   ' + U.c.dim('`yay sign` now routes here — the request pops up on your phone. Ctrl-C to stop.'));
  if (flags.open) { try { require('child_process').exec((process.platform === 'darwin' ? 'open ' : 'xdg-open ') + JSON.stringify(s.local)); } catch (_) {} }
  await new Promise(() => {}); // run until Ctrl-C
}

async function cmdMap(flags) {
  const { p, config, lock } = loadState();
  const manifest = buildManifest(flags.dir || p.root);
  const verified = verifyManifest(manifest, lock, config, { mutate: !flags['no-mutate'], roster: loadRoster(p), grants: loadGrants(p), root: trustRootPin(flags) });
  await maybePlanForMap(p, config, manifest, verified, flags);
  const { html, count } = buildMapHTML(p, config, lock, flags);
  const out = (flags.o && flags.o !== true) ? flags.o : (flags.out && flags.out !== true ? flags.out : 'yay-layer-map.html');
  fs.writeFileSync(out, html);
  console.log(U.c.green('✓ map written → ') + out + U.c.dim(`  (${count} items)`));
}

function cmdAdopt(flags, positional) {
  const target = positional[0] || '.';
  const res = adopt(target, { dry: !!flags.dry });
  if (!res.total) { console.log(U.c.dim('nothing to adopt — no un-tagged top-level functions found.')); return; }
  console.log((res.dry ? U.c.yellow('(dry run) ') : U.c.green('✓ ')) + `${res.total} draft Cell(s) across ${res.report.length} file(s):`);
  for (const r of res.report) console.log('  ' + U.c.dim(r.file) + '  +' + r.added);
  console.log('\n  Next: prune each DERIVED spec, then ' + U.c.bold('yay sign') + '.');
}

function cmdStatus(flags) {
  flags = flags || {};
  const { p, config, lock } = loadState();
  if (!config) return console.log(U.c.dim('not initialized — run `yay init`'));
  const manifest = buildManifest(p.root);
  const verified = verifyManifest(manifest, lock, config, { mutate: false, roster: loadRoster(p), grants: loadGrants(p), root: trustRootPin(flags) });
  const c = verified.counts;
  console.log(U.c.bold(config.project) + U.c.dim(`  · ${Object.keys(manifest.cells).length} Cells · ${Object.keys(config.signers).length} signer(s)`));
  console.log('  ' + U.c.green(`${c.GREEN}●`) + ' ' + U.c.yellow(`${c.YELLOW}●`) + ' ' + U.c.red(`${c.RED}●`) + ' ' + U.c.gray(`${c.UNSIGNED}○`) + '  ' + (verified.passed ? U.c.green('PASS') : U.c.red('BLOCKED')));
}

function fail(msg) { console.error(U.c.red('error: ') + msg); process.exitCode = 1; }

const HELP = `yay — a protocol for provable, signed AI code

  yay init [dir]              guided setup: files → signing key → adopt → instruct your AI
                             signing key: local · mobile over your LAN · mobile over relay.yaylayer.com (--relay, for off-LAN; E2E)
                             flags: --project <name> --key local|mobile [--relay|--lan] --name <you> --adopt|--no-adopt --constitution <keys|all>
                             --plan|--no-plan --provider anthropic|openai|custom [--base-url url] [--model m] --api-key <k>
  yay constitution --for <k> write the Constitution where an AI harness auto-reads it
                             (--for claude,agents,cursor,copilot,windsurf,cline,gemini,generic | all · --list)
  yay keygen --name <you>     create your signing key
  yay adopt [path] [--dry]    scaffold draft specs over existing code
  yay pair [--name you]      pair your phone as the signer (key stays on the phone; scan the QR) · SSL on by default (--no-https)
                             --relay routes via relay.yaylayer.com (off-LAN, end-to-end encrypted) · --lan forces the local path
                             the FIRST pairing makes the phone the trust root — no local key needed
  yay enroll --name X --pubkey <b64>  enroll another signer via an OWNER-signed event (--role owner|signer)
                             authorize with a local owner key, or --phone to approve on an owner's phone
  yay revoke --name X [--pubkey <b64>]  revoke one key (or the whole identity) via an owner-signed event (--phone)
  yay reroot [--phone]        retire the current trust root and establish a new one (key lost/compromised)
  yay grant [--for 2h] [--count 20]  FREEDOM MODE: owner-signed grant → the AI auto-approves in-scope,
                             non-sensitive Cells unattended (no phone) until it expires. --cell to narrow scope.
                             yay grant list · yay grant revoke [id] (stop it) · sensitive/code-pinned always need a real sign
  yay ratify [--sign]        list auto-approved (delegated) Cells; --sign signs them for real (human)
  yay sign [--cell IDs]       approve specs using THIS project's method (phone or local) — no flag needed
                             override with --phone / --local · SSL on by default (--no-https) · --cell to sign a subset
                             a Brief is required by default (Standard §5): --brief "<what you ordered>" supplies it
                             (editable on the phone) · you're prompted if omitted at a terminal · --no-brief skips a trivial re-sign
  yay verify [--strict] [-d]  the gate — paint every Cell; -d/--details prints each spec, code & checks
                             --problems shows only non-green Cells · --no-mutate skips prover mutation grading
  yay plan [--provider anthropic|openai|custom] [--model m] [--base-url url]
                             AI-synthesize a high-level System Plan → .yaylayer/plan.json
                             key from .env (ANTHROPIC_API_KEY / OPENAI_API_KEY); custom = any OpenAI-compatible
                             endpoint via --base-url (Ollama/LM Studio/vLLM/local — key optional)
  yay map [-o file.html]      write the HTML flowchart (default: yay-layer-map.html)
                             if plan generation is enabled it regenerates the System Plan; --no-plan skips it, --replan forces it
  yay dashboard [--port N]    live control panel: map + auto-refresh + Run-tests & Regenerate-plan buttons (leave running; --open, SSL on by default: --no-https)
  yay test [--test "cmd"]     run the project's own test suite (package.json "test" / config.test); non-zero exit on failure
  yay adversary [--cell IDs]  spec-only adversary: an LLM sees ONLY the specs and writes probes to break the code (needs an LLM key)
  yay gate [dir]              write the CI gate workflow (+ --hook local pre-push) & print the
                             branch-protection steps · flags: --scope <dir> --pkg <spec> --hook --force
  yay status                  one-line summary

  docs: standard/STANDARD.md · CONSTITUTION.md · README.md`;

async function main() {
  loadDotenv();
  const [, , cmd, ...rest] = process.argv;
  const { flags, positional } = args(rest);
  switch (cmd) {
    case 'init': return cmdInit(flags, positional);
    case 'keygen': return cmdKeygen(flags);
    case 'sign': return cmdSign(flags);
    case 'pair': return cmdPair(flags);
    case 'enroll': return cmdEnroll(flags);
    case 'revoke': return cmdRevoke(flags);
    case 'reroot': return cmdReroot(flags);
    case 'grant': case 'freedom': return cmdGrant(flags, positional);
    case 'ratify': return cmdRatify(flags);
    case 'verify': case 'check': return cmdVerify(flags);
    case 'map': return cmdMap(flags);
    case 'dashboard': case 'serve': return cmdDashboard(flags);
    case 'test': case 'tests': return cmdTest(flags);
    case 'adversary': case 'adversarial': return cmdAdversary(flags);
    case 'plan': return cmdPlan(flags);
    case 'adopt': return cmdAdopt(flags, positional);
    case 'constitution': case 'rules': return cmdConstitution(flags, positional);
    case 'gate': case 'ci': return cmdGate(flags, positional);
    case 'status': return cmdStatus(flags);
    case undefined: case 'help': case '--help': case '-h': return console.log(HELP);
    default: console.error(U.c.red(`unknown command: ${cmd}`)); console.log(HELP); process.exitCode = 1;
  }
}
// Exit explicitly once the command resolves — routed HTTP calls (undici keep-alive)
// and a ref'd stdin from prompts can otherwise keep the process alive after we're
// done. `yay dashboard` never resolves (runs until Ctrl-C), so it's unaffected.
main().then(
  () => process.exit(process.exitCode || 0),
  (e) => { console.error(U.c.red('error: ') + (e && e.message || e)); process.exit(1); },
);
