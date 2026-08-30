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
const R = require('../src/ratify');
const O = require('../src/objects');
const A = require('../src/attest');
const CAP = require('../src/capability');
const AS = require('../src/assurance');
const D = require('../src/durable');
const F = require('../src/foundation');
const { buildManifest } = require('../src/manifest');
const { verifyManifest } = require('../src/verify');
const { renderMap } = require('../src/map');
const { adopt } = require('../src/adopt');
const IDS = require('../src/ids');
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
const policyMod = require('../src/policy');
const tagsMod = require('../src/tags');

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
// Who THIS machine signs as (recorded at pair/keygen). Machine-local + gitignored — it
// differs per person, so it must never be committed. Lets `yay sign` default to the
// local signer instead of the project owner (config.owners[0]).
function localPath(p) { return path.join(path.dirname(p.config), 'local.json'); }
function loadLocalSigner(p) { const d = U.readJSON(localPath(p), null); return d && d.signer ? d.signer : null; }
function saveLocalSigner(p, name) { try { if (name) { const d = U.readJSON(localPath(p), null) || {}; d.signer = name; U.writeJSON(localPath(p), d); ensureGitignored(p.root, '.yaylayer/local.json'); } } catch (_) {} }
// This working copy's Cell-id SHARD. Lives in gitignored local.json (never committed) so every clone
// gets its OWN shard → new ids from different clones never collide on merge. First 2 hex encode the
// local signer's identity (when known), last 2 are per-copy random. Created lazily, then stable.
function ensureLocalShard(p) {
  const d = U.readJSON(localPath(p), null) || {};
  if (d.idShard) return d.idShard;
  let idPart = null;
  try { const cfg = U.readJSON(p.config, null) || {}; const first = Object.values(cfg.signers || {})[0]; const pub = first && (first.pub || first); if (pub) idPart = IDS.deriveShard(pub).slice(0, 2); } catch (_) {}
  d.idShard = (idPart || IDS.deriveShard(null).slice(0, 2)) + IDS.deriveShard(null).slice(0, 2);
  try { U.writeJSON(localPath(p), d); ensureGitignored(p.root, '.yaylayer/local.json'); } catch (_) {}
  return d.idShard;
}
// Every Cell id the ledger has ever recorded (signed) — so a deleted-but-once-signed id is retired forever.
function ledgerCellIds(p) {
  const lock = U.readJSON(p.lock, null); const out = [];
  if (lock && Array.isArray(lock.approvals)) for (const ap of lock.approvals) { if (ap && ap.items) for (const k of Object.keys(ap.items)) out.push(k); }
  return out;
}
// Autopilot: the append-only, owner-signed grants log (committed) + the machine-held
// grant private keys (in the gitignored keys/, used for UNATTENDED auto-signing).
function grantsPath(p) { return path.join(path.dirname(p.config), 'grants.json'); }
function rejectionsPath(p) { return path.join(path.dirname(p.config), 'rejections.json'); }
function loadGrants(p) { return U.readJSON(grantsPath(p), null); }
function grantKeyPath(p, id) { return path.join(p.keys, `grant-${id}.json`); }
function parseDuration(s) {
  const m = String(s).trim().match(/^(\d+)\s*([smhd])$/i);
  if (!m) return null;
  const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2].toLowerCase()];
  return Number(m[1]) * mult;
}
// Stamp a Cell's SOURCE (a `//∷YAY-DELEGATED⟨id⟩` comment ABOVE its opening marker, so it never
// touches the spec block / specHash) to mark it delegated (Autopilot), and remove it on ratify.
// So the file itself says "delegated, awaiting ratification" — visible in the code, not just the seal.
function stampAutoCell(p, cell, grant) {
  try {
    const abs = path.join(p.root, cell.file);
    if (!fs.existsSync(abs)) return;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const idRe = cell.id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    const openRe = new RegExp('∷YAY⟨\\s*' + idRe + '\\s*⟩');
    const autoRe = new RegExp('∷YAY-DELEGATED⟨\\s*' + idRe + '\\s*⟩');
    const i = lines.findIndex((l) => openRe.test(l));
    if (i < 0) return;
    const indent = (lines[i].match(/^\s*/) || [''])[0];
    const stamp = indent + '//∷YAY-DELEGATED⟨' + cell.id + '⟩ delegated · grant ' + grant + ' · awaiting ratification — run `yay ratify`';
    if (i > 0 && autoRe.test(lines[i - 1])) lines[i - 1] = stamp; else lines.splice(i, 0, stamp);
    fs.writeFileSync(abs, lines.join('\n'));
  } catch (_) { /* best effort — the seal in lock.json is the source of truth */ }
}
function unstampAutoCell(p, cell) {
  try {
    const abs = path.join(p.root, cell.file);
    if (!fs.existsSync(abs)) return;
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    const idRe = cell.id.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
    const autoRe = new RegExp('∷YAY-DELEGATED⟨\\s*' + idRe + '\\s*⟩');
    const i = lines.findIndex((l) => autoRe.test(l));
    if (i >= 0) { lines.splice(i, 1); fs.writeFileSync(abs, lines.join('\n')); }
  } catch (_) { /* best effort */ }
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

function createKey(p, config, name, pass, genesisMeta) {
  const { pubB64, privDer } = C.generateKeypair();
  const ks = C.encryptKeystore(privDer, pass);
  fs.mkdirSync(p.keys, { recursive: true });
  const ksPath = path.join(p.keys, `${name}.keystore`);
  fs.writeFileSync(ksPath, JSON.stringify(ks, null, 2) + '\n', { mode: 0o600 });
  addSignerKey(config, name, pubB64, 'local');
  U.writeJSON(p.config, config);
  // Establish the signed trust root on the very first key (genesis, self-signed). When this
  // genesis is the result of a reroot, genesisMeta stamps the rotation INTO the signed event
  // (supersedes/rerootedAt/rerootReason) so the audit shows a reroot happened, and why.
  const rp = rosterPath(p);
  if (!fs.existsSync(rp)) {
    const ev = { id: 'R-0001', type: 'genesis', name, pub: pubB64, role: 'owner', by: name, prev: 'genesis', nonce: C.randomNonce(), at: new Date().toISOString(), ...(genesisMeta || {}) };
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
    // Provenance mode (D10): Standard (default; specs/attestations kept, bulk source via git) vs
    // Durable (also keeps an encrypted, sha256-anchored archive of signed source). Switchable later
    // with `yay archive enable|disable`.
    if (flags.durable) config.provenance = { mode: 'durable' };
    U.writeJSON(p.config, config);
    U.writeJSON(p.lock, { project, approvals: [] });
    fs.mkdirSync(p.keys, { recursive: true });
    ensureLedgerMergeAttrs(target); // append-only ledgers auto-merge instead of conflicting
    console.log(U.c.green('✓ initialized YayLayer') + ` for "${project}"` + (rel === '.' ? '' : U.c.dim(` in ${rel}/`)));
    console.log('  ' + U.c.dim(`config + lock → ${path.join(rel, '.yaylayer')}/ (commit these) · keys → gitignored`));
  }

  // 2 ── signing key
  let keyChoice = (typeof flags.key === 'string') ? flags.key.toLowerCase() : null;
  if (!keyChoice) {
    if (tty && !Object.keys(config.signers).length) {
      console.log('\n' + U.c.bold('Signing key') + ' — you need one to approve (sign) specs.');
      console.log('  ' + U.c.bold('1') + ') Local ' + U.c.yellow('(least secure)') + U.c.dim(' — key stored on this machine, passphrase-encrypted; signs on the same box as the AI'));
      console.log('  ' + U.c.bold('2') + ') Mobile, LAN ' + U.c.dim('— key lives only on your phone; phone ⇄ laptop directly over your Wi-Fi (private, no server); what you see is what you sign'));
      console.log('  ' + U.c.bold('3') + ') Mobile, relay ' + U.c.green('(recommended)') + U.c.dim(' — same as LAN but via relay.yaylayer.com so it works off your LAN (end-to-end encrypted; the relay never sees your code); what you see is what you sign'));
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

  // This working copy's collision-free Cell-id shard (now that any local key exists to flavour it).
  const myShard = ensureLocalShard(p);

  // 3 ── adopt existing code
  let doAdopt = flags.adopt ? true : (flags['no-adopt'] ? false : null);
  if (doAdopt === null) {
    doAdopt = tty ? /^y/i.test(await ask('\nDoes this project already have code to bring under YayLayer? Run `adopt` now? (y/N): ')) : false;
  }
  if (doAdopt) {
    const res = adopt(target, { dry: false, shard: ensureLocalShard(p), ledgerIds: ledgerCellIds(p) });
    if (!res.total) console.log(U.c.dim('• adopt: no un-tagged top-level functions found.'));
    else {
      console.log(U.c.green(`✓ adopt: scaffolded ${res.total} draft Cell(s) across ${res.report.length} file(s)`));
      console.log(U.c.dim('  each is DERIVED + unsigned — prune them, then `yay sign`.'));
    }
  }

  // 3.5 ── Brief tags: a project vocabulary so what you build can be sorted by concern.
  let tagChoice = (typeof flags.tags === 'string') ? flags.tags.toLowerCase() : null;
  if (!tagChoice && !tagsMod.loadTags(p)) {
    if (tty) {
      console.log('\n' + U.c.bold('Brief tags') + U.c.dim(' — a small vocabulary every Brief is tagged with, so you can later sort what you built by concern + time. Pick a starter set:'));
      tagsMod.TAG_SETS.forEach((s, i) => console.log('  ' + U.c.bold(String(i + 1)) + ') ' + s.name.padEnd(22) + U.c.dim(s.desc)));
      const customN = tagsMod.TAG_SETS.length + 1;
      console.log('  ' + U.c.bold(String(customN)) + ') ' + 'Custom'.padEnd(22) + U.c.dim('blank placeholders (Custom 1–4) you relabel yourself later'));
      console.log('  ' + U.c.dim('(switch sets, relabel, or add your own anytime with `yay tags` or the dashboard)'));
      const ans = (await ask(`  Choose 1–${customN}, or Enter to skip tagging: `)).trim();
      const idx = parseInt(ans, 10);
      tagChoice = (idx >= 1 && idx <= tagsMod.TAG_SETS.length) ? tagsMod.TAG_SETS[idx - 1].id : (idx === customN ? 'custom' : 'none');
    } else tagChoice = 'none';
  }
  if (tagChoice && tagChoice !== 'none' && !tagsMod.loadTags(p)) {
    if (tagChoice === 'custom') {
      tagsMod.saveTags(p, { project: config.project, set: 'custom', tags: tagsMod.CUSTOM_SEED.slice(), descriptions: {} });
      console.log(U.c.green('✓ tags: custom placeholders') + U.c.dim(' (Custom 1–4) → .yaylayer/tags.json. Relabel them in the dashboard Tags tab, `yay tags rename`, or the file.'));
    } else {
      const set = tagsMod.setById(tagChoice);
      if (!set) console.log(U.c.yellow(`  unknown tag set "${tagChoice}" — skipping (options: ${tagsMod.TAG_SETS.map((s) => s.id).join(', ')}, custom).`));
      else {
        tagsMod.saveTags(p, { project: config.project, set: set.id, tags: set.tags.slice() });
        console.log(U.c.green(`✓ tags: "${set.name}"`) + U.c.dim(` (${set.tags.length} tags) → .yaylayer/tags.json (commit this). Edit with `) + U.c.bold('yay tags') + U.c.dim('.'));
      }
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

  // 5 ── optional: configure the project's AI (needs an API key). One provider powers ALL the AI
  //      features — the System Plan overview, the Ask assistant, and the spec-only adversary.
  let planAns = flags.plan ? 'y' : (flags['no-plan'] ? 'n' : null);
  if (planAns === null && tty) {
    console.log('\n' + U.c.bold('Your project AI') + U.c.dim(' — one provider that powers every AI feature: the System Plan overview, the'));
    console.log('  ' + U.c.dim('Ask assistant (query your repo + the manual), and the spec-only adversary.'));
    console.log('  ' + U.c.dim('It calls an LLM, so it needs your own API key (stored in .env, gitignored). You can add or change it later.'));
    planAns = /^y/i.test((await ask('  Configure your project AI now (System Plan, Ask, adversary)? (y/N): ')) || 'n') ? 'y' : 'n';
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
      console.log('  ' + U.c.green('✓ custom provider set') + U.c.dim(` → ${baseUrl || '(no URL yet)'} · model ${plan.model} · powers System Plan, Ask & adversary.`));
    } else {
      const envVar = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
      let key = (flags['api-key'] && flags['api-key'] !== true) ? flags['api-key'] : (process.env[envVar] || '');
      if (!key && tty) key = (await promptHidden(`  Paste your ${envVar} (hidden, stored in .env): `)).trim();
      plan.model = provider === 'anthropic' ? 'claude-sonnet-5' : 'gpt-4o';
      config.plan = plan; U.writeJSON(p.config, config);
      if (key) {
        writeEnvVar(target, envVar, key); ensureGitignored(target, '.env');
        console.log('  ' + U.c.green(`✓ ${envVar} saved to .env`) + U.c.dim(' (gitignored) · powers System Plan, Ask & adversary.'));
      } else {
        console.log('  ' + U.c.yellow('• no key provided') + U.c.dim(` — add ${envVar}=… to .env later; the System Plan, Ask and adversary run once the key is present.`));
      }
    }
  }

  // 6 ── Foundation seal posture: reveal tampering/corruption of the fixed core (secure by default).
  await foundationPosturePrompt(p, config, flags, tty);

  const cd = rel === '.' ? '' : `cd ${rel} && `;
  console.log('\n' + U.c.bold('Done.') + ' Next: write/prune specs → ' + U.c.bold(`${cd}yay verify`) + ' → ' + U.c.bold('yay sign') + '.');
}

// Ask (or take from flags) the foundation-seal posture at init/adopt, and seal now when there's
// already committed content to vouch for. Default GUARDED (reveal-not-block). Never fatal.
async function foundationPosturePrompt(p, config, flags, tty) {
  try {
    if (config && config.foundation) return; // already chosen (re-init)
    let mode = (flags['foundation'] && flags['foundation'] !== true) ? String(flags['foundation']).toLowerCase()
      : (flags['no-foundation'] ? 'off' : null);
    if (!mode && tty) {
      console.log('\n' + U.c.bold('Foundation seal') + U.c.dim(' — reveal any change to your project\'s FIXED core (Constitution, CI workflow, .gitignore, protocol files) so tampering or corruption never goes unnoticed. Ordinary code is unaffected.'));
      console.log('  ' + U.c.dim('[1] Guarded (recommended) — drift warns   [2] Strict — drift blocks the gate   [3] Off'));
      const a = (await ask('  Choose 1, 2 or 3 (Enter = Guarded): ')).trim();
      mode = a === '3' ? 'off' : a === '2' ? 'strict' : 'guarded';
    }
    if (!mode) mode = 'guarded';
    if (mode === 'off') { console.log('  ' + U.c.dim('• foundation seal off — enable later with `yay protect`.')); return; }
    const tracked = trackedFiles(p.root);
    if (!tracked || !tracked.length) {
      console.log('  ' + U.c.yellow(`• foundation posture: ${mode}`) + U.c.dim(' — commit your core files, then run `yay protect` to create the seal.'));
      return;
    }
    // There is committed content to vouch for — seal it now (owner-signed).
    const rlog = loadRoster(p);
    if (!rlog || !rlog.events || !rlog.events.length) { console.log('  ' + U.c.dim('• run `yay protect` to seal once a trust root exists.')); return; }
    const seal = F.buildSeal(p.root, tracked, {});
    const ev = { id: rosterMod.nextEventId(rlog), type: 'foundation', mode, seal, prev: rlog.events[rlog.events.length - 1].id, nonce: C.randomNonce(), at: new Date().toISOString() };
    const summary = { title: 'Seal the project foundation', rows: [{ k: 'mode', v: mode }, { k: 'files', v: Object.keys(seal.files).length + ' core file(s)' }], warn: 'You are vouching the current fixed-core files are correct; later changes are revealed at verify.' };
    const signed = await authorizeRosterEvent(p, config, rlog, ev, flags, summary);
    if (!signed) { console.log('  ' + U.c.yellow(`• foundation posture: ${mode}`) + U.c.dim(' — not signed now; run `yay protect` to seal.')); return; }
    rlog.events.push(signed); U.writeJSON(rosterPath(p), rlog);
    config.foundation = mode; U.writeJSON(p.config, config);
    console.log('  ' + U.c.green(`✓ foundation sealed (${mode})`) + U.c.dim(` — ${Object.keys(seal.files).length} core file(s) watched.`));
  } catch (e) { console.log('  ' + U.c.dim('• foundation seal skipped: ' + (e && e.message || e) + ' — run `yay protect` later.')); }
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
// Make the append-only ledgers auto-merge (git's built-in `union` driver) instead of textually
// conflicting. Per-cell trust is matched by specHash (order-independent), so a unioned lock.json
// verifies fine; the roster is a chained governance log and is left to merge deliberately. Returns
// true if anything was added. Idempotent.
function ensureLedgerMergeAttrs(root) {
  const ga = path.join(root, '.gitattributes');
  let txt = ''; try { txt = fs.readFileSync(ga, 'utf8'); } catch (_) {}
  const want = ['.yaylayer/lock.json merge=union', '.yaylayer/attest.json merge=union', '.yaylayer/rejections.json merge=union'];
  let changed = false;
  for (const l of want) { if (!txt.split(/\r?\n/).some((x) => x.trim() === l)) { txt += (txt && !txt.endsWith('\n') ? '\n' : '') + l + '\n'; changed = true; } }
  if (changed) fs.writeFileSync(ga, txt);
  return changed;
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
  const platform = gate.normPlatform((flags.for && flags.for !== true) ? flags.for : (flags.platform && flags.platform !== true ? flags.platform : 'github'));
  const opts = { force: !!flags.force, scope, pkg, root, platform };
  console.log('  ' + U.c.dim('platform: ') + U.c.bold(platform) + U.c.dim(` (change with --for github|azure|gitlab|bitbucket|gitea|gerrit)`));

  const w = gate.writeWorkflow(target, opts);
  const wmark = w.action === 'skipped' ? U.c.dim('• skipped (exists — use --force) ') : U.c.green('✓ ' + w.action + ' ');
  console.log('  ' + wmark + w.path);
  for (const ex of (w.extra || [])) {
    const em = ex.action === 'skipped' ? U.c.dim('• skipped (exists — use --force) ') : U.c.green('✓ ' + ex.action + ' ');
    console.log('  ' + em + ex.path);
  }
  if (ensureLedgerMergeAttrs(target)) console.log('  ' + U.c.green('✓ .gitattributes') + U.c.dim(' — ledgers set to auto-merge (union). Commit it.'));

  if (flags.hook) {
    const h = gate.writeHook(target, opts);
    if (h.action === 'no-git') console.log('  ' + U.c.yellow('• pre-push hook: not a git repo (run `git init` first)'));
    else if (h.action === 'skipped') console.log('  ' + U.c.dim('• pre-push hook skipped (exists — use --force)'));
    else console.log('  ' + U.c.green('✓ created ') + h.path + U.c.dim('  (local feedback; bypass with git push --no-verify)'));
  }

  if (pkg === 'yay-layer') console.log('\n' + U.c.dim('note: yay-layer isn\'t on npm yet — until it is, use ') + U.c.bold('yay gate --pkg github:jonas-developer/yay-layer') + U.c.dim(' or edit the install line.'));
  console.log('\n' + gate.branchProtectionSteps(platform));
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
  saveLocalSigner(p, name); // this machine now signs as "name" by default
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
  // Send back (§5): an approval declined on the phone, with an optional note and/or corrected tags.
  if (mode === 'approve' && b && b.rejected) return { result: { rejected: true, reason: String(b.reason || '').trim(), tags: Array.isArray(b.tags) ? b.tags : undefined } };
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
  ['approval', 'event', 'summary', 'challenge', 'genesis', 'project', 'signer', 'signerPubs'].forEach((k) => { if (payload[k] !== undefined) wire[k] = payload[k]; });
  try {
    const rq = await relayFetch(sess, '/api/request', { method: 'POST', body: JSON.stringify({ ch: sess.channel, blob: E2E.seal(sess.keyBytes, wire) }) });
    if (rq.status === 409) { const j = await rq.json().catch(() => ({})); console.log(U.c.yellow('  ' + (j.error || 'a request is already awaiting approval on this phone — finish or cancel it first.'))); return null; }
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

// The per-Cell summary the phone shows (state colour, intent, spec, spec-diff).
function signSummary(p, config, lock, manifest, items) {
  const verified = verifyManifest(manifest, lock, config, { mutate: false });
  const SEALCOLORS = { GREEN: '#1f9d57', YELLOW: '#c9860f', RED: '#cf4436', UNSIGNED: '#7f8796', PINK: '#e0559b' };
  return Object.keys(items).map((id) => {
    const c = manifest.cells[id]; const r = (verified.results[id] || {});
    const auto = !!(r.trust && r.trust.auto);
    return {
      id, unit: c.unitName || (c.spec && c.spec.unit) || '', intent: (c.spec && c.spec.intent) || '',
      state: r.state || 'UNSIGNED', color: SEALCOLORS[r.state] || '#7f8796',
      file: c.file || '', line: c.line || 0, spec: c.spec || {},
      // WYSIWYS: the EXACT normalized spec bytes whose sha256 IS the signed specHash. The phone
      // recomputes sha256(block) and refuses to sign unless it equals approval.items[id] — so a
      // compromised laptop can't show one spec and bind the signature to another.
      block: c.specBlock || '',
      notes: (r.notes || []).map((nt) => ({ level: nt.level, text: nt.text })),
      diff: specDiffForCell(p.root, c),
      // Ratification only: the code ALREADY exists (built unattended under a grant), so show
      // it for review. Normal forward-signing has no code yet, so this stays undefined there.
      auto, grant: auto ? (r.trust.grant || null) : null, code: auto ? (c.unitBody || '') : null,
    };
  });
}
const pendingDir = (p) => path.join(path.dirname(p.config), 'pending');
const requestsPath = (p) => path.join(path.dirname(p.config), 'requests.json');

// `yay requests` — the AI's inbox of plain human requests queued from the dashboard's
// "Request a change" button. Each is a normal request to turn into a polished Brief + Cells.
function cmdRequests(flags, positional) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const rp = requestsPath(p);
  const log = U.readJSON(rp, null) || { project: config.project, requests: [] };
  const reqs = log.requests || [];
  const sub = positional[0];
  if (sub === 'done' || sub === 'clear') {
    const id = positional[1];
    const before = reqs.length;
    log.requests = (id && id !== 'all') ? reqs.filter((r) => r.id !== id) : [];
    U.writeJSON(rp, log);
    console.log(U.c.green(`✓ cleared ${before - log.requests.length} request(s).`));
    return;
  }
  const pending = reqs.filter((r) => r.status !== 'done');
  if (!pending.length) { console.log(U.c.dim('no pending requests. (The dashboard "Request a change" button queues them here.)')); return; }
  console.log(U.c.bold(`Pending requests (${pending.length})`) + U.c.dim(' — queued from the dashboard:'));
  for (const r of pending) {
    console.log('  ' + U.c.accent(r.id) + U.c.dim(' · ' + String(r.at).slice(0, 16).replace('T', ' ')));
    console.log('    ' + r.text);
  }
  console.log('\n' + U.c.dim('AI: treat each as a normal request — draft a polished Brief + Cells and present it for signing,'));
  console.log(U.c.dim('    then run ') + U.c.bold('yay requests done <id>') + U.c.dim(' once it is signed (or folded into a change-set).'));
}

// The signer can Accept, or Send back (with an optional note) — never silently reword the
// Brief on the phone (a Brief change must pull its Cells with it, and the phone can't do
// that). This prints the send-back for the AI reading the CLI output, encoding how to act.
function reportSendBack(result, name) {
  if (!result || !result.rejected) return false;
  const note = (result.reason && String(result.reason).trim()) || '';
  const tags = Array.isArray(result.tags) ? result.tags.filter(Boolean) : null;
  console.log('\n' + U.c.yellow(`↩ ${name} sent it back — NOT signed.`));
  if (tags && tags.length) {
    console.log('  ' + U.c.bold('corrected tags: ') + U.c.accent(tags.join(', ')));
    console.log('  ' + U.c.dim('re-issue the Brief with these tags: ') + U.c.bold(`yay sign --tags "${tags.join(',')}"`) + U.c.dim(' — then re-present. (If a new tag reveals a different concern, consider splitting the Brief.)'));
  }
  if (note) {
    console.log('  ' + U.c.bold('their note: ') + U.c.accent(note));
    console.log('  ' + U.c.dim('Reconcile the whole change-set per this note — the Brief and its Cells move together: a small'));
    console.log('  ' + U.c.dim('correction → adjust the affected Cell spec(s) + Brief and re-present for approval; a fundamental'));
    console.log('  ' + U.c.dim('one → treat it as a new request and rebuild the change-set from scratch. Then sign again.'));
  } else if (!(tags && tags.length)) {
    console.log('  ' + U.c.dim('No note was given — do NOT guess. Ask the human in chat how to proceed before changing anything.'));
  }
  return true;
}

// Cross-signer delegation: seal the request to the target's INBOX (over the relay) and
// return a request id. Fire-and-return — the Cells stay Unsigned until they approve;
// collect their signature later with `yay sign --check`.
async function sendToInbox(p, config, lock, manifest, items, approval, name, flags) {
  const targetPub = U.pubKeysOf(config.signers[name])[0];
  if (!targetPub) return fail(`no key on record for "${name}" — is that signer enrolled?`);
  const summary = signSummary(p, config, lock, manifest, items);
  const reqId = E2E.newChannel();                 // url-safe id (also unguessable)
  const replyKey = E2E.b64url(E2E.newKey());       // symmetric key for the sealed reply
  const wire = { mode: 'approve', approval, summary, tagPool: (tagsMod.loadTags(p) || { tags: [] }).tags, project: config.project, signer: name, signerPubs: U.pubKeysOf(config.signers[name]), replyKey };
  const sealed = E2E.sealTo(targetPub, wire);      // only `name` can open it
  const inbox = E2E.inboxChannel(targetPub);
  const base = relayBase(flags);
  try {
    const r = await fetch(base + '/api/inbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ch: inbox, id: reqId, blob: sealed }) });
    if (r.status === 429) return fail(`${name}'s inbox is full — they have too many pending requests. Try again later.`);
    if (!r.ok) return fail('the relay rejected the request (HTTP ' + r.status + ').');
  } catch (e) { return fail('could not reach the relay (' + base + '): ' + ((e && e.message) || e)); }
  const dir = pendingDir(p); fs.mkdirSync(dir, { recursive: true });
  U.writeJSON(path.join(dir, reqId + '.json'), { id: reqId, name, inbox, replyKey, approval, cells: Object.keys(items), at: new Date().toISOString() });
  ensureGitignored(p.root, '.yaylayer/pending/');
  console.log('\n' + U.c.green(`→ sent to ${name}'s inbox`) + U.c.dim(` — request ${reqId}. Pending their approval (fire-and-return).`));
  console.log(U.c.dim(`   the ${Object.keys(items).length} Cell(s) stay Unsigned — the gate blocks them — until ${name} signs.`));
  console.log(U.c.dim('   collect it later with ') + U.c.bold(`yay sign --check ${reqId}`) + U.c.dim(' (or ') + U.c.bold('yay sign --check') + U.c.dim(' for all pending).'));
}

// Collect the reply to one (or all) pending cross-signer requests and write the seal.
async function cmdSignCheck(flags, positional) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const dir = pendingDir(p);
  const target = (positional && positional[0]) || (flags.check && flags.check !== true ? flags.check : null);
  let ids;
  if (target) ids = [target];
  else { try { ids = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)); } catch (_) { ids = []; } }
  if (!ids.length) { console.log(U.c.dim('no pending cross-signer requests.')); return; }
  const base = relayBase(flags);
  for (const id of ids) {
    const pend = U.readJSON(path.join(dir, id + '.json'), null);
    if (!pend) { console.log(U.c.yellow(`  ${id}: no local record — skipping.`)); continue; }
    let resp; try { resp = await fetch(base + '/api/inbox?ch=' + encodeURIComponent(pend.inbox) + '&id=' + encodeURIComponent(id)).then((r) => r.json()); }
    catch (e) { console.log(U.c.red(`  ${id}: relay unreachable (${(e && e.message) || e}).`)); continue; }
    if (!resp || resp.pending || !resp.reply) { console.log(U.c.dim(`  ${id} (${pend.name}): still pending their approval.`)); continue; }
    const ans = E2E.open(E2E.fromB64url(pend.replyKey), resp.reply);
    if (!ans) { console.log(U.c.red(`  ${id}: could not decrypt the reply (key mismatch).`)); continue; }
    if (ans.rejected) {
      fs.unlinkSync(path.join(dir, id + '.json'));
      try { await fetch(base + '/api/inbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ch: pend.inbox, id, remove: true }) }); } catch (_) {}
      reportSendBack(ans, pend.name); continue;
    }
    const approval = pend.approval;
    if (ans.brief !== undefined && approval.brief) approval.brief.text = String(ans.brief);
    const pubs = U.pubKeysOf(config.signers[pend.name]);
    if (!ans.signature || !pubs.some((pub) => C.verify(U.canonical(approval), ans.signature, pub))) { console.log(U.c.red(`  ${id}: signature did not verify against ${pend.name}'s key — NOT written.`)); continue; }
    approval.signature = ans.signature;
    const st = loadState(); st.lock.approvals = st.lock.approvals || []; st.lock.approvals.push(approval); U.writeJSON(st.p.lock, st.lock);
    try { fs.unlinkSync(path.join(dir, id + '.json')); } catch (_) {}
    try { await fetch(base + '/api/inbox', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ch: pend.inbox, id, remove: true }) }); } catch (_) {}
    console.log(U.c.green(`  ✓ ${pend.name} signed`) + U.c.dim(` — seal ${approval.id} written (${(pend.cells || []).length} Cell(s)). Commit .yaylayer/lock.json.`));
  }
}

// `yay inbox` — print YOUR on-duty relay link. Leave it open on your phone to receive
// requests others address to you with `yay sign --name "<you>"`.
function cmdInbox(flags) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const me = loadLocalSigner(p) || config.owners[0];
  const pub = U.pubKeysOf(config.signers[me])[0];
  if (!pub) return fail(`no key for "${me}" on this machine — run \`yay pair\` first.`);
  const url = relayBase(flags) + '/#inbox=' + encodeURIComponent(pub);
  console.log('\n' + U.c.green(`✓ your inbox — ${me}`) + U.c.dim(' — open on your phone and leave it on-duty:'));
  console.log('   ' + U.c.accent(url));
  printQR(url);
  console.log(U.c.dim('   requests others address to you (') + U.c.bold('yay sign --name "' + me + '"') + U.c.dim(') appear here; approve them like any sign.'));
}

// Local signing is a terminal action, so bring the phone's "see what you're signing" moment to the CLI:
// print each Cell + its changes-vs-last-committed-spec diff (the SAME diff the phone shows), the Brief,
// and its verifier state, before the key is unlocked. Skipped for non-TTY / --yes (scripts, CI, ratify).
function printSignReview(summary, name, brief) {
  console.log('\n' + U.c.bold('Review before signing') + U.c.dim(` — ${summary.length} Cell(s) as "${name}"`));
  if (brief && brief.text) console.log('  ' + U.c.dim('brief: ') + U.c.accent(brief.text) + (brief.tags && brief.tags.length ? U.c.dim('  [' + brief.tags.join(', ') + ']') : ''));
  for (const c of summary) {
    console.log('  ' + U.c.yellow('•') + ' ' + U.c.bold(c.id) + U.c.dim(' · ' + (c.unit || '')) + '  ' + ratifyStateChip(c.state) + (c.intent ? U.c.dim(' — ' + c.intent) : ''));
    if (c.diff && c.diff.length) {
      console.log('      ' + U.c.dim('changes vs last committed spec:'));
      for (const d of c.diff) {
        if (d.t === '+') console.log(U.c.green('      + ' + d.text));
        else if (d.t === '-') console.log(U.c.red('      - ' + d.text));
        else console.log(U.c.dim('        ' + d.text));
      }
    } else {
      console.log('      ' + U.c.dim('(new Cell — no prior signed spec to compare)'));
    }
  }
}

async function cmdSign(flags, positional) {
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  if (flags.check !== undefined) return cmdSignCheck(flags, positional);
  // Default to THIS machine's own signer identity (set at pair/keygen), not the project
  // owner — so a teammate's `yay sign` signs as themselves, matching the key on their phone.
  let name = (flags.name && flags.name !== true) ? flags.name : null;
  if (!name) { const local = loadLocalSigner(p); name = (local && U.pubKeysOf(config.signers[local]).length) ? local : config.owners[0]; }
  if (!name || !U.pubKeysOf(config.signers[name]).length) return fail(`unknown signer "${name}" — run \`yay keygen --name ${name || '<you>'}\` or \`yay pair\``);
  const manifest = buildManifest(flags.dir || p.root);
  let ids = Object.keys(manifest.cells);
  if (flags.cell && flags.cell !== true) ids = String(flags.cell).split(',').map((s) => s.trim());
  if (!ids.length) return fail('no Cells to sign');
  const items = {};
  for (const id of ids) {
    if (!manifest.cells[id]) { console.log(U.c.yellow(`  skip ${id}: not found`)); continue; }
    items[id] = manifest.cells[id].specHash;
    // P1: archive the spec block AS SIGNED, content-addressed by its specHash, so the
    // "as signed" spec is always reconstructable independent of git. Shared by the normal,
    // Autopilot, and ratify sign paths (they all flow through this `items`).
    if (manifest.cells[id].specBlock) O.putObject(p.root, manifest.cells[id].specBlock);
  }
  // ── Tag-plan gate (Standard §5) ── the AI picks a Brief's tags FROM the human's tag
  // plan, so signing is refused while the plan is unfinished: unrelabeled "Custom N"
  // placeholders, or fewer than MIN_PLAN_TAGS unique tags. And adopted (DERIVED) Cells
  // may not be signed before a tag plan exists at all — the adoption wave is exactly
  // when per-concern tagging matters most.
  {
    const tagCfg = tagsMod.loadTags(p);
    const plan = tagsMod.planStatus(tagCfg);
    if (plan.exists && !plan.ok) {
      if (plan.placeholders.length) return fail(`the tag plan isn't finished — relabel the placeholder tag(s) ${plan.placeholders.map((t) => `"${t}"`).join(', ')} first (\`yay tags rename "Custom 1" "<Real name>"\` or the dashboard Tags tab). Briefs are never tagged with placeholders.`);
      return fail(`the tag plan needs at least ${tagsMod.MIN_PLAN_TAGS} unique tags (it has ${plan.unique}) — add more with \`yay tags add "<Tag>"\`, or switch sets with \`yay tags --set <id>\`.`);
    }
    if (!plan.exists && Object.keys(items).some((id) => /DERIVED — unconfirmed/.test(manifest.cells[id].specBlock || ''))) {
      return fail(`adopted Cells can't be signed before a tag plan exists — pick one first (\`yay tags --set <id>\`, ≥${tagsMod.MIN_PLAN_TAGS} unique tags), then sign the adoption as per-concern Briefs.`);
    }
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
  // D3: tie the human signature to the exact MACHINE VERDICT it was made against, when a signed
  // verifier attestation covers this exact code-tree. Recorded inside the seal (so it's part of what
  // the human signs), not asserted — absent when no current attestation exists (e.g. a forward
  // spec-sign before the code was attested). "I approve this intent AND this is the verified result
  // I saw."
  {
    const last = A.latestEntry(p, config);
    if (last && last.codeTreeHash === A.codeTreeHashOf(manifest)) {
      approval.attest = { hash: last.hash, capability: last.capability };
    }
  }
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
  // A short TITLE (headline) over the Brief prose — like a commit subject over its body —
  // so the ledger, clouds and phone card are scannable. Signed with the Brief (tamper-evident).
  let titleText = (flags.title && flags.title !== true) ? String(flags.title).trim() : '';
  if (briefText && !titleText && !flags['no-title'] && process.stdin.isTTY) {
    titleText = (await ask('  title (short headline, optional): ')).trim();
  }
  if (briefText) approval.brief = Object.assign({ text: briefText, orderedBy: 'human (AI-drafted, human-approved)' }, titleText ? { title: titleText } : {});

  // ── Brief tags (Standard §5) ── if the project defines a pool, every Brief is tagged from
  // it. Tags ride inside the (signed) brief, so they're attributed + tamper-evident.
  if (approval.brief) {
    const tagCfg = tagsMod.loadTags(p);
    if (tagCfg) {
      let tags = tagsMod.parseTags(tagCfg.tags, (flags.tags && flags.tags !== true) ? String(flags.tags) : '');
      if (!tags.length && !flags['no-tags']) {
        if (process.stdin.isTTY) {
          console.log(U.c.accent('▸ ') + U.c.bold('Tags') + U.c.dim(' — comma-separated (1–3 ideal), from: ') + U.c.dim(tagCfg.tags.join(', ')));
          tags = tagsMod.parseTags(tagCfg.tags, await ask('  tags: '));
        }
        if (!tags.length) return fail(`this project tags every Brief — pass --tags "Tag1,Tag2" from: ${tagCfg.tags.join(', ')} (or --no-tags to skip).`);
      }
      if (tags.length) {
        const unknown = tagsMod.unknownTags(tagCfg.tags, tags);
        if (unknown.length) console.log(U.c.yellow(`  ⚠ not in the tag pool: ${unknown.join(', ')}`) + U.c.dim(' — add with `yay tags add`, or pick from the pool.'));
        if (tags.length > 4) console.log(U.c.yellow(`  ⚠ ${tags.length} tags on one Brief`) + U.c.dim(' — mixing concerns? Consider splitting into separate Briefs (1–3 tags each).'));
        approval.brief.tags = tags;
      }
    }
  }

  // ── Cross-signer routing ── when --name targets someone OTHER than this machine's own
  // signer (over the relay), seal the request to THEIR inbox and return. Nothing pops on
  // this machine's phone; only the addressed person's on-duty phone sees it.
  const localSigner = loadLocalSigner(p);
  const isCross = localSigner && (flags.name && flags.name !== true) && name !== localSigner
    && !flags.local && phoneTransport(config, flags) === 'relay';
  if (isCross) return sendToInbox(p, config, lock, manifest, items, approval, name, flags);

  // ── Autopilot ── if an active grant covers ALL target Cells (none sensitive), the
  // machine approves with the grant key (delegated) — no phone, no passphrase. Queued for ratify.
  if (!flags['no-auto']) {
    const glog = loadGrants(p);
    if (glog && glog.events && glog.events.length) {
      const rlog = loadRoster(p);
      const drv = rosterMod.deriveRoster(rlog || { events: [] });
      const ownerPubs = Object.keys(drv.roles || {}).filter((n) => drv.roles[n] === 'owner').reduce((a, n) => a.concat(drv.roster[n] || []), []);
      const grants = grantsMod.deriveGrants(glog, ownerPubs, lock.approvals);
      const cellsById = {}; Object.keys(items).forEach((id) => { if (manifest.cells[id]) cellsById[id] = manifest.cells[id]; });
      // Owner-signed policy = the authoritative non-delegable backstop (outside the AI-writable surface).
      const enforcedPolicy = (drv.policy && drv.policy.rules) ? drv.policy : { rules: [] };
      const g = grantsMod.activeGrantFor(grants, Object.keys(items), cellsById, { policy: enforcedPolicy });
      if (g) {
        const rec = U.readJSON(grantKeyPath(p, g.id), null);
        if (rec && rec.priv) {
          approval.autoApproved = true; approval.grant = g.id; approval.signer = g.by || config.owners[0] || 'owner';
          approval.signature = C.sign(U.canonical(approval), Buffer.from(rec.priv, 'base64'));
          lock.approvals = lock.approvals || []; lock.approvals.push(approval); U.writeJSON(p.lock, lock);
          Object.keys(items).forEach((id) => { if (manifest.cells[id]) stampAutoCell(p, manifest.cells[id], g.id); }); // in-code AUTO stamp
          console.log(U.c.yellow(`⚡ delegated ${Object.keys(items).length} Cell(s)`) + U.c.dim(` under grant ${g.id} — approval ${approval.id} (Autopilot).`));
          if (approval.brief) console.log('  ' + U.c.dim('brief: ') + approval.brief.text);
          const left = g.remaining != null ? Math.max(0, g.remaining - 1) : '∞';
          console.log('  ' + U.c.dim(`delegated, NOT human-reviewed — ratify later with `) + U.c.bold('yay ratify') + U.c.dim(`. ${left} delegation(s) left · grant expires ${String(g.expiresAt).slice(0, 16).replace('T', ' ')}.`));
          return;
        }
        console.log(U.c.yellow(`  grant ${g.id} is active but its key is missing on this machine — falling back to a normal signature.`));
      }
    }
  }

  const method = resolveSignMethod(config, p, name, flags);
  if (method === 'phone') {
    // Sign on the paired phone over the LAN — the private key never touches this machine.
    const summary = signSummary(p, config, lock, manifest, items);
    const pubs = U.pubKeysOf(config.signers[name]);
    const tagPool = (tagsMod.loadTags(p) || { tags: [] }).tags; // so the phone can offer in-pool tag corrections
    if (phoneTransport(config, flags) === 'relay') {
      // Hosted relay (relay.yaylayer.com), end-to-end encrypted. Works off-LAN.
      const routed = await routeThroughRelay(p, 'approve', { approval, summary, tagPool, expectPubB64: pubs, signer: name, signerPubs: pubs }, flags);
      if (!routed || !routed.result) return; // routeThroughRelay logged why
      if (reportSendBack(routed.result, name)) { await relayFinal(routed.sess, { ok: false, reason: 'Sent back for changes.' }); return; }
      if (routed.result.brief !== undefined && approval.brief) approval.brief.text = routed.result.brief; // legacy: older phone edited it
      approval.signature = routed.result.signature;
      await relayFinal(routed.sess, { ok: true, message: 'Signed ✓ — leave the page open for the next request.' });
    } else {
    // If a dashboard is running, route through it — the request pops up on the phone
    // the human already has open (scan-once). Otherwise spin the one-shot LAN server.
    const routed = await routeThroughDashboard(p, 'approve', { approval, summary, tagPool, expectPubB64: pubs, signer: name, signerPubs: pubs });
    if (routed && routed.busy) return;
    if (routed && routed.result) {
      if (reportSendBack(routed.result, name)) { await dashboardFinal(routed.info, { ok: false, reason: 'Sent back for changes.' }); return; }
      if (routed.result.brief !== undefined && approval.brief) approval.brief.text = routed.result.brief; // legacy: older phone edited it
      approval.signature = routed.result.signature;
      await dashboardFinal(routed.info, { ok: true, message: 'Signed ✓ — you can leave this open for the next request.' });
    } else {
      const tls = tlsCert(p, flags);
      const s = await phone.signOverLan({ project: config.project, approval, summary, tagPool, expectPubB64: pubs, tls });
      console.log('\n' + U.c.bold('Approve on your phone') + ' — scan with your phone camera (same Wi-Fi):');
      console.log('   ' + U.c.accent(s.url) + U.c.dim('   (or ' + s.local + ' on this computer)'));
      printQR(s.url);
      if (s.fellBack) console.log(U.c.yellow('   ⚠ the preferred phone port was busy (another yay sign/serve running?) — using a different address; your phone may ask to Restore.'));
      if (tls) console.log(U.c.dim('   https: tap through the one-time "not private" warning (Advanced → visit).'));
      console.log(U.c.dim(`   reviewing ${summary.length} change(s) as "${name}" · Ctrl-C to cancel · tip: run \`yay dashboard\` to scan once and skip the QR each time`));
      let r; try { r = await s.done; } finally { s.close(); }
      if (r && r.timedOut) return fail('no approval received in time — nothing was signed. Re-run when ready.');
      if (reportSendBack(r, name)) return;
      if (r && r.brief !== undefined && approval.brief) approval.brief.text = r.brief; // legacy: older phone edited it
      approval.signature = r.signature;
    }
    }
  } else {
    // Local key: show the same review the phone shows (spec + diff + Brief + state), then confirm,
    // BEFORE unlocking the key. --yes / --no-review or a non-TTY (scripts, CI, ratify) skip the prompt.
    if (process.stdin.isTTY && !flags.yes && !flags.y && !flags['no-review']) {
      printSignReview(signSummary(p, config, lock, manifest, items), name, approval.brief);
      const ans = (await ask(`\n  Sign these ${Object.keys(items).length} Cell(s) as "${name}"? (y/N): `)).trim();
      if (!/^y/i.test(ans)) return fail('not signed — nothing written.');
    }
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
  Object.keys(items).forEach((id) => { if (manifest.cells[id]) unstampAutoCell(p, manifest.cells[id]); }); // human sign clears any AUTO stamp (ratified)
  console.log(U.c.green(`✓ signed ${Object.keys(items).length} Cell(s)`) + ` as "${name}" — approval ${approval.id}`);
  if (approval.brief) console.log('  ' + U.c.bold('brief: ') + U.c.accent(approval.brief.text));
  console.log('  ' + U.c.dim('seal appended to .yaylayer/lock.json (commit this)'));
}

// Shared pairing flow (used by `yay pair` and by `yay init` when Mobile is chosen).
async function runPairing(p, config, flags, genesisMeta) {
  flags = flags || {};
  const nameFlag = (flags.name && flags.name !== true) ? flags.name : null;
  const tls = tlsCert(p, flags);
  // No signed trust root yet? Run PHONE-AS-GENESIS: the phone self-signs the
  // genesis event and becomes the owner/root — no local key is ever created.
  // genesisMeta (set on a reroot) stamps the rotation into the signed genesis.
  const rlogPre = loadRoster(p);
  const isGenesis = !(rlogPre && rlogPre.events && rlogPre.events.length);
  const genesis = isGenesis
    ? { id: 'R-0001', type: 'genesis', role: 'owner', prev: 'genesis', nonce: C.randomNonce(), at: new Date().toISOString(), ...(genesisMeta || {}) }
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
    // Remember who this machine signs as, so `yay sign` defaults to them (not the owner).
    saveLocalSigner(p, name);

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
    const routed = await routeThroughRelay(p, 'authorize', { event: ev, summary, ownerPubs, signer: 'an owner', signerPubs: ownerPubs }, flags);
    if (!routed || !routed.result) return null;
    ev.signature = routed.result.signature; await relayFinal(routed.sess, { ok: true, message: 'Authorized ✓' }); return ev;
  }
  // Route through a running dashboard (one origin) if there is one; else ephemeral.
  const routed = await routeThroughDashboard(p, 'authorize', { event: ev, summary, ownerPubs, signer: 'an owner', signerPubs: ownerPubs });
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

// ── Foundation seal ───────────────────────────────────────────────────────
// The git-tracked file set — the seal's structural watch keys off this, so gitignored
// files (.env…) are naturally out. Returns null when git is unavailable (the seal needs git).
function trackedFiles(root) {
  try {
    const out = require('child_process').execSync('git ls-files', { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (_) { return null; }
}

// `yay protect` — an owner signs a baseline of the fixed core files, so any later change is
// REVEALED at verify (src/foundation.js). Stored as an owner-signed, trust-root-pinned roster
// event (un-removable); the posture also lives in committed config so it survives a reroot and
// tells verify a seal is EXPECTED.
async function cmdProtect(flags, positional) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const rlog = loadRoster(p);
  if (!rlog || !rlog.events || !rlog.events.length) return fail('no trust root yet — run `yay init` (the seal is owner-signed).');
  const drv = rosterMod.deriveRoster(rlog);
  const prevSeal = drv.foundation || {};
  const off = !!flags.off || positional[0] === 'off';
  const mode = off ? 'off'
    : (flags.mode && flags.mode !== true ? String(flags.mode).toLowerCase()
      : (drv.foundationMode !== 'off' ? drv.foundationMode : 'guarded'));
  if (!['off', 'guarded', 'strict'].includes(mode)) return fail('--mode must be guarded or strict (or pass --off).');
  const list = (v) => (v && v !== true) ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : [];
  let seal = null;
  if (mode !== 'off') {
    const tracked = trackedFiles(p.root);
    if (tracked == null) return fail('the foundation seal needs git (it watches the tracked-file set) — run `git init` and commit first.');
    // Carry prior customizations forward; --ignore/--add extend, --unignore/--remove drop.
    const ignore = [...new Set([...(prevSeal.ignore || []), ...list(flags.ignore)])].filter((g) => !list(flags.unignore).includes(g));
    const extra = [...new Set([...(prevSeal.extra || []), ...list(flags.add)])].filter((g) => !list(flags.remove).includes(g));
    seal = F.buildSeal(p.root, tracked, { ignore, extra });
  }
  const ev = { id: rosterMod.nextEventId(rlog), type: 'foundation', mode, seal, prev: rlog.events[rlog.events.length - 1].id, nonce: C.randomNonce(), at: new Date().toISOString() };
  const nFiles = seal ? Object.keys(seal.files).length : 0;
  const summary = off
    ? { title: 'Disable the foundation seal', rows: [{ k: 'action', v: 'retire foundation protection' }], warn: 'The fixed-core files will no longer be watched for tampering or corruption. Re-enable any time with `yay protect`.' }
    : { title: 'Seal the project foundation', rows: [{ k: 'mode', v: mode + (mode === 'strict' ? ' — drift blocks the gate' : ' — drift warns') }, { k: 'files', v: nFiles + ' core file(s) hashed' }, { k: 'zones', v: Object.keys(seal.zones).join(', ') }], warn: 'You are vouching that the current fixed-core files are correct. Any later change to them is revealed at verify until you re-seal.' };
  const signed = await authorizeRosterEvent(p, config, rlog, ev, flags, summary);
  if (!signed) return;
  rlog.events.push(signed); U.writeJSON(rosterPath(p), rlog);
  config.foundation = mode; U.writeJSON(p.config, config); // posture survives reroot; the "expected" flag
  if (off) { console.log('\n' + U.c.yellow('• foundation seal disabled') + U.c.dim(' — core files are no longer watched. Commit .yaylayer/roster.json + config.json.')); return; }
  console.log('\n' + U.c.green(`✓ foundation sealed (${mode})`) + U.c.dim(` — ${nFiles} core file(s) + zones ${Object.keys(seal.zones).join(', ')}. Commit .yaylayer/roster.json + config.json.`));
  console.log('  ' + U.c.dim('any later change to a sealed file (or a new/removed file in a watched zone) is revealed by ') + U.c.bold('yay verify') + U.c.dim('. Re-seal after a legitimate change.'));
}

// ── Autopilot commands ──────────────────────────────────────────────────
function listGrants(p, config, lock) {
  const glog = loadGrants(p);
  if (!glog || !glog.events.filter((e) => e.type === 'grant').length) { console.log(U.c.dim('no grants issued — start Autopilot with `yay grant --for 2h --count 20`.')); return; }
  const drv = rosterMod.deriveRoster(loadRoster(p) || { events: [] });
  const ownerPubs = Object.keys(drv.roles || {}).filter((n) => drv.roles[n] === 'owner').reduce((a, n) => a.concat(drv.roster[n] || []), []);
  const grants = grantsMod.deriveGrants(glog, ownerPubs, (lock && lock.approvals) || []);
  console.log(U.c.bold('Grants (Autopilot):'));
  for (const id of Object.keys(grants)) {
    const g = grants[id];
    const status = g.active ? U.c.green('● active') : g.revoked ? U.c.red('revoked') : g.expired ? U.c.dim('expired ') : U.c.dim('spent  ');
    const env = grantsMod.envelopeOf(g);
    const scopeBits = [];
    if (env.cells.length) scopeBits.push(env.cells.length + ' Cell(s)');
    if (env.allow.length) scopeBits.push('allow ' + env.allow.join(','));
    if (env.deny.length) scopeBits.push('deny ' + env.deny.join(','));
    if (env.maxRisk) scopeBits.push('≤' + env.maxRisk + ' risk');
    const scopeStr = scopeBits.length ? scopeBits.join(' · ') : 'non-sensitive';
    const indent = g.parent ? '    └─ ' : '  ';
    const parentTag = g.parent ? U.c.dim(`child of ${g.parent} `) + (g.chain && !g.chain.attenuates ? U.c.red('⚠ ' + (g.chain.reason || 'bad chain') + ' ') : '') : '';
    console.log(indent + status + ' ' + U.c.bold(id) + ' ' + parentTag + U.c.dim(`· ${scopeStr} · ${g.spent}/${g.maxCount || '∞'} used · expires ${String(g.expiresAt).slice(0, 16).replace('T', ' ')}`) + (env.childGrants.allowed ? U.c.dim(` · child-grants✓(d${env.childGrants.maxDepth})`) : ''));
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
  const summary = { title: `Revoke grant ${target} — stop Autopilot`, rows: [{ k: 'revokes', v: target }], warn: 'After this, NO new delegated approvals under this grant are accepted. Delegated approvals already made stay valid but must still be ratified.' };
  const signed = await authorizeRosterEvent(p, config, rlog, ev, flags, summary);
  if (!signed) return;
  glog.events.push(signed); U.writeJSON(grantsPath(p), glog);
  console.log('\n' + U.c.green(`✓ grant ${target} revoked`) + U.c.dim(' — Autopilot off for it. Commit ') + U.c.bold('.yaylayer/grants.json') + U.c.dim('.'));
}
async function cmdGrant(flags, positional) {
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  const sub = positional[0];
  const rlog = loadRoster(p);
  if (sub === 'list' || flags.list) return listGrants(p, config, lock);
  if (sub === 'revoke' || flags.revoke) return grantRevoke(p, config, rlog, flags, positional);
  if (!rlog) return fail('Autopilot needs a signed trust root — pair your phone or run `yay keygen` first.');
  const durMs = parseDuration((flags.for && flags.for !== true) ? flags.for : '2h');
  if (!durMs) return fail('bad --for duration — use e.g. 2h, 90m, 1d.');
  const count = (flags.count && flags.count !== true) ? parseInt(flags.count, 10) : 20;
  if (!(count > 0)) return fail('--count must be a positive number.');
  const list = (v) => (v && v !== true) ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : [];
  // P3 capability envelope. Scope constraints (cells/allow/deny/max-risk) are enforced now; content
  // constraints (deps/deployment) are recorded but DETECTOR-GATED — shown, enforced where a detector
  // exists (D15). --child-grants opts INTO attenuating sub-grants (off by default).
  const envelope = {};
  const cells = list(flags.cell);
  if (cells.length) envelope.cells = cells;
  if (list(flags.allow).length) envelope.allow = list(flags.allow);
  if (list(flags.deny).length) envelope.deny = list(flags.deny);
  if (flags['max-risk'] && flags['max-risk'] !== true) {
    const mr = String(flags['max-risk']).toLowerCase();
    if (!['low', 'medium', 'high'].includes(mr)) return fail('--max-risk must be low, medium or high.');
    envelope.maxRisk = mr;
  }
  if (flags.deps && flags.deps !== true) envelope.deps = String(flags.deps);
  if (flags.deploy && flags.deploy !== true) envelope.deployment = String(flags.deploy);
  if (list(flags['allow-tag']).length) envelope.allowTags = list(flags['allow-tag']);
  if (list(flags['deny-tag']).length) envelope.denyTags = list(flags['deny-tag']);
  if (flags['no-guard'] || flags.unguard) envelope.guard = false; // lift the default auth/payments/secrets/deploy/CI guard
  if (flags['child-grants']) envelope.childGrants = { allowed: true, maxDepth: (flags['max-depth'] && flags['max-depth'] !== true) ? parseInt(flags['max-depth'], 10) : 1 };
  const gk = C.generateKeypair();
  const glog = loadGrants(p) || { project: config.project, events: [] };
  const id = 'G-' + String(glog.events.filter((e) => e.type === 'grant').length + 1).padStart(3, '0');
  const prev = glog.events.length ? glog.events[glog.events.length - 1].id : 'genesis';
  const expiresAt = new Date(Date.now() + durMs).toISOString();
  const ev = { id, type: 'grant', grantPub: gk.pubB64, envelope, expiresAt, maxCount: count, prev, nonce: C.randomNonce(), at: new Date().toISOString() };
  const parts = [];
  if (envelope.cells) parts.push(`${envelope.cells.length} named Cell(s)`);
  if (envelope.allow) parts.push('allow ' + envelope.allow.join(', '));
  if (envelope.deny) parts.push('deny ' + envelope.deny.join(', '));
  if (envelope.allowTags) parts.push('allow-tags ' + envelope.allowTags.join(', '));
  if (envelope.denyTags) parts.push('deny-tags ' + envelope.denyTags.join(', '));
  if (envelope.maxRisk) parts.push('max-risk ' + envelope.maxRisk);
  const guardOn = envelope.guard !== false;
  const scopeStr = parts.length ? parts.join(' · ') : 'all non-sensitive Cells';
  const rows = [
    { k: 'scope', v: scopeStr }, { k: 'expires', v: expiresAt.slice(0, 16).replace('T', ' ') }, { k: 'max', v: `${count} delegated approvals` },
    { k: 'security guard', v: guardOn ? 'ON — auth/payments/secrets/deploy/CI need a real signature' : '⚠ OFF — the AI may auto-approve auth/payments/secrets/deploy/CI' },
  ];
  if (envelope.childGrants) rows.push({ k: 'child grants', v: `allowed (max depth ${envelope.childGrants.maxDepth})` });
  if (envelope.deps || envelope.deployment) rows.push({ k: 'recorded (not yet enforced)', v: [envelope.deps && ('deps: ' + envelope.deps), envelope.deployment && ('deploy: ' + envelope.deployment)].filter(Boolean).join(' · ') });
  const summary = { title: 'Grant Autopilot (delegated execution)', rows, warn: 'While active, the AI approves in-scope changes under the grant (delegated, awaiting ratification) WITHOUT contacting your phone. Sensitive / code-pinned / policy-non-delegable Cells still need a real signature. Stop anytime with `yay grant revoke`.' };
  const signed = await authorizeRosterEvent(p, config, rlog, ev, flags, summary);
  if (!signed) return; // authorizeRosterEvent already reported why
  glog.events.push(signed); U.writeJSON(grantsPath(p), glog);
  fs.mkdirSync(p.keys, { recursive: true });
  U.writeJSON(grantKeyPath(p, id), { pub: gk.pubB64, priv: Buffer.from(gk.privDer).toString('base64') });
  console.log('\n' + U.c.green(`✓ Autopilot ON — grant ${id}`) + U.c.dim(` (${scopeStr}; until ${expiresAt.slice(0, 16).replace('T', ' ')} or ${count} approvals).`));
  if (guardOn) console.log('  ' + U.c.dim('🔒 security guard ON — auth/payments/secrets/deploy/CI still need a real signature (lift with ') + U.c.bold('--no-guard') + U.c.dim(').'));
  else console.log('  ' + U.c.yellow('⚠ security guard OFF') + U.c.dim(' — this grant may auto-approve auth/payments/secrets/deploy/CI code. Re-issue without --no-guard to restore it.'));
  console.log('  ' + U.c.dim('the AI now approves in-scope change-sets under the grant (delegated) with no phone contact. Commit ') + U.c.bold('.yaylayer/grants.json') + U.c.dim(' (key stays in gitignored keys/).'));
  console.log('  ' + U.c.dim('ratify later with ') + U.c.bold('yay ratify') + U.c.dim(' · stop with ') + U.c.bold('yay grant revoke') + U.c.dim(' · check with ') + U.c.bold('yay grant list') + U.c.dim('.'));
}
// The human's decision surface for delegated work: the already-computed signals for a Cell, shown at
// ratify so a reviewer sees complexity + smells at a glance before signing. Pure surfacing — no new
// check, no stored state. Extensible: add a chip here (risk, blast radius, …) as more signals matter.
function ratifyStateChip(state) {
  const f = state === 'GREEN' ? U.c.green : state === 'RED' ? U.c.red : state === 'YELLOW' ? U.c.yellow : U.c.gray;
  return f('● ' + state);
}
function ratifyCellFlags(r) {
  const chips = [];
  if (r.predicate && (r.predicate.undeclared || []).length) chips.push('◈ undeclared input (' + r.predicate.undeclared.join(', ') + ')');
  if (r.coverage && r.coverage.total && (r.coverage.missed || []).length) chips.push(r.coverage.exercised + '/' + r.coverage.total + ' branches');
  let inert = false, weak = false, red = null;
  for (const nt of (r.notes || [])) {
    if (/^inert code/.test(nt.text)) inert = true;
    else if (/weak ensures/.test(nt.text)) weak = true;
    else if (nt.level === 'red' && !red) red = nt.text.split(/[—;(]/)[0].trim().slice(0, 60);
  }
  if (inert) chips.push('inert');
  if (weak) chips.push('weak ensures');
  if (red) chips.push('RED: ' + red);
  return chips;
}

async function cmdRatify(flags) {
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  const manifest = buildManifest(flags.dir || p.root);
  const verified = verifyManifest(manifest, lock, config, { mutate: false, roster: loadRoster(p), grants: loadGrants(p), rejections: loadRejections(p), tracked: trackedFiles(p.root),root: trustRootPin(flags) });
  const auto = R.autoCellIds(verified);
  if (flags.reject) return ratifyReject(p, config, lock, manifest, verified, auto, flags);
  if (!auto.length) { console.log(U.c.green('✓ nothing to ratify') + U.c.dim(' — no delegated Cells awaiting your signature.')); return; }
  const bundle = R.ratifyBundle(manifest, verified, auto);
  const reviewPath = path.join(path.dirname(p.lock), '.ratify-review.json');
  const prevReview = U.readJSON(reviewPath, null);
  const detail = !!(flags.d || flags.details);
  console.log(U.c.bold(`${auto.length} delegated Cell(s) awaiting ratification:`) + U.c.dim(detail ? '' : '  (add -d to expand spec + code)'));
  for (const id of auto) {
    const r = verified.results[id]; const c = manifest.cells[id] || {};
    console.log('  ' + U.c.yellow('⚡ ') + U.c.bold(id) + U.c.dim(` · ${c.unitName || ''} · grant ${r.trust.grant}`) + '  ' + ratifyStateChip(r.state));
    const chips = ratifyCellFlags(r);
    if (chips.length) console.log('       ' + U.c.dim('flags: ') + chips.map((x) => U.c.yellow(x)).join(U.c.dim(' · ')));
    if (prevReview && prevReview.per && prevReview.per[id] && bundle.per[id] && (prevReview.per[id].spec !== bundle.per[id].spec || prevReview.per[id].code !== bundle.per[id].code)) {
      console.log('       ' + U.c.yellow('↻ changed since your last review'));
    }
    if (detail) {
      const specTxt = (c.specBlock || '').trim(); const codeTxt = (c.unitBody || '').trim();
      if (specTxt) console.log(specTxt.split('\n').map((l) => '       ' + U.c.dim(l)).join('\n'));
      if (codeTxt) console.log(codeTxt.split('\n').slice(0, 40).map((l) => '       ' + l).join('\n'));
      console.log('');
    }
  }
  if (!flags.sign && !flags.yes) {
    U.writeJSON(reviewPath, { hash: bundle.hash, ids: bundle.ids, per: bundle.per, at: new Date().toISOString() });
    console.log('\n' + U.c.dim('reviewed snapshot ') + U.c.bold(bundle.hash.slice(0, 12) + '…') + U.c.dim(' — review these, then ratify with ') + U.c.bold('yay ratify --sign') + U.c.dim(' (it signs exactly this snapshot).'));
    return;
  }
  // ── TOCTOU protection: `--sign` must sign PRECISELY what was reviewed. The reviewed hash comes
  // from `--reviewed <hash>` (dashboard, captured at render time) or the review file (a prior
  // `yay ratify`). If the delegated changes moved since, refuse the whole batch — nothing signed.
  let reviewed = (flags.reviewed && flags.reviewed !== true) ? String(flags.reviewed) : null, prevPer = null;
  if (!reviewed && fs.existsSync(reviewPath)) { const rf = U.readJSON(reviewPath, {}); reviewed = rf.hash || null; prevPer = rf.per || null; }
  if (!reviewed) return fail('run `yay ratify` first to review what you are signing — nothing signed.');
  if (reviewed !== bundle.hash) {
    let changed = '';
    if (prevPer) { const keys = Object.keys({ ...prevPer, ...bundle.per }); const diff = keys.filter((id) => !prevPer[id] || !bundle.per[id] || prevPer[id].spec !== bundle.per[id].spec || prevPer[id].code !== bundle.per[id].code); if (diff.length) changed = ' Changed: ' + diff.join(', ') + '.'; }
    try { if (fs.existsSync(reviewPath)) fs.unlinkSync(reviewPath); } catch (_) {}
    return fail(`the delegated changes moved since you reviewed them (reviewed ${String(reviewed).slice(0, 12)}…, current ${bundle.hash.slice(0, 12)}…).${changed} Run \`yay ratify\` again — nothing signed.`);
  }
  // Ratify = a normal HUMAN signature over exactly these Cells (never delegated again).
  flags.cell = auto.join(','); flags['no-auto'] = true;
  if (!flags.brief) flags.brief = 'Ratify delegated changes';
  const res = await cmdSign(flags);
  try { if (fs.existsSync(reviewPath)) fs.unlinkSync(reviewPath); } catch (_) {}
  return res;
}

// Persist a REJECTION as a first-class, human-signed, append-only provenance event (P3). A rejection
// is where agent autonomy failed human judgment — the substrate for future "earned autonomy" metrics
// (which categories get rejected, how often). It is never erased and never rewrites history: the
// delegated seal stays in the record; the rejection sits beside it, and the code stays UNSIGNED
// (unratified) until fixed and re-signed. Owner-authorized (local key or phone), so it's attributable.
async function ratifyReject(p, config, lock, manifest, verified, auto, flags) {
  const rlog = loadRoster(p);
  if (!rlog) return fail('rejection needs a signed trust root — pair your phone or run `yay keygen` first.');
  const want = (flags.cell && flags.cell !== true) ? String(flags.cell).split(',').map((s) => s.trim()).filter(Boolean) : auto;
  const cells = want.filter((id) => auto.includes(id));
  if (!cells.length) return fail(auto.length ? `none of those Cells are awaiting ratification — pending: ${auto.join(', ')}.` : 'nothing to reject — no delegated Cells awaiting ratification.');
  const reason = (flags.reason && flags.reason !== true) ? String(flags.reason) : null;
  if (!reason) return fail('a rejection needs a reason — pass --reason "<why>" (recorded, tamper-evident). Optionally --category <dependency|security|scope|quality|other>.');
  const category = (flags.category && flags.category !== true) ? String(flags.category).toLowerCase() : 'other';
  const specHashes = {}; const grantsHit = new Set();
  for (const id of cells) { specHashes[id] = (manifest.cells[id] || {}).specHash || null; const t = (verified.results[id] || {}).trust || {}; if (t.grant) grantsHit.add(t.grant); }
  const rj = loadRejections(p) || { project: config.project, events: [] };
  const id = 'X-' + String(rj.events.length + 1).padStart(4, '0');
  const ev = { id, type: 'reject', project: config.project, cells, specHashes, grants: [...grantsHit], reason, category, prev: rj.events.length ? rj.events[rj.events.length - 1].id : 'genesis', nonce: C.randomNonce(), at: new Date().toISOString() };
  const summary = { title: `Reject ${cells.length} delegated Cell(s)`, rows: [
    { k: 'cells', v: cells.join(', ') }, { k: 'category', v: category }, { k: 'reason', v: reason },
  ], warn: 'This records a signed REJECTION (append-only). The delegated code stays UNSIGNED until fixed and re-signed; the rejection is kept forever as provenance (and feeds earned-autonomy metrics).' };
  const signed = await authorizeRosterEvent(p, config, rlog, ev, flags, summary);
  if (!signed) return; // authorizeRosterEvent already reported why
  signed.signer = signed.by; // the human who rejected
  rj.events.push(signed); U.writeJSON(rejectionsPath(p), rj);
  console.log('\n' + U.c.red(`✗ rejected ${cells.length} Cell(s)`) + U.c.dim(` — ${id} · ${category} · by ${signed.by}. Recorded in `) + U.c.bold('.yaylayer/rejections.json') + U.c.dim(' (commit it). The code stays unsigned until fixed.'));
}
function loadRejections(p) { return U.readJSON(rejectionsPath(p), null); }

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
  // The 6-digit confirm code binds this pubkey to the right human (anti-MITM): the
  // joiner sees the same code on their screen; the owner verifies it out-of-band.
  const code = String(parseInt(C.sha256('yay-pair:' + pub).slice(0, 8), 16) % 1000000).padStart(6, '0');
  const summary = {
    title: (type === 'add-key' ? `Add another key for "${name}" in ` : `Add ${role} "${name}" to `) + config.project + '?',
    rows: [
      { k: name + ' · ' + role, v: 'key ' + rosterMod.fingerprint(pub) },
      { k: 'confirm code', v: code + '  — must match the joiner’s screen' },
    ],
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

// `yay invite "Bob"` — a teammate opens a link, creates their key, and requests to
// join; you approve on your phone. The name is an optional SUGGESTION that pre-fills
// the joiner's (editable) name field. No new trust surface: it triggers the normal
// owner-signed enroll. Uses the project's transport: RELAY (works from anywhere,
// self-contained) or LAN (via a running dashboard, same network).
async function cmdInvite(flags, positional) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const name = (positional && positional[0]) ? positional[0] : ((flags.name && flags.name !== true) ? flags.name : '');
  const role = flags.role === 'owner' ? 'owner' : 'signer';
  if (phoneTransport(config, flags) === 'relay') return inviteViaRelay(p, config, name, role, flags);
  return inviteViaDashboard(p, config, name, role, flags);
}

// RELAY invite: self-contained (no dashboard needed). Mint a one-time invite channel,
// print a relay.yaylayer.com link, wait for the joiner's key over the relay, then run
// the normal owner-signed enroll (which routes YOUR approval to your relay-paired phone).
async function inviteViaRelay(p, config, name, role, flags) {
  const rlog = loadRoster(p);
  if (!rlog || !rlog.events || !rlog.events.length) return fail('no signed roster yet — run `yay init` to establish the trust root first.');
  const base = relayBase(flags);
  const ich = E2E.newChannel();
  const ikeyBytes = E2E.newKey();
  const isess = { base, channel: ich, keyBytes: ikeyBytes };
  const challenge = C.randomNonce();
  const offer = { mode: 'join', name, role, project: config.project, challenge };
  try {
    const rq = await relayFetch(isess, '/api/request', { method: 'POST', body: JSON.stringify({ ch: ich, blob: E2E.seal(ikeyBytes, offer) }) });
    if (!rq.ok) return fail('the relay rejected the invite (HTTP ' + rq.status + ').');
  } catch (e) { return fail('could not reach the relay (' + base + '): ' + ((e && e.message) || e)); }
  const url = base + '/#' + ich + '.' + E2E.b64url(ikeyBytes);
  console.log('\n' + U.c.green('✓ invite' + (name ? ` for "${name}"` : '')) + U.c.dim(` as ${role} — over the relay, end-to-end encrypted.`));
  console.log('   ' + U.c.bold('send this link → ') + U.c.accent(url));
  console.log(U.c.dim('   …or have them scan:'));
  printQR(url);
  console.log(U.c.dim(`   They open it anywhere, set their name (${name ? `pre-filled "${name}", ` : ''}editable), and create their key.`));
  console.log(U.c.dim('   Then approve on the phone you already have on the relay page. Ctrl-C to cancel.'));
  // Wait for the joiner's answer over the relay.
  let ans = null;
  for (;;) {
    let r; try { r = await relayFetch(isess, '/api/result?ch=' + encodeURIComponent(ich)).then((x) => x.json()); } catch (_) { await sleepMs(1500); continue; }
    if (r && r.state === 'answered') { ans = E2E.open(ikeyBytes, r.blob); break; }
    await sleepMs(1500);
  }
  if (!ans) { await relayFinal(isess, { ok: false, reason: 'could not read the request' }); return fail('could not decrypt the join request (channel key mismatch).'); }
  const finalName = String(ans.name || name || '').trim();
  if (!finalName || !ans.pubB64 || !ans.proof || !C.verify(challenge, ans.proof, ans.pubB64)) {
    await relayFinal(isess, { ok: false, reason: 'the request did not verify' });
    return fail('the join request did not verify — nothing was written.');
  }
  console.log('\n' + U.c.bold(`${finalName} wants to join`) + U.c.dim(` — key ${rosterMod.fingerprint(ans.pubB64)}. Approve on your phone…`));
  // Build the add-signer event and route the OWNER approval to the phone (relay).
  const drv = rosterMod.deriveRoster(rlog);
  const type = drv.roster[finalName] ? 'add-key' : 'add-signer';
  const code = String(parseInt(C.sha256('yay-pair:' + ans.pubB64).slice(0, 8), 16) % 1000000).padStart(6, '0');
  const ev = { id: rosterMod.nextEventId(rlog), type, name: finalName, pub: ans.pubB64, role, by: null, prev: rlog.events[rlog.events.length - 1].id, nonce: C.randomNonce(), at: new Date().toISOString() };
  const summary = {
    title: (type === 'add-key' ? `Add another key for "${finalName}" in ` : `Add ${role} "${finalName}" to `) + config.project + '?',
    rows: [{ k: finalName + ' · ' + role, v: 'key ' + rosterMod.fingerprint(ans.pubB64) }, { k: 'confirm code', v: code + '  — must match the joiner’s screen' }],
    warn: role === 'owner' ? 'Owner rights: they can enroll and revoke signers.' : '',
  };
  const signed = await authorizeRosterEvent(p, config, rlog, ev, flags, summary);
  if (!signed) { await relayFinal(isess, { ok: false, reason: 'the owner did not approve' }); return; }
  const test = rosterMod.deriveRoster({ ...rlog, events: rlog.events.concat([signed]) });
  if (test.problems.length) { await relayFinal(isess, { ok: false, reason: 'roster would not validate' }); return fail('refusing to write — ' + test.problems.join('; ')); }
  rlog.events.push(signed);
  U.writeJSON(rosterPath(p), rlog);
  addSignerKey(config, finalName, ans.pubB64, role === 'owner' ? 'owner' : 'signer');
  U.writeJSON(p.config, config);
  await relayFinal(isess, { ok: true, message: 'Approved — you’re in! You can start signing on this phone.' });
  console.log(U.c.green(`✓ enrolled "${finalName}" as ${role}`) + U.c.dim(` (authorized by ${signed.by}) — commit .yaylayer/roster.json`));
}

// LAN invite: via a running dashboard (same-network joiner).
async function inviteViaDashboard(p, config, name, role, flags) {
  const info = dashboardReg(p);
  if (!info) return fail('no running dashboard found — start `yay dashboard` in another terminal, then run `yay invite` here.');
  let ping; try { ping = await dfetch(info, '/api/ping').then((r) => r.json()); } catch (_) { ping = null; }
  if (!ping || ping.yay !== 'dashboard') return fail('the dashboard is not reachable — is `yay dashboard` still running?');
  let r; try { r = await dfetch(info, '/api/invite/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, role }) }).then((x) => x.json()); }
  catch (e) { return fail('could not reach the dashboard: ' + ((e && e.message) || e)); }
  if (!r || !r.token) return fail('the dashboard did not issue an invite' + (r && r.error ? ': ' + r.error : ''));
  const base = (info.phoneUrl || '').replace(/\/phone$/, '') || `${info.scheme}://<this-mac>:${info.port}`;
  const joinUrl = base + r.joinPath;
  console.log('\n' + U.c.green('✓ invite' + (name ? ` for "${name}"` : '')) + U.c.dim(` as ${role} — valid ${r.expiresInMin || 30} min, one-time.`));
  console.log('   ' + U.c.bold('send this link → ') + U.c.accent(joinUrl));
  console.log(U.c.dim('   …or have them scan (same Wi-Fi):'));
  printQR(joinUrl);
  console.log(U.c.dim(`   They open it, confirm their name (${name ? `pre-filled "${name}", ` : ''}editable), and create their key.`));
  console.log(U.c.dim('   Then an approval pops up on your phone — verify the 6-digit code together, then tap Approve.'));
  if (role === 'owner') console.log(U.c.yellow('   ⚠ owner role: they will be able to enroll and revoke others.'));
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
  console.log(U.c.dim('  key. Provenance is preserved — the old roster is ARCHIVED and past signatures stay'));
  console.log(U.c.dim('  valid against it; this is a labeled seam, not a wipe. Use only when the root key is lost/compromised.'));
  if (oldFp) console.log(U.c.dim('  current root → ') + U.c.bold(oldFp));
  // Team guard: if OTHER owners exist, the clean path is revoke+enroll (keeps the root). Don't refuse
  // (all owners may be lost/compromised) — but escalate the confirmation to a deliberate token.
  const drv0 = (log && log.events && log.events.length) ? rosterMod.deriveRoster(log) : { roles: {} };
  const owners = Object.keys(drv0.roles || {}).filter((n) => drv0.roles[n] === 'owner');
  const teamGuard = owners.length > 1;
  if (teamGuard) {
    console.log('\n  ' + U.c.yellow(`⚠ This project has ${owners.length} owners: `) + U.c.bold(owners.join(', ')));
    console.log(U.c.dim('  Normally another owner should recover you instead — it keeps the root, no re-signing:'));
    console.log('     ' + U.c.bold(`yay revoke --name "<you>"`) + U.c.dim('  then  ') + U.c.bold('yay enroll --name "<you>" --pubkey <new>'));
    console.log(U.c.dim('  Only reroot if EVERY owner key is lost or compromised and no one can revoke.'));
  }
  // No CI pin → this reroot (and any) has no backstop. Warn loudly.
  if (!fs.existsSync(path.join(p.root, '.github', 'workflows', 'yaylayer.yml'))) {
    console.log('\n  ' + U.c.yellow('⚠ No CI gate found') + U.c.dim(' — without a pinned trust root in CI, a reroot has no backstop and is not detectable by others. Set up `yay gate` for real protection.'));
  }
  if (!flags.force) {
    const token = teamGuard ? String(config.project || 'reroot') : 'reroot';
    const prompt = teamGuard
      ? `  Type the project name "${token}" to confirm all owners are unavailable and proceed: `
      : '  Type "reroot" to confirm: ';
    const ans = await ask(prompt);
    if ((ans || '').trim() !== token) return console.log('  aborted — nothing changed.');
  }
  // A stated reason, recorded in the audit (e.g. "Compromised keys during cyberattack 2027-06-24"
  // or "Keys lost"). Every event is ISO-timestamped, so the rotation is dated + attributed.
  let reason = (flags.reason && flags.reason !== true) ? String(flags.reason).trim() : '';
  if (!reason && process.stdin.isTTY) reason = (await ask('  Reason for rerooting (recorded in the audit, e.g. "keys lost" / "compromised in breach"): ')).trim();
  const rerootedAt = new Date().toISOString();
  const genesisMeta = { supersedes: oldFp || null, rerootedAt, rerootReason: reason || '(unstated)' };
  // Archive the old roster + reset the config mirror; the new genesis re-populates it.
  if (log) { U.writeJSON(rosterPath(p).replace(/\.json$/, `.${oldFp || 'old'}.json`), log); fs.unlinkSync(rosterPath(p)); }
  config.signers = {}; config.owners = [];
  config.lastReroot = { from: oldFp || null, reason: reason || '(unstated)', at: rerootedAt }; // committed audit note (both paths)
  U.writeJSON(p.config, config);
  console.log('\n' + U.c.bold('Establish the new trust root:'));
  if (flags.phone || flags.key === 'mobile') {
    await runPairing(p, config, flags, genesisMeta); // no roster now → phone-as-genesis (stamped)
  } else {
    const name = (flags.name && flags.name !== true) ? flags.name : (process.stdin.isTTY ? await ask('  New owner name: ') : 'you');
    const pass = await getPassphrase(flags, `Set a passphrase for the new owner key "${name}"`);
    if (!pass || pass.length < 6) return fail('passphrase must be at least 6 characters — no new root created (old one archived).');
    createKey(p, config, name, pass, genesisMeta);
    console.log(U.c.green(`✓ new local owner key for "${name}"`));
  }
  console.log('  ' + U.c.dim('rotation recorded: from ') + U.c.bold(oldFp || '(none)') + U.c.dim(' · ') + U.c.bold(rerootedAt.slice(0, 16).replace('T', ' ')) + U.c.dim(' · reason: ') + U.c.bold(reason || '(unstated)'));
  console.log('\n' + U.c.bold('Next:') + U.c.dim(' re-sign specs under the new root ') + U.c.bold('yay sign --all') + U.c.dim(', then repoint CI ') + U.c.bold('yay gate') + U.c.dim(' (new fingerprint above).'));
  if (oldFp) console.log(U.c.dim('  old roster archived → .yaylayer/roster.' + oldFp + '.json') + U.c.dim(' (past signatures stay valid against it — provenance preserved).'));
  // The foundation seal was signed under the OLD root; it's now orphaned. config.foundation
  // survived (posture persists), so verify will flag "expected but missing" until you re-seal.
  if (config.foundation && config.foundation !== 'off') {
    console.log('  ' + U.c.yellow('⚠ re-seal the foundation') + U.c.dim(' under the new root: ') + U.c.bold('yay protect') + U.c.dim(` (posture ${config.foundation} — the old seal no longer applies).`));
  }
  if (teamGuard) console.log('  ' + U.c.yellow('⚠ tell your team the trust root rotated') + U.c.dim(' — everyone re-clones/re-pairs against the new root ') + U.c.bold(rosterMod.deriveRoster(loadRoster(p)).rootFp || '') + U.c.dim('. Anyone still on the old root will see TRUST-ROOT MISMATCH.'));
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
          meta.push((r.trust.auto ? 'Delegated·' + (r.trust.grant || 'grant') : 'by ' + r.trust.signer) + (r.trust.at ? ' on ' + when(r.trust.at) : ''));
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
  const verified = verifyManifest(manifest, lock, config, { mutate: !flags['no-mutate'], roster: loadRoster(p), grants: loadGrants(p), rejections: loadRejections(p), tracked: trackedFiles(p.root),root: trustRootPin(flags) });
  printReport(manifest, verified, !!(flags.details || flags.d), !!(flags.problems || flags.issues || flags.p));
  if (verified.signedRoster) console.log('  ' + U.c.dim('trust root ' + verified.rootFp) + (verified.rootMeta ? U.c.dim(' · rerooted' + (verified.rootMeta.supersedes ? ' from ' + verified.rootMeta.supersedes : '') + (verified.rootMeta.rerootedAt ? ' on ' + String(verified.rootMeta.rerootedAt).slice(0, 10) : '') + ' — ' + (verified.rootMeta.rerootReason || '(unstated)')) : ''));
  else console.log('  ' + U.c.yellow('⚠ roster is unsigned') + U.c.dim(' — no signed trust root; run `yay init`/`yay keygen` to establish one.'));
  for (const pb of verified.rosterProblems || []) console.log('  ' + U.c.red('✗ roster: ') + pb);
  reportFoundation(verified);
  // Verifier attestation status (P2): is the current tree covered by a signed attestation?
  reportAttestStatus(p, config, manifest, verified);
  reportProtection(p, config, verified);
  const blocked = !verified.passed || manifest.problems.length;
  console.log('\n  ' + (blocked ? U.c.red('GATE: BLOCKED') + U.c.dim(' (red, unsigned, or unspecified/pink code cannot reach main)')
    : U.c.green('GATE: PASS')));
  if (!flags.dir && process.argv.includes('--strict')) process.exit(blocked ? 1 : 0);
  if (flags.strict) process.exit(blocked ? 1 : 0);
}

// One line under `yay verify`: whether a signed verifier attestation covers the EXACT current tree.
// Drift (code/spec changed since the last attestation) is surfaced so the human knows the signed
// verdict no longer describes what's on disk — re-mint with `yay attest`.
// Foundation seal status — REVEAL any drift in the fixed core (warn in Guarded, block in Strict).
function reportFoundation(verified) {
  const fnd = verified.foundation;
  if (!fnd) return;
  if (fnd.clean) { console.log('  ' + U.c.dim('🛡 foundation seal intact (' + fnd.mode + ')')); return; }
  if (fnd.expectedButMissing) {
    console.log('  ' + U.c.red('🛡 FOUNDATION PROTECTION EXPECTED — no valid seal under the current root') + U.c.dim(' — run ') + U.c.bold('yay protect') + U.c.dim(' to (re-)seal.' + (fnd.mode === 'strict' ? ' (strict → gate blocked)' : '')));
    return;
  }
  const bits = [];
  if (fnd.changed.length) bits.push(fnd.changed.length + ' changed (' + fnd.changed.join(', ') + ')');
  if (fnd.missing.length) bits.push(fnd.missing.length + ' missing (' + fnd.missing.join(', ') + ')');
  if (fnd.addedFiles.length) bits.push(fnd.addedFiles.length + ' new file(s) (' + fnd.addedFiles.join(', ') + ')');
  if (fnd.removedFiles.length) bits.push(fnd.removedFiles.length + ' removed (' + fnd.removedFiles.join(', ') + ')');
  console.log('  ' + U.c.red('⚠ FOUNDATION CHANGED') + U.c.dim(' — ' + bits.join(' · ')));
  console.log('    ' + U.c.dim('a sealed core file (or watched zone) changed since it was sealed. If this was you, re-seal: ') + U.c.bold('yay protect') + U.c.dim('. If not, investigate — this reveals tampering or corruption.' + (fnd.mode === 'strict' ? ' (strict → gate BLOCKED until re-sealed)' : ' (guarded → warning only)')));
}

// Protection posture — an honest "are you actually protected?" readout so advisory-only can't be
// mistaken for enforcing. Guarantees need the CI gate on a protected branch + a signed root.
function reportProtection(p, config, verified) {
  const hasWorkflow = fs.existsSync(path.join(p.root, '.github', 'workflows', 'yaylayer.yml'));
  let pinned = false;
  try { if (hasWorkflow) pinned = /--root|trust[-\s]?root|ROOT/i.test(fs.readFileSync(path.join(p.root, '.github', 'workflows', 'yaylayer.yml'), 'utf8')); } catch (_) {}
  const phone = signMethodOf(config) === 'phone';
  const fnd = (config && config.foundation) || 'off';
  const enforcing = hasWorkflow && verified.signedRoster;
  const mk = (b) => (b ? U.c.green('✓') : U.c.red('✗'));
  console.log('\n  ' + (enforcing ? U.c.green('Protection: ENFORCING') : U.c.yellow('⚠ Protection: ADVISORY ONLY'))
    + U.c.dim(enforcing ? ' — confirm branch protection requires the "gate" check' : ' — local checks only; nothing enforces main until you set up the CI gate'));
  console.log('    ' + mk(hasWorkflow) + U.c.dim(' CI gate (yay gate)  ') + mk(verified.signedRoster) + U.c.dim(' signed trust root  ')
    + (hasWorkflow ? (mk(pinned) + U.c.dim(' root pinned  ')) : '')
    + mk(phone) + U.c.dim(phone ? ' phone signing  ' : ' phone signing (local keystore — key on disk)  ')
    + (fnd !== 'off' ? U.c.green('✓') : U.c.dim('○')) + U.c.dim(' foundation seal: ' + fnd));
}

function reportAttestStatus(p, config, manifest, verified) {
  const last = A.latestEntry(p, config);
  if (!last) { console.log('  ' + U.c.dim('no verifier attestation yet — mint one with ') + U.c.bold('yay attest') + U.c.dim(' (signs this verdict).')); return; }
  const cur = A.buildVerification(manifest, verified, { config, policy: verified.policy });
  const covered = cur.codeTreeHash === last.codeTreeHash;
  if (covered) console.log('  ' + U.c.dim('verifier attestation ' + U.c.green(last.hash.slice(0, 12)) + U.c.dim(` · ${last.passed ? 'PASS' : 'BLOCKED'} · capability ${last.capability}`)));
  else console.log('  ' + U.c.yellow('⚠ attestation stale') + U.c.dim(` — code changed since ${last.hash.slice(0, 12)}; re-mint with `) + U.c.bold('yay attest'));
}

// `yay attest` — mint a signed VERIFIER ATTESTATION over the current verified tree (P2). This is
// the third cryptographic identity: the machine verifier signs its own verdict with its own key,
// so "Green" becomes a portable, checkable object. Run at commit / after a green verify. Append-only
// (chained to the previous attestation); the verifier PRIVATE key stays machine-side (gitignored),
// the PUBLIC key is pinned in config (committed) so anyone can verify without being able to forge.
function cmdAttest(flags, positional) {
  if (positional[0] === 'list' || positional[0] === 'verify' || flags.list) return cmdAttestList(flags, positional);
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  const manifest = buildManifest(flags.dir || p.root);
  if (!Object.keys(manifest.cells).length) return fail('no Cells to attest — write/adopt specs first.');
  const verified = verifyManifest(manifest, lock, config, { mutate: !flags['no-mutate'], roster: loadRoster(p), grants: loadGrants(p), rejections: loadRejections(p), tracked: trackedFiles(p.root),root: trustRootPin(flags) });

  // Capability self-check: the declared verifier version must match the live detector set, so an
  // attestation can never claim a capability the verifier doesn't actually have (drift = a detector
  // changed without a version bump). A shipped package never drifts; a modified one does.
  const capChk = CAP.assertCapability();
  if (capChk.drift && !flags['allow-capability-drift']) {
    return fail(`verifier capability DRIFT — the active detectors don't match the fingerprint registered for ${capChk.declared}.\n  registered: ${String(capChk.expected).slice(0, 16)}…\n  actual:     ${capChk.actual.slice(0, 16)}…\n  The verifier's provers/effect-nets/checks changed without a capability bump. Bump CAPABILITY in src/capability.js and set REGISTERED[<new>] = "${capChk.actual}" (or pass --allow-capability-drift to attest anyway).`);
  }
  // Refuse to sign a verdict that doesn't pass, unless explicitly told to record a failing one.
  if (!verified.passed && !flags.force) {
    return fail('gate is BLOCKED — refusing to attest a failing verdict. Fix the reds, or pass --force to record a failing attestation on purpose.');
  }
  const id = A.verifierIdentity(p, config); // creates the machine verifier key on first use
  const changed = A.pinVerifier(config, id);
  if (changed) U.writeJSON(p.config, config);
  const verObj = A.buildVerification(manifest, verified, { config, policy: verified.policy });
  const att = A.signAttestation(verObj, id);
  A.appendAttestation(p, config, att);
  console.log(U.c.green('✓ attestation minted') + U.c.dim(` — verifier ${id.fp}`));
  console.log('  ' + U.c.bold(att.hash.slice(0, 16)) + U.c.dim(`  · ${att.result.passed ? 'PASS' : U.c.red('BLOCKED')} · ${att.result.counts.GREEN} green (${att.result.proven} proven) · capability ${att.capability}`));
  console.log('  ' + U.c.dim('code-tree ' + att.codeTreeHash.slice(0, 12) + ' · spec-set ' + att.specSetHash.slice(0, 12) + ' · ' + att.env.node + ' ' + att.env.platform));
  if (changed) console.log('  ' + U.c.dim('pinned this verifier as the project verifier of record → ') + U.c.bold('.yaylayer/config.json') + U.c.dim(' (commit it).'));
  console.log('  ' + U.c.dim('append-only ledger → ') + U.c.bold('.yaylayer/attest.json') + U.c.dim(' + full object in .yaylayer/attestations/ (commit both). Key stays in gitignored keys/.'));
  console.log('  ' + U.c.dim('verify anywhere (no upload, checks in-browser) → ') + U.c.bold('https://yaylayer.com/verify') + U.c.dim(' · registry cross-check: ') + U.c.bold('yay attest verify --registry'));
}

// Base URL of the public verifier-capability registry (yaylayer.com), overridable for testing.
function registryBase(flags) { return (flags.registry && flags.registry !== true) ? String(flags.registry).replace(/\/$/, '') : 'https://yaylayer.com'; }

// `yay archive` (P4 — Durable mode + governance). Keeps an encrypted, sha256-anchored copy of the
// SIGNED source so "what the code was when signed" survives git loss. Subcommands: enable/disable,
// (default) archive the covered files, --forget (signed tombstone), --restore, --verify, --install.
async function cmdArchive(flags, positional) {
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  const sub = positional[0];

  if (sub === 'enable' || flags.enable) {
    config.provenance = { mode: 'durable' };
    if (flags.retention && flags.retention !== true) config.provenance.retention = String(flags.retention);
    U.writeJSON(p.config, config);
    ensureGitignored(p.root, '.yaylayer/keys/'); // (already ignored) — the archive KEY is never on disk
    console.log(U.c.green('✓ Durable mode ON') + U.c.dim(' — `yay archive` now keeps an encrypted, sha256-anchored copy of signed source.'));
    console.log('  ' + U.c.dim('the archive KEY is project-held (') + U.c.bold('$YAY_ARCHIVE_KEY') + U.c.dim(' or a passphrase) and NEVER stored by YayLayer. Archive with ') + U.c.bold('yay archive') + U.c.dim('.'));
    return;
  }
  if (sub === 'disable' || flags.disable) { config.provenance = { mode: 'standard' }; U.writeJSON(p.config, config); console.log(U.c.dim('Durable mode off — back to Standard (specs/attestations kept; bulk source via git).')); return; }

  if (sub === 'install' || flags.install) {
    const hookDir = path.join(p.root, '.git', 'hooks');
    if (!fs.existsSync(hookDir)) return fail('no .git/hooks — is this a git repo? Run `git init` first.');
    const hook = path.join(hookDir, 'post-commit');
    const line = 'yay archive --quiet || true';
    let txt = ''; try { txt = fs.readFileSync(hook, 'utf8'); } catch (_) {}
    if (!txt) txt = '#!/bin/sh\n';
    if (txt.includes(line)) { console.log(U.c.dim('post-commit hook already archives — nothing to do.')); return; }
    fs.writeFileSync(hook, txt + (txt.endsWith('\n') ? '' : '\n') + '# YayLayer Durable archive\n' + line + '\n', { mode: 0o755 });
    console.log(U.c.green('✓ installed post-commit hook') + U.c.dim(' — each commit archives the signed source (needs $YAY_ARCHIVE_KEY in the environment).'));
    return;
  }

  const arc = D.loadArchive(p) || { project: config.project, salt: C.randomNonce(), files: {}, tombstones: [], retention: (config.provenance && config.provenance.retention) || null };

  if (sub === 'forget' || flags.forget) {
    const hash = (flags.forget && flags.forget !== true) ? flags.forget : positional[1];
    if (!hash) return fail('which blob? pass the content hash: `yay archive --forget <hash> --reason "…"`.');
    const reason = (flags.reason && flags.reason !== true) ? String(flags.reason) : null;
    if (!reason) return fail('a deletion needs a reason (recorded in the tombstone) — pass --reason "<why>".');
    const signer = localSignerName(p, config) || 'owner';
    const ts = D.tombstone(p, hash, reason, signer);
    arc.tombstones.push(ts);
    for (const f of Object.keys(arc.files)) if (arc.files[f].hash === hash) arc.files[f].status = 'tombstoned';
    D.saveArchive(p, arc);
    console.log(U.c.yellow('⧗ tombstoned') + U.c.dim(` ${String(hash).slice(0, 12)} — ciphertext deleted; a signed tombstone remains (honest erasure). Reason: ${reason}`));
    return;
  }

  if (sub === 'restore' || flags.restore) {
    const hash = (flags.restore && flags.restore !== true) ? flags.restore : positional[1];
    if (!hash) return fail('which blob? `yay archive --restore <hash>` (writes plaintext to stdout).');
    let key; try { key = D.resolveKey(await getArchivePass(flags), arc.salt); } catch (e) { return fail(e.message); }
    let pt; try { pt = D.getBlob(p, hash, key); } catch (e) { return fail(e.message); }
    if (pt == null) return fail('no such blob (or it was tombstoned).');
    process.stdout.write(pt);
    return;
  }

  if (sub === 'verify' || flags.verify) {
    let key; try { key = D.resolveKey(await getArchivePass(flags), arc.salt); } catch (e) { return fail(e.message); }
    const files = Object.keys(arc.files); let bad = 0, ok = 0, tomb = 0;
    for (const f of files) {
      const rec = arc.files[f];
      if (rec.status === 'tombstoned') { tomb++; continue; }
      try { const pt = D.getBlob(p, rec.hash, key); if (pt == null) { bad++; console.log('  ' + U.c.red('✗ ') + f + U.c.dim(' — blob missing')); } else ok++; }
      catch (e) { bad++; console.log('  ' + U.c.red('✗ ') + f + U.c.dim(' — ' + e.message)); }
    }
    console.log('\n  ' + (bad ? U.c.red(`${bad} bad`) : U.c.green('all blobs decrypt + anchor')) + U.c.dim(` · ${ok} ok · ${tomb} tombstoned`));
    if (flags.strict) process.exit(bad ? 1 : 0);
    return;
  }

  // Default: archive the covered (signed) source files.
  const quiet = !!flags.quiet;
  const manifest = buildManifest(flags.dir || p.root);
  const verified = verifyManifest(manifest, lock, config, { mutate: false, roster: loadRoster(p), grants: loadGrants(p), rejections: loadRejections(p), tracked: trackedFiles(p.root),root: trustRootPin(flags) });
  // Files that hold at least one signed Cell — "the source as signed."
  const coveredFiles = {};
  for (const id of Object.keys(verified.results)) { const r = verified.results[id]; const c = manifest.cells[id]; if (r.trust && r.trust.signed && c && c.file) (coveredFiles[c.file] = coveredFiles[c.file] || []).push(id); }
  const fileList = Object.keys(coveredFiles);
  if (!fileList.length) { if (!quiet) console.log(U.c.dim('nothing signed to archive yet — sign some Cells first.')); return; }

  let key; try { key = D.resolveKey(await getArchivePass(flags), arc.salt); } catch (e) { return fail(e.message); }
  // Pre-archive SECRET SCAN — refuse to seal secrets into a permanent archive.
  const flagged = [];
  const contents = {};
  for (const f of fileList) {
    let txt = ''; try { txt = fs.readFileSync(path.join(p.root, f), 'utf8'); } catch (_) { continue; }
    contents[f] = txt;
    const hits = D.secretScan(txt);
    if (hits.length) flagged.push({ file: f, hits });
  }
  if (flagged.length && !flags['allow-secrets']) {
    console.log(U.c.red('✗ refusing to archive — possible secrets found (they would be preserved forever):'));
    for (const fl of flagged) for (const h of fl.hits) console.log('  ' + U.c.red('• ') + fl.file + ':' + h.line + U.c.dim(' — ' + h.kind));
    return fail('remove the secrets, or override with --allow-secrets (NOT recommended).');
  }
  let stored = 0, deduped = 0;
  for (const f of fileList) {
    if (!(f in contents)) continue;
    const res = D.putBlob(p, contents[f], key);
    arc.files[f] = { hash: res.hash, size: res.size, cells: coveredFiles[f], at: new Date().toISOString(), status: 'stored' };
    if (res.existed) deduped++; else stored++;
  }
  arc.retention = (config.provenance && config.provenance.retention) || arc.retention || null;
  D.saveArchive(p, arc);
  // Record a reconstructable SNAPSHOT — the file→blob-hash map for this exact state, tied to its
  // verification. Blobs are already deduped/preserved; this index is what lets a HISTORICAL tree be
  // rebuilt later (the reverify substrate). Best-effort: never fail an archive over the index.
  try {
    const snapFiles = {};
    for (const f of fileList) if (arc.files[f] && arc.files[f].status !== 'tombstoned') snapFiles[f] = arc.files[f].hash;
    const last = A.latestEntry(p, config);
    D.recordSnapshot(p, { at: new Date().toISOString(), codeTreeHash: A.codeTreeHashOf(manifest), attest: last ? last.hash : null, files: snapFiles });
  } catch (_) { /* index is additive; a failure here never blocks archiving */ }
  if (!quiet) {
    console.log(U.c.green(`✓ archived ${fileList.length} signed file(s)`) + U.c.dim(` — ${stored} new · ${deduped} unchanged${flagged.length ? ' · ' + U.c.yellow(flagged.length + ' had secrets (forced)') : ''}`));
    console.log('  ' + U.c.dim('encrypted (AES-256-GCM), sha256-anchored → ') + U.c.bold('.yaylayer/archive/') + U.c.dim(' + clear signed metadata in .yaylayer/archive.json (commit both). Key never stored.'));
  }
}
function getArchivePass(flags) { return process.env.YAY_ARCHIVE_KEY ? Promise.resolve(null) : getPassphrase(flags, 'Enter the project archive passphrase (never stored)'); }
function localSignerName(p, config) { try { const owners = (config && config.owners) || []; return owners.find((n) => fs.existsSync(path.join(p.keys, `${n}.keystore`))) || owners[0] || null; } catch (_) { return null; } }

// `yay capability` — print the verifier's derived capability descriptor + fingerprint, and whether
// the declared version matches (drift = detectors changed without a version bump).
function cmdCapability(flags) {
  const chk = CAP.assertCapability();
  const d = CAP.describeCapability();
  console.log(U.c.bold('Verifier capability ') + U.c.accent(chk.declared) + U.c.dim('  · fingerprint ' + chk.actual.slice(0, 16) + '…'));
  console.log('  ' + U.c.dim('provers: ') + d.provers.join(', '));
  console.log('  ' + U.c.dim('effect nets: ') + Object.keys(d.effectNets).join(', '));
  console.log('  ' + U.c.dim('checks: ') + d.checks.join(', '));
  console.log('  ' + U.c.dim('policy kinds: ') + d.policyKinds.join(', '));
  console.log('\n  ' + (chk.drift
    ? U.c.red('DRIFT') + U.c.dim(` — live fingerprint ≠ the one registered for ${chk.declared}. Bump CAPABILITY + register ${chk.actual.slice(0, 16)}…`)
    : U.c.green('✓ matches the registered fingerprint') + U.c.dim(' — the declared version honestly describes the verifier.')));
  if (flags.json) console.log('\n' + JSON.stringify({ ...chk, descriptor: d }, null, 2));
  if (flags.strict) process.exit(chk.drift ? 1 : 0);
}

// `yay reverify` (P4) — re-run verification at the CURRENT verifier capability and, if anything
// changed (a capability bump, a verdict moving Yellow→Green as a prover lands, or code drift),
// APPEND a new attestation that chains to the prior one. Never rewrites old attestations: a better
// verifier's assessment is a NEW event beside the old, so history compounds instead of being edited.
function cmdReverify(flags) {
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  const manifest = buildManifest(flags.dir || p.root);
  if (!Object.keys(manifest.cells).length) return fail('no Cells to reverify.');
  const last = A.latestEntry(p, config);
  if (!last) return fail('no prior attestation to reverify against — mint the first with `yay attest`.');
  const prevAtt = A.loadAttestation(p, config, last.hash);
  if (!prevAtt) return fail('the latest attestation object is missing or fails its integrity check — cannot reverify against it.');
  const verified = verifyManifest(manifest, lock, config, { mutate: !flags['no-mutate'], roster: loadRoster(p), grants: loadGrants(p), rejections: loadRejections(p), tracked: trackedFiles(p.root),root: trustRootPin(flags) });
  const verObj = A.buildVerification(manifest, verified, { config, policy: verified.policy });
  const diff = AS.reverifyDiff(prevAtt, verObj);

  console.log(U.c.bold('Re-verification') + U.c.dim(` — prior ${last.hash.slice(0, 12)} (capability ${diff.fromCapability}) → now capability ${diff.toCapability}`));
  if (diff.capabilityChanged) console.log('  ' + U.c.accent(`verifier capability changed ${diff.fromCapability} → ${diff.toCapability}`));
  if (!diff.changes.length && verObj.codeTreeHash === prevAtt.codeTreeHash) {
    console.log('  ' + U.c.green('✓ no change') + U.c.dim(' — same verdicts, same code, same capability. Nothing appended (the prior attestation still stands).'));
    return;
  }
  for (const ch of diff.changes) {
    const arrow = ch.from + ' → ' + ch.to + (ch.toProven && !ch.fromProven ? ' (now machine-proven)' : '');
    console.log('  ' + (ch.to === 'GREEN' ? U.c.green('▲') : (ch.from === 'GREEN' ? U.c.red('▼') : U.c.yellow('•'))) + ' ' + ch.cell + U.c.dim(' · ' + arrow));
  }
  console.log(U.c.dim(`  ${diff.improved} improved · ${diff.regressed} regressed · ${diff.changes.length} changed`));
  if (!verified.passed && !flags.force) return fail('gate is BLOCKED — refusing to append a failing re-verification. Pass --force to record it anyway.');
  const capChk = CAP.assertCapability();
  if (capChk.drift && !flags['allow-capability-drift']) return fail(`verifier capability DRIFT — detectors changed without a version bump (actual ${capChk.actual.slice(0, 16)}…). Bump CAPABILITY in src/capability.js + register it, or pass --allow-capability-drift.`);
  const id = A.verifierIdentity(p, config);
  A.pinVerifier(config, id) && U.writeJSON(p.config, config);
  const att = A.signAttestation(verObj, id);
  A.appendAttestation(p, config, att);
  console.log('\n' + U.c.green('✓ appended re-verification') + U.c.dim(` ${att.hash.slice(0, 16)} (chained to ${att.prev.slice(0, 12)}) — old attestations are untouched.`));
}

// `yay witness` (P4) — integrity witness: cross-check the append-only ledgers against each other and
// the code on disk. Answers "is the record internally sound, and does it still describe reality?"
function cmdWitness(flags) {
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  const manifest = buildManifest(flags.dir || p.root);
  const w = AS.integrityWitness({
    ledger: A.loadLedger(p, config),
    loadAttestation: (h) => A.loadAttestation(p, config, h),
    currentCodeTreeHash: A.codeTreeHashOf(manifest),
    approvals: (lock && lock.approvals) || [],
    hasSpecObject: (h) => O.hasObject(p.root, h),
  });
  const c = w.checks;
  console.log(U.c.bold('Integrity witness'));
  console.log('  ' + (c.chainOk ? U.c.green('✓') : U.c.red('✗')) + U.c.dim(` attestation chain — ${c.attestationsValidated}/${c.attestations} validated`));
  console.log('  ' + (c.latestCovered ? U.c.green('✓') : (c.attestations ? U.c.yellow('⚠') : U.c.dim('–'))) + U.c.dim(` latest attestation covers the current code`));
  console.log('  ' + (c.specsMissing ? U.c.red('✗') : U.c.green('✓')) + U.c.dim(` spec archive — ${c.specsChecked - c.specsMissing}/${c.specsChecked} signed spec revisions archived`));
  for (const pb of w.problems) console.log('  ' + U.c.red('• ') + pb);
  console.log('\n  ' + (w.ok ? U.c.green('WITNESS: SOUND') : U.c.red('WITNESS: PROBLEMS')) + U.c.dim(' (git/tree vs ledger vs spec-archive)'));
  if (flags.strict) process.exit(w.ok ? 0 : 1);
}

// `yay metrics` (P4) — earned-autonomy metrics from the rejection + delegation history.
function cmdMetrics(flags) {
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  const m = AS.earnedAutonomy(loadRejections(p), (lock && lock.approvals) || []);
  console.log(U.c.bold('Earned-autonomy metrics') + U.c.dim(' — from delegation + ratification + rejection history'));
  console.log('  ' + U.c.dim(`delegated Cells: ${m.delegated} · ratified: ${m.ratified} · rejected: ${m.rejected}` + (m.ratifiedRate != null ? ` · ratified rate ${Math.round(m.ratifiedRate * 100)}%` : '')));
  const cats = Object.keys(m.byCategory);
  if (cats.length) { console.log('  ' + U.c.bold('rejections by category:')); for (const cat of cats.sort((a, b) => m.byCategory[b] - m.byCategory[a])) console.log('    ' + U.c.red(String(m.byCategory[cat])) + U.c.dim(' × ' + cat)); }
  else console.log('  ' + U.c.dim('no rejections recorded yet.'));
  for (const s of m.suggestions) console.log('  ' + U.c.yellow('→ ') + s);
}

// `yay attest list` / `yay attest verify` — read the ledger; re-check every stored attestation.
async function cmdAttestList(flags, positional) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const sub = positional[0];
  const led = A.loadLedger(p, config);
  if (sub === 'verify') {
    const pub = A.verifierPub(p, config);
    if (!led.entries.length) { console.log(U.c.dim('no attestations to verify.')); return; }
    // Optional: cross-check each attestation's declared capability against the public registry at
    // yaylayer.com/verify, so a fingerprint that claims more than the canonical version is caught.
    let registry = null;
    if (flags.registry) {
      try { const r = await fetch(registryBase(flags) + '/capabilities.json'); registry = (await r.json()).capabilities || {}; }
      catch (e) { console.log(U.c.yellow('  ⚠ could not reach the capability registry') + U.c.dim(' — ' + ((e && e.message) || 'offline') + '; checking signatures only.')); }
    }
    let bad = 0, capBad = 0;
    for (const e of led.entries) {
      let raw = null; try { raw = JSON.parse(fs.readFileSync(A.attFile(p, e.hash), 'utf8')); } catch (_) { raw = null; }
      const chk = raw ? A.verifyAttestation(raw, pub) : { ok: false, reason: 'attestation object missing' };
      if (!chk.ok) bad++;
      let capNote = '';
      if (registry && raw) {
        const reg = registry[raw.capability];
        if (!reg) capNote = U.c.yellow(' · capability ' + raw.capability + ' not in registry');
        else if (raw.capabilityFingerprint && reg.fingerprint !== raw.capabilityFingerprint) { capBad++; capNote = U.c.red(' · ✗ capability fingerprint ≠ registry (over-claim!)'); }
        else if (raw.capabilityFingerprint) capNote = U.c.green(' · ✓ capability matches registry');
      }
      console.log('  ' + (chk.ok ? U.c.green('✓') : U.c.red('✗')) + ' ' + e.hash.slice(0, 16) + U.c.dim(` · ${e.at.slice(0, 16).replace('T', ' ')} · ${e.passed ? 'PASS' : 'BLOCKED'}`) + (chk.ok ? '' : U.c.red(' — ' + chk.reason)) + capNote);
    }
    console.log('\n  ' + ((bad || capBad) ? U.c.red(`${bad} invalid${capBad ? ', ' + capBad + ' capability-mismatched' : ''}`) : U.c.green('all attestations valid' + (registry ? ' + capability matches the registry' : ''))) + U.c.dim(` · verifier of record ${(config.verifier && config.verifier.fp) || '(unpinned)'}`));
    if (flags.strict) process.exit((bad || capBad) ? 1 : 0);
    return;
  }
  if (!led.entries.length) { console.log(U.c.dim('no attestations yet — mint one with ') + U.c.bold('yay attest') + U.c.dim('.')); return; }
  console.log(U.c.bold(`${led.entries.length} attestation(s)`) + U.c.dim(` · capability ${led.capability} · verifier ${(config.verifier && config.verifier.fp) || '(unpinned)'}`));
  for (const e of led.entries.slice().reverse()) {
    console.log('  ' + U.c.bold(e.hash.slice(0, 16)) + U.c.dim(` · ${e.at.slice(0, 16).replace('T', ' ')} · ${e.passed ? U.c.green('PASS') : U.c.red('BLOCKED')} · code-tree ${e.codeTreeHash.slice(0, 12)} · cap ${e.capability}`));
  }
}

// Per-Cell "last changed" timeline, DERIVED (not stored in the spec):
//   1. lock chain — the most recent signed approval that included the Cell
//   2. git — last commit that touched the Cell's file
//   3. filesystem mtime — last resort
// P4 — per-Cell SEMANTIC TIMELINE: one chronological strip of a Cell's provenance events, stitched
// from the append-only ledgers (approvals, attestations, rejections). Events: signed / delegated /
// ratified (a human sign after a delegation) / attested (a verifier attestation whose evidence
// includes the Cell) / rejected. Returns { cellId: [{at, kind, text}] } sorted oldest→newest.
function buildCellTimelines(p, config, manifest, lock) {
  const out = Object.create(null);
  const push = (id, at, kind, text) => { if (!id) return; (out[id] = out[id] || []).push({ at: at || null, kind, text }); };
  const delegatedBefore = Object.create(null); // id → earliest delegation time (to detect ratification)
  for (const ap of (lock && lock.approvals) || []) {
    const ids = Object.keys(ap.items || {});
    for (const id of ids) {
      if (ap.autoApproved) { push(id, ap.at, 'delegated', `delegated under grant ${ap.grant || '?'}`); if (!delegatedBefore[id] || Date.parse(ap.at) < delegatedBefore[id]) delegatedBefore[id] = Date.parse(ap.at) || 0; }
      else {
        const ratifying = delegatedBefore[id] && (Date.parse(ap.at) || 0) >= delegatedBefore[id];
        push(id, ap.at, ratifying ? 'ratified' : 'signed', (ratifying ? 'ratified (signed for real) by ' : 'signed by ') + (ap.signer || '?'));
      }
    }
  }
  // rejections (P3)
  try { const rj = loadRejections(p); for (const e of ((rj && rj.events) || [])) { if (e.type !== 'reject') continue; for (const id of (e.cells || [])) push(id, e.at, 'rejected', `rejected (${e.category || 'other'}) by ${e.signer || e.by || '?'} — ${e.reason || ''}`); } } catch (_) {}
  // attestations (P2): load each once, index the cells it vouches for
  try {
    const led = A.loadLedger(p, config);
    for (const ent of (led.entries || [])) {
      const att = A.loadAttestation(p, config, ent.hash); if (!att || !att.evidence) continue;
      for (const id of Object.keys(att.evidence)) push(id, att.at, 'attested', `verifier attestation ${String(ent.hash).slice(0, 10)} — ${att.evidence[id].state}${att.evidence[id].proven ? ' (proven)' : ''}`);
    }
  } catch (_) {}
  for (const id of Object.keys(out)) out[id].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  return out;
}

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
  const verified = verifyManifest(manifest, lock, config, { mutate: false, roster: loadRoster(p), grants: loadGrants(p), rejections: loadRejections(p), tracked: trackedFiles(p.root),root: trustRootPin(flags) });
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
// The signed-Brief ledger (newest first), each seal re-verified so a tampered/forged one
// can be flagged. Shared by the map's Briefs/Tags tabs and the `yay briefs` command.
function collectBriefs(config, lock, drv) {
  const cfgSigners = (config && config.signers) || {};
  return (lock.approvals || []).filter((a) => a.brief && a.brief.text).map((a) => {
    const b = a.brief;
    const { signature, ...rest } = a;
    const trustedPubs = (drv.roster && drv.roster[a.signer]) || U.pubKeysOf(cfgSigners[a.signer]) || [];
    let valid = false;
    try { valid = !!signature && trustedPubs.some((pub) => pub && C.verify(U.canonical(rest), signature, pub)); } catch (_) { valid = false; }
    return { id: a.id, at: a.at, signer: a.signer, title: (b.title || ''), text: b.text, orderedBy: (b.orderedBy || ''), tags: b.tags || [], cells: Object.keys(a.items || {}), valid, auto: !!a.autoApproved, grant: a.grant || null };
  }).reverse();
}

// `yay briefs` — the Brief ledger in the terminal. Newest-first by default; --by-tag groups
// by tag (tag first, date second); --tag <name> filters to one tag.
function cmdBriefs(flags) {
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  const drv = rosterMod.deriveRoster(loadRoster(p) || { events: [] });
  let briefs = collectBriefs(config, lock, drv);
  if (!briefs.length) { console.log(U.c.dim('no Briefs yet — sign a change-set with a Brief (`yay sign --brief "…"`).')); return; }
  const filterTag = (flags.tag && flags.tag !== true) ? String(flags.tag) : null;
  if (filterTag) briefs = briefs.filter((b) => (b.tags || []).some((t) => tagsMod.norm(t) === tagsMod.norm(filterTag)));
  const suffix = filterTag ? `, tag "${filterTag}"` : '';
  const line = (b) => {
    const when = String(b.at || '').slice(0, 10);
    console.log('  ' + (b.valid ? U.c.green('✓') : U.c.red('⚠')) + ' ' + U.c.accent(b.id) + U.c.dim(' · ' + when + (b.signer ? ' · ' + b.signer : '')));
    if (b.title) { console.log('    ' + U.c.bold(b.title)); console.log('    ' + U.c.dim(b.text)); }
    else console.log('    ' + b.text);
    if ((b.tags || []).length) console.log('    ' + b.tags.map((t) => U.c.dim('#') + U.c.bold(t)).join('  '));
  };
  if (flags['by-tag']) {
    const byTag = {};
    briefs.forEach((b) => ((b.tags && b.tags.length) ? b.tags : ['(untagged)']).forEach((t) => { (byTag[t] = byTag[t] || []).push(b); }));
    const names = Object.keys(byTag).sort((a, z) => (a === '(untagged)' ? 1 : z === '(untagged)' ? -1 : a.localeCompare(z)));
    console.log(U.c.bold('Briefs by tag') + U.c.dim(` (${briefs.length} total${suffix}):`));
    names.forEach((t) => { console.log('\n' + U.c.bold(t === '(untagged)' ? t : '#' + t) + U.c.dim(' · ' + byTag[t].length)); byTag[t].forEach(line); });
  } else {
    console.log(U.c.bold('Briefs') + U.c.dim(` — newest first (${briefs.length}${suffix}):`));
    briefs.forEach(line);
  }
}

function buildMapHTML(p, config, lock, flags) {
  const manifest = buildManifest(flags.dir || p.root);
  // Per-Cell spec diff vs last commit, so each Cell's detail can show what changed there.
  for (const id of Object.keys(manifest.cells)) { manifest.cells[id].diff = specDiffForCell(p.root, manifest.cells[id]); }
  const verified = verifyManifest(manifest, lock, config, { mutate: !flags['no-mutate'], roster: loadRoster(p), grants: loadGrants(p), rejections: loadRejections(p), tracked: trackedFiles(p.root),root: trustRootPin(flags) });
  const { changes, times } = cellChanges(manifest.root, lock, manifest.cells);
  // P4: attach each Cell's semantic timeline (approvals/attestations/rejections) to its times entry.
  const timelines = buildCellTimelines(p, config, manifest, lock);
  for (const id of Object.keys(timelines)) { times[id] = times[id] || {}; times[id].timeline = timelines[id]; }
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
  const briefs = collectBriefs(config, lock, drv);
  // Signing policy for the Policy tab: enforced (owner-signed, in the roster) vs the draft
  // file, plus the Cells currently violating it.
  const polViol = Object.keys(verified.results)
    .filter((id) => verified.results[id].policyOk === false)
    .map((id) => ({ id, note: ((verified.results[id].notes || []).find((n) => /^policy:/.test(n.text)) || {}).text || 'requires a specific signer' }));
  const policyInfo = {
    enforced: (drv.policy && drv.policy.rules) || [],
    draft: policyMod.loadPolicy(p).rules,
    violations: polViol,
    signers: signers.map((s) => s.name),
    signMethod: signMethodOf(config), // 'local' (keystore on this machine) or 'phone' (mobile) — tunes the Apply-button wording
  };
  const tagSets = tagsMod.TAG_SETS.map((s) => ({ id: s.id, name: s.name, desc: s.desc, tags: s.tags || [] }));
  // P2/P3 provenance surfaces for the dashboard: active grants (with envelopes) for the meaningful
  // ratify screen, the append-only rejection ledger, and the current verifier-attestation status.
  const extra = (function () {
    let grants = [];
    try {
      const glog = loadGrants(p);
      if (glog && glog.events) {
        const ownerPubs = Object.keys(drv.roles || {}).filter((n) => drv.roles[n] === 'owner').reduce((a, n) => a.concat(drv.roster[n] || []), []);
        const g = grantsMod.deriveGrants(glog, ownerPubs, lock.approvals);
        grants = Object.values(g).map((x) => ({ id: x.id, active: x.active, revoked: x.revoked, expired: x.expired, spent: x.spent, maxCount: x.maxCount, remaining: x.remaining, expiresAt: x.expiresAt, parent: x.parent || null, envelope: grantsMod.envelopeOf(x), chain: x.chain || null }));
      }
    } catch (_) {}
    let rejections = [];
    try { const rj = loadRejections(p); if (rj && rj.events) rejections = rj.events.filter((e) => e.type === 'reject').map((e) => ({ id: e.id, cells: e.cells || [], reason: e.reason, category: e.category, grants: e.grants || [], signer: e.signer || e.by, at: e.at })); } catch (_) {}
    let attest = null;
    try {
      const last = A.latestEntry(p, config);
      if (last) { const covered = last.codeTreeHash === A.codeTreeHashOf(manifest); attest = { hash: last.hash, at: last.at, passed: last.passed, capability: last.capability, covered, fp: (config.verifier && config.verifier.fp) || null }; }
    } catch (_) {}
    // Verifier capability descriptor for the Capabilities view (derived from the live provers/nets/checks).
    let capability = null;
    try { capability = { version: CAP.CAPABILITY, fingerprint: CAP.capabilityFingerprint(), descriptor: CAP.describeCapability(), pinned: (config.verifier && { fp: config.verifier.fp, capability: config.verifier.capability }) || null }; } catch (_) {}
    return { grants, rejections, attest, timelines, capability, demo: !!flags.demo };
  })();
  return { html: renderMap(manifest, verified, config && config.project, changes, times, planDoc, gov, briefs, tagsMod.loadTags(p), policyInfo, tagSets, batchConfig(config), extra), count: Object.keys(verified.results).length };
}

// A cheap fingerprint of the state the map depends on, so the dashboard can tell
// the page "something changed, reload" without rebuilding the whole map each poll.
function stateVersion(p) {
  const parts = [];
  const dir = path.dirname(p.config);
  for (const f of ['config.json', 'lock.json', 'roster.json', 'plan.json', 'tags.json', 'policy.json']) {
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
// Read the shipped manual as plain text — the assistant's reference context.
function readManualText() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'documentation', 'manual.html'), 'utf8');
    return raw.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
      .replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, 48000);
  } catch (_) { return ''; }
}

// The repo assistant — answer questions about THIS project + the manual using the configured
// (System Plan) LLM. Pre-populates the model with the live project STATE and the MANUAL.
async function askRepo(question, flags) {
  const { p, config, lock } = loadState();
  if (!config) return { ok: false, error: 'run `yay init` first' };
  const q = String(question || '').trim();
  if (!q) return { ok: false, error: 'ask a question' };
  const auth = resolvePlanAuth(config, flags);
  if (auth.error) return { ok: false, error: auth.error };
  const manifest = buildManifest(p.root);
  const verified = verifyManifest(manifest, lock, config, { mutate: false, roster: loadRoster(p), grants: loadGrants(p), rejections: loadRejections(p), tracked: trackedFiles(p.root), root: trustRootPin(flags) });
  const cells = Object.keys(verified.results).sort().map((id) => { const r = verified.results[id], m = manifest.cells[id] || {}; return { id, unit: (m.unitName || (m.spec && m.spec.unit) || r.name || ''), state: r.state, file: r.file, signer: (r.trust && r.trust.signer) || null, delegated: !!(r.trust && r.trust.auto), intent: (m.spec && m.spec.intent) || '', notes: (r.notes || []).map((n) => n.text) }; });
  const briefs = ((lock && lock.approvals) || []).map((a) => ({ id: a.id, at: a.at, signer: a.signer, delegated: !!a.autoApproved, title: (a.brief && (a.brief.title || a.brief.text)) || a.title || '', tags: (a.brief && a.brief.tags) || a.tags || [], cells: Object.keys(a.items || {}) }));
  const grants = (((loadGrants(p) || {}).events) || []).filter((e) => e.type === 'grant').map((e) => ({ id: e.id, envelope: e.envelope, expiresAt: e.expiresAt, maxCount: e.maxCount }));
  const rejections = (((loadRejections(p) || {}).events) || []).map((e) => ({ cells: e.cells, reason: e.reason, category: e.category, at: e.at, by: e.signer || e.by }));
  const digest = { project: config.project, gate: verified.passed ? 'PASS' : 'BLOCKED', counts: verified.counts, foundation: verified.foundation || null, cells, briefs, grants, rejections };
  const system = 'You are the YayLayer assistant for THIS project. You are given (1) the live PROJECT STATE as JSON — every Cell with its verifier state (GREEN/YELLOW/RED/UNSIGNED/PINK), signer, whether it is delegated, plus briefs, grants, rejections and the gate status — and (2) the YayLayer MANUAL. Answer the user\'s question accurately and concisely. For list/count questions use the PROJECT STATE (UNSIGNED = needs a human signature/approval; RED = code contradicts its spec; PINK = un-specced code; delegated = approved under a grant, awaiting human ratification). For "how does X work" questions use the MANUAL. Never invent Cells, states, or features; if the data does not contain the answer, say so plainly. Prefer short bullet lists. '
    + 'When you reference a Cell, cite its id EXACTLY as it appears in the PROJECT STATE "id" field — copy it character-for-character, add no prefix and change nothing (ids may look like C-3f2a-7, C-041, or a PINK id in «guillemets» such as «module-level code»). Do NOT wrap a Cell id in backticks or code formatting — write the bare id so the dashboard can turn it into a clickable link. PINK Cells are un-specced code with no real Cell yet: refer to them by their exact «guillemet» id and their file, and note they need `yay adopt` to bring them under a spec.';
  const user = 'PROJECT STATE (JSON):\n' + JSON.stringify(digest) + '\n\nMANUAL (reference):\n' + readManualText() + '\n\nQUESTION: ' + q;
  try {
    const answer = await plan.chat(system, user, { provider: auth.provider, model: auth.model, apiKey: auth.apiKey, baseUrl: auth.baseUrl, maxTokens: 1400 });
    return { ok: true, answer: String(answer || '').trim(), provider: auth.provider, model: auth.model };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

async function cmdAsk(flags, positional) {
  const q = (positional || []).join(' ').trim() || (flags.q && flags.q !== true ? String(flags.q) : '');
  if (!q) return fail('usage: yay ask "your question about this repo or how YayLayer works"');
  process.stdout.write(U.c.dim('thinking…\n'));
  const r = await askRepo(q, flags);
  if (!r.ok) return fail(r.error);
  console.log('\n' + r.answer + '\n' + U.c.dim(`— ${r.provider}/${r.model}`));
}

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

  // Preview: run package.json scripts (dev server, build…) as background children, keyed by
  // name, so the dashboard can show a live link + output and stop them. Killed on Ctrl-C.
  const runningScripts = {};
  const readScripts = () => { try { const pk = JSON.parse(fs.readFileSync(path.join(p.root, 'package.json'), 'utf8')); return (pk && pk.scripts) || {}; } catch (_) { return {}; } };
  const scriptSnapshot = () => ({
    scripts: Object.entries(readScripts()).map(([name, cmd]) => ({ name, cmd })),
    running: Object.keys(runningScripts).map((name) => { const r = runningScripts[name]; return { name, url: r.url, alive: !!r.alive, startedAt: r.startedAt, output: r.output.join('').slice(-4000) }; }),
  });
  const runScript = (name) => {
    const sc = readScripts();
    if (!sc[name]) return { ok: false, error: 'no such script' };
    const ex = runningScripts[name];
    if (ex && ex.alive) return { ok: true, already: true };
    const child = require('child_process').spawn('npm', ['run', name], { cwd: p.root, detached: true, env: process.env });
    const rec = { child, output: [], url: null, alive: true, startedAt: Date.now() };
    runningScripts[name] = rec;
    const onData = (d) => {
      rec.output.push(d.toString());
      if (rec.output.length > 500) rec.output.splice(0, rec.output.length - 500);
      if (!rec.url) { const m = String(d).replace(/\x1b\[[0-9;]*m/g, '').match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0)(?::\d+)?[^\s'"]*/i); if (m) rec.url = m[0].replace(/0\.0\.0\.0/, 'localhost'); }
    };
    child.stdout.on('data', onData); child.stderr.on('data', onData);
    child.on('exit', () => { rec.alive = false; });
    child.on('error', (e) => { rec.alive = false; rec.output.push('\n[spawn error] ' + ((e && e.message) || e)); });
    return { ok: true };
  };
  const stopScript = (name) => {
    const r = runningScripts[name];
    if (!r || !r.alive) return { ok: true, already: true };
    try { process.kill(-r.child.pid, 'SIGTERM'); } catch (_) { try { r.child.kill('SIGTERM'); } catch (__) {} }
    r.alive = false; return { ok: true };
  };
  process.on('SIGINT', () => { Object.keys(runningScripts).forEach((n) => { if (runningScripts[n].alive) { try { process.kill(-runningScripts[n].child.pid, 'SIGTERM'); } catch (_) {} } }); process.exit(0); });

  let s;
  try {
    s = await dashboardMod.startDashboard({
      project: config.project,
      buildMapHTML: () => { const st = loadState(); return buildMapHTML(st.p, st.config, st.lock, flags); },
      scripts: () => scriptSnapshot(),
      runScript: (name) => runScript(String(name)),
      stopScript: (name) => stopScript(String(name)),
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
      // Teammate enrollment from the dashboard: run the normal `yay enroll --phone`
      // as a child, which routes the OWNER-signed approval to the phone (or panel) and
      // writes the roster. All trust-critical logic is the existing enroll path.
      // Policy editor (draft): append / remove a rule in .yaylayer/policy.json. Editing the
      // draft enforces nothing on its own — `policyApply` owner-signs it into the roster.
      policyAddRule: (rule) => {
        const inertOk = rule && /^(note|yellow|block)$/i.test(String(rule.inert || ''));
        const ignoreOk = rule && /^source$/i.test(String(rule.ignore || ''));
        if (!rule || !rule.match || (!rule.match.path && !rule.match.tag && !rule.match.module) || (!rule.signer && !(rule.signers && rule.signers.length) && !inertOk && !ignoreOk)) {
          return { ok: false, error: 'a rule needs a matcher (path/tag/module) and a requirement — a signer, an inert level (note/yellow/block), or ignore:source' };
        }
        const rules = policyMod.loadPolicy(p).rules;
        const clean = { match: {}, };
        for (const k of ['path', 'tag', 'module']) if (rule.match[k]) clean.match[k] = String(rule.match[k]);
        if (rule.signer) clean.signer = String(rule.signer);
        if (inertOk) clean.inert = String(rule.inert).toLowerCase();
        if (ignoreOk) clean.ignore = 'source';
        rules.push(clean);
        U.writeJSON(policyMod.policyPath(p), { rules });
        return { ok: true, rules };
      },
      policyRemoveRule: (index) => {
        const rules = policyMod.loadPolicy(p).rules;
        if (!(index >= 0 && index < rules.length)) return { ok: false, error: 'no such rule' };
        rules.splice(index, 1);
        U.writeJSON(policyMod.policyPath(p), { rules });
        return { ok: true, rules };
      },
      // Owner-sign the draft policy into the roster — routes to the phone (reuses yay policy --set).
      policyApply: () => new Promise((resolve) => {
        const child = require('child_process').spawn(process.execPath, [process.argv[1], 'policy', '--set'], { cwd: p.root });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
        child.on('exit', (code) => resolve(code === 0
          ? { ok: true, output: out.replace(/\x1b\[[0-9;]*m/g, '').trim() }
          : { ok: false, error: (out.replace(/\x1b\[[0-9;]*m/g, '').trim() || ('policy --set exited ' + code)) }));
      }),
      // Autopilot: human-ratify the delegated Cells — routes to the phone (reuses yay ratify --sign).
      // `reviewed` is the bundle hash the dashboard rendered; the CLI refuses if the tree moved since.
      ratifyApply: (reviewed) => new Promise((resolve) => {
        const args = [process.argv[1], 'ratify', '--sign'];
        if (reviewed) { args.push('--reviewed', String(reviewed)); }
        const child = require('child_process').spawn(process.execPath, args, { cwd: p.root });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
        child.on('exit', (code) => resolve(code === 0
          ? { ok: true, output: out.replace(/\x1b\[[0-9;]*m/g, '').trim() }
          : { ok: false, error: (out.replace(/\x1b\[[0-9;]*m/g, '').trim() || ('ratify --sign exited ' + code)) }));
      }),
      // Briefs-tab history lens: reconstruct a Cell AS THE BRIEF SIGNED IT (from git, matched by
      // the stored specHash), plus its current version and a then→now spec diff. Read-only.
      cellAsOf: (briefId, cellId) => {
        try {
          const lk = U.readJSON(p.lock, { approvals: [] });
          const ap = (lk.approvals || []).find((a) => a.id === briefId);
          if (!ap || !ap.items || !(cellId in ap.items)) return { ok: false, error: 'this Brief does not cover that Cell' };
          const signedHash = ap.items[cellId];
          const S = require('../src/specdiff'), H = require('../src/history');
          const manifest = buildManifest(p.root);
          const cur = manifest.cells[cellId];
          const nowBlock = cur ? cur.specBlock : null, nowCode = cur ? (cur.unitBody || null) : null, nowFile = cur ? cur.file : null;
          const drifted = !cur || cur.specHash !== signedHash;
          let then;
          if (cur && !drifted) {
            then = { found: true, current: true, source: 'current', commit: null, at: ap.at, block: nowBlock, code: nowCode };
          } else {
            // P1: the spec AS SIGNED comes from the content-addressed archive first (git-independent,
            // never blanks); git is a fallback (legacy pre-archive Briefs) and the source of the
            // then-CODE + commit (code isn't archived until Durable mode, P4).
            const archBlock = O.getObject(p.root, signedHash);
            const g = nowFile ? H.cellAsSigned(p.root, nowFile, cellId, signedHash, 200) : { found: false };
            if (archBlock != null) then = { found: true, source: 'archive', block: archBlock, code: g.found ? g.code : null, commit: g.commit || null, at: g.at || ap.at };
            else if (g.found) then = { ...g, source: 'git' };
            else then = { found: false, reason: cur ? 'the signed version wasn’t archived and could not be reconstructed from git' : 'this Cell is no longer in the codebase' };
          }
          let diff = null, nowState = null;
          if (cur) { try { const v = verifyManifest(manifest, lk, config, { mutate: false, roster: loadRoster(p), grants: loadGrants(p) }); nowState = (v.results[cellId] || {}).state || null; } catch (_) {} }
          if (then.found && cur) diff = S.lineDiff(S.normalizedToSpecLines(then.block), S.normalizedToSpecLines(nowBlock));
          return { ok: true, brief: briefId, cell: cellId, signedHash, at: ap.at, signer: ap.signer || null, drifted: !!drifted,
            then, current: cur ? { block: nowBlock, code: nowCode, file: nowFile, line: cur.line || 0, state: nowState } : null, diff };
        } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      },
      // Live tag-pool editing from the dashboard (add / remove / rename / describe). Renaming
      // a tag already used in a signed Brief is refused — it would split the history.
      tagsEdit: (op) => {
        const st = loadState();
        const cur = tagsMod.loadTags(st.p) || { project: st.config.project, set: 'custom', tags: [], descriptions: {} };
        cur.descriptions = cur.descriptions || {};
        const norm = tagsMod.norm;
        const uses = {}; for (const a of (st.lock.approvals || [])) for (const t of ((a.brief && a.brief.tags) || [])) uses[norm(t)] = (uses[norm(t)] || 0) + 1;
        const action = op && op.action;
        if (action === 'set') { // pick a starter set (or 'custom') as the WHOLE pool
          // Only allowed until the first tagged Brief is signed — a wholesale swap would
          // orphan used tags into "Retired" and split the history (same rule as rename).
          if (Object.keys(uses).length) return { ok: false, error: 'tags are already in use in signed Briefs — switching the whole set would split the history. Add or remove individual tags instead.' };
          if (op.set === 'custom') { tagsMod.saveTags(st.p, { project: st.config.project, set: 'custom', tags: tagsMod.CUSTOM_SEED.slice(), descriptions: {} }); return { ok: true }; }
          const set = tagsMod.setById(op.set);
          if (!set) return { ok: false, error: 'unknown set' };
          tagsMod.saveTags(st.p, { project: st.config.project, set: set.id, tags: set.tags.slice(), descriptions: {} });
          return { ok: true };
        }
        if (action === 'add') {
          const label = String((op.label != null ? op.label : '')).trim();
          if (!label) return { ok: false, error: 'empty tag' };
          if (!tagsMod.isKnown(cur.tags, label)) cur.tags.push(label);
        } else if (action === 'remove') {
          cur.tags = cur.tags.filter((t) => norm(t) !== norm(op.label));
          for (const k of Object.keys(cur.descriptions)) if (norm(k) === norm(op.label)) delete cur.descriptions[k];
        } else if (action === 'rename') {
          const i = cur.tags.findIndex((t) => norm(t) === norm(op.from));
          if (i < 0) return { ok: false, error: 'no such tag' };
          if (uses[norm(op.from)]) return { ok: false, error: `"${cur.tags[i]}" is used in ${uses[norm(op.from)]} signed Brief(s) — renaming would split the history. Add a new tag, or remove this one.` };
          const to = String((op.to != null ? op.to : '')).trim();
          if (!to) return { ok: false, error: 'empty new label' };
          const old = cur.tags[i]; cur.tags[i] = to;
          if (cur.descriptions[old] !== undefined) { cur.descriptions[to] = cur.descriptions[old]; delete cur.descriptions[old]; }
        } else if (action === 'desc') {
          const canon = cur.tags.find((t) => norm(t) === norm(op.label));
          if (!canon) return { ok: false, error: 'no such tag' };
          const text = String((op.text != null ? op.text : '')).trim();
          if (text) cur.descriptions[canon] = text; else delete cur.descriptions[canon];
        } else return { ok: false, error: 'unknown action' };
        tagsMod.saveTags(st.p, cur);
        return { ok: true };
      },
      // Batch settings (how many small changes group into one Brief).
      batchSet: (op) => {
        const st = loadState();
        const cur = batchConfig(st.config);
        const enabled = (op && typeof op.enabled === 'boolean') ? op.enabled : cur.enabled;
        let barrier = (op && op.barrier != null) ? parseInt(op.barrier, 10) : cur.barrier;
        if (!(barrier >= 1 && barrier <= 100)) barrier = cur.barrier;
        st.config.batch = { enabled, barrier };
        U.writeJSON(st.p.config, st.config);
        return { ok: true, batch: st.config.batch };
      },
      // Queue a plain human request the AI will turn into a Brief + Cells (see `yay requests`).
      addRequest: (text) => {
        const rp = requestsPath(p);
        const log = U.readJSON(rp, null) || { project: config.project, requests: [] };
        log.requests = log.requests || [];
        const id = 'REQ-' + String(log.requests.length + 1).padStart(3, '0');
        log.requests.push({ id, text: String(text), status: 'pending', at: new Date().toISOString() });
        U.writeJSON(rp, log);
        ensureGitignored(p.root, '.yaylayer/requests.json');
        return { ok: true, id };
      },
      enroll: ({ name, pubkey, role }) => new Promise((resolve) => {
        const args = ['enroll', '--name', String(name), '--pubkey', String(pubkey), '--phone'];
        if (role === 'owner') args.push('--role', 'owner');
        const child = require('child_process').spawn(process.execPath, [process.argv[1], ...args], { cwd: p.root });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
        child.on('exit', (code) => resolve(code === 0
          ? { ok: true, output: out.replace(/\x1b\[[0-9;]*m/g, '').trim() }
          : { ok: false, error: (out.replace(/\x1b\[[0-9;]*m/g, '').trim() || ('enroll exited ' + code)) }));
      }),
      // Issue an Autopilot grant (owner-signed) from the dashboard — spawns `yay grant … --phone`,
      // routing the owner approval to the phone (same pattern as enroll). Only a human can issue it.
      ask: (q) => askRepo(q, flags),
      protect: () => new Promise((resolve) => {
        const child = require('child_process').spawn(process.execPath, [process.argv[1], 'protect', '--phone'], { cwd: p.root });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
        child.on('exit', (code) => resolve(code === 0
          ? { ok: true, output: out.replace(/\x1b\[[0-9;]*m/g, '').trim() }
          : { ok: false, error: (out.replace(/\x1b\[[0-9;]*m/g, '').trim() || ('protect exited ' + code)) }));
      }),
      grant: (o) => new Promise((resolve) => {
        o = o || {};
        const args = ['grant', '--for', String(o.dur || '2h'), '--count', String(parseInt(o.count, 10) || 20), '--phone'];
        if (o.allow) args.push('--allow', String(o.allow));
        if (o.deny) args.push('--deny', String(o.deny));
        if (o.allowTags) args.push('--allow-tag', String(o.allowTags));
        if (o.denyTags) args.push('--deny-tag', String(o.denyTags));
        if (o.maxRisk) args.push('--max-risk', String(o.maxRisk));
        if (o.childGrants) args.push('--child-grants');
        if (o.noGuard) args.push('--no-guard');
        const child = require('child_process').spawn(process.execPath, [process.argv[1], ...args], { cwd: p.root });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        child.on('error', (e) => resolve({ ok: false, error: String((e && e.message) || e) }));
        child.on('exit', (code) => resolve(code === 0
          ? { ok: true, output: out.replace(/\x1b\[[0-9;]*m/g, '').trim() }
          : { ok: false, error: (out.replace(/\x1b\[[0-9;]*m/g, '').trim() || ('grant exited ' + code)) }));
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

  const transport = phoneTransport(config, flags);
  console.log('\n' + U.c.green('✓ yay dashboard is live') + U.c.dim(' — keep this running; scan ONCE, then approvals appear on your phone automatically.'));
  console.log('   ' + U.c.bold('this computer → ') + U.c.accent(s.local) + U.c.dim('   (the live map + buttons)'));
  if (transport === 'relay') {
    // This project signs over the relay, so the phone page is the RELAY page (not the
    // dashboard's LAN /phone, which only sees LAN-routed requests). Show that instead.
    const rs = ensureRelaySession(p, flags);
    console.log('   ' + U.c.bold('phone (relay) → ') + U.c.accent(rs.url) + U.c.dim('   (this project signs via relay.yaylayer.com — approve here, from any network)'));
    printQR(rs.url);
    console.log('   ' + U.c.dim('scan ONCE; ') + U.c.bold('yay sign') + U.c.dim(' and ') + U.c.bold('yay invite') + U.c.dim(' route to this relay page automatically. Ctrl-C to stop.'));
  } else {
    console.log('   ' + U.c.bold('phone → ') + U.c.accent(s.url + '/phone') + U.c.dim('   (scan the QR below — same Wi-Fi as this computer)'));
    printQR(s.url + '/phone');
    if (tls && tls.trusted) {
      console.log(U.c.dim('   https: ') + U.c.green('locally-trusted cert (mkcert)') + U.c.dim(' — no warning on this computer.'));
      if (caPem) console.log(U.c.dim('   phone warning-free (one-time): open ') + U.c.accent(s.url + '/trust') + U.c.dim(' on the phone → install + trust the certificate (guided).'));
    } else if (tls) {
      console.log(U.c.dim('   https: self-signed (encrypted) — tap through the one-time "not private" warning on the phone (Advanced → visit).'));
      if (caPem) console.log(U.c.dim('   or make it warning-free: open ') + U.c.accent(s.url + '/trust') + U.c.dim(' on the phone; better still ') + U.c.accent('brew install mkcert && mkcert -install') + U.c.dim(' then restart.'));
    }
    console.log('   ' + U.c.dim('`yay sign` now routes here — the request pops up on your phone. Ctrl-C to stop.'));
  }
  const tc = resolveTestCmd(p.root, config, flags);
  console.log('   ' + U.c.dim('buttons (this computer): ') + U.c.bold('▷ Preview') + U.c.dim(' (run a package.json script) · ') + U.c.bold('▶ Run tests') + U.c.dim(tc ? ` (${tc})` : ' (none)') + U.c.dim(' · ') + U.c.bold('⚔ Adversary') + U.c.dim(' · ') + U.c.bold('⟲ System Plan') + U.c.dim(' · ') + U.c.bold('≷ Changes'));
  if (flags.open) { try { require('child_process').exec((process.platform === 'darwin' ? 'open ' : 'xdg-open ') + JSON.stringify(s.local)); } catch (_) {} }
  await new Promise(() => {}); // run until Ctrl-C
}

async function cmdMap(flags) {
  const { p, config, lock } = loadState();
  const manifest = buildManifest(flags.dir || p.root);
  const verified = verifyManifest(manifest, lock, config, { mutate: !flags['no-mutate'], roster: loadRoster(p), grants: loadGrants(p), rejections: loadRejections(p), tracked: trackedFiles(p.root),root: trustRootPin(flags) });
  await maybePlanForMap(p, config, manifest, verified, flags);
  const { html, count } = buildMapHTML(p, config, lock, flags);
  const out = (flags.o && flags.o !== true) ? flags.o : (flags.out && flags.out !== true ? flags.out : 'yay-layer-map.html');
  fs.writeFileSync(out, html);
  console.log(U.c.green('✓ map written → ') + out + U.c.dim(`  (${count} items)`));
}

// `yay id` — this working copy's Cell-id shard (creates it if absent) + the next id it would mint.
function cmdId(flags) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const shard = ensureLocalShard(p);
  const taken = new Set(ledgerCellIds(p));
  try { const man = buildManifest(p.root); for (const id of Object.keys(man.cells)) taken.add(id); } catch (_) {}
  const next = IDS.nextCellId(shard, taken);
  console.log(U.c.bold('Cell-id shard: ') + U.c.accent('C-' + shard + '-…') + U.c.dim('  (unique to this working copy — in gitignored local.json, never committed)'));
  console.log('  ' + U.c.dim('next new id here → ') + U.c.bold(next));
  console.log('  ' + U.c.dim('Other clones mint under their own shard, so ids never collide when branches merge.'));
}

// `yay merge` — run this right after a `git merge`/`git pull`. Re-verifies and surfaces exactly what
// a merge can leave behind: id COLLISIONS (impossible for sharded ids; reported if two legacy flat ids
// clashed) and Cells that need a fresh signature because the same Cell was edited on both branches.
// A botched merge never goes green silently — it shows here and the gate stays blocked.
function cmdMerge(flags) {
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  const manifest = buildManifest(p.root);
  const verified = verifyManifest(manifest, lock, config, { mutate: false, roster: loadRoster(p), grants: loadGrants(p), rejections: loadRejections(p), tracked: trackedFiles(p.root), root: trustRootPin(flags) });
  const dups = (manifest.problems || []).filter((x) => /duplicate Cell id/.test(x.error || ''));
  const attention = Object.keys(verified.results).filter((id) => { const s = verified.results[id].state; return s === 'UNSIGNED' || s === 'RED'; });
  console.log(U.c.bold('Merge check · ') + config.project);
  if (!dups.length && !attention.length) {
    console.log('  ' + U.c.green('✓ clean') + U.c.dim(' — no id collisions, nothing needs re-signing.  ') + (verified.passed ? U.c.green('gate PASS') : U.c.red('gate BLOCKED')));
    return;
  }
  if (dups.length) {
    console.log('\n  ' + U.c.red(`● ${dups.length} duplicate Cell id(s)`) + U.c.dim(' — two Cells claim the same id (a collision):'));
    for (const d of dups) console.log('    ' + U.c.bold(d.id) + U.c.dim('  ' + d.file + ' — ' + d.error));
    console.log('  ' + U.c.dim('Renumber one side to a fresh ') + U.c.bold('C-' + ensureLocalShard(p) + '-<n>') + U.c.dim(' (see `yay id`), then re-sign it. Sharded ids prevent this going forward.'));
  }
  if (attention.length) {
    console.log('\n  ' + U.c.yellow(`● ${attention.length} Cell(s) need attention`) + U.c.dim(' — unsigned or failing (a Cell edited on both branches drops its old signature):'));
    for (const id of attention.slice(0, 40)) console.log('    ' + U.c.bold(id) + '  ' + (verified.results[id].state === 'RED' ? U.c.red('RED — fix, then sign') : U.c.gray('UNSIGNED — sign')));
    if (attention.length > 40) console.log('    ' + U.c.dim(`… and ${attention.length - 40} more`));
    console.log('  ' + U.c.dim('Reconcile each, then ') + U.c.bold('yay sign') + U.c.dim('.'));
  }
  console.log('\n  ' + (verified.passed ? U.c.green('gate PASS') : U.c.red('gate BLOCKED')) + U.c.dim(' — a merge never silently corrupts state; anything unresolved shows here and blocks the gate.'));
  process.exitCode = dups.length ? 1 : 0;
}

// Loose module-level code (a bare statement/call at import scope) can't be safely auto-wrapped — that
// means rewriting import-time behaviour — so `adopt` never touches it. Surface it clearly and hand it to
// the AI (Constitution Art. 6), rather than skipping it silently and leaving someone to think it's covered.
function reportLooseCode(target) {
  try {
    const man = buildManifest(path.resolve(target));
    const loose = (man.untracked || []).filter((u) => u.kind === 'loose');
    if (!loose.length) return;
    console.log('\n' + U.c.pink(`◆ ${loose.length} module-level (loose) code region(s) stay Pink`) + U.c.dim(' — adopt won\'t rewrite code, so these aren\'t auto-wrapped:'));
    for (const u of loose.slice(0, 10)) console.log('    ' + U.c.dim(u.file + ':' + u.line) + (u.count ? U.c.dim(`  (~${u.count} line(s))`) : ''));
    if (loose.length > 10) console.log('    ' + U.c.dim(`… and ${loose.length - 10} more`));
    console.log('  ' + U.c.dim('Ask your AI to wrap each into a spec\'d unit (Constitution Art. 6 — an IIFE around a spec\'d function in JS/TS, or an entry point in Python); it understands the code, so it wraps it safely.'));
  } catch (_) {}
}

async function cmdAdopt(flags, positional) {
  const target = positional[0] || '.';
  const pAd = U.paths(path.resolve(target));
  const res = adopt(target, { dry: !!flags.dry, shard: ensureLocalShard(pAd), ledgerIds: ledgerCellIds(pAd) });
  if (!res.total) console.log(U.c.dim('nothing to adopt — no un-specced named units found (functions/methods).'));
  else {
    console.log((res.dry ? U.c.yellow('(dry run) ') : U.c.green('✓ ')) + `${res.total} draft Cell(s) across ${res.report.length} file(s):`);
    for (const r of res.report) console.log('  ' + U.c.dim(r.file) + '  +' + r.added);
    console.log('\n  Next: prune each DERIVED spec, then ' + U.c.bold('yay sign') + '.');
  }
  reportLooseCode(target); // pink loose code adopt can't wrap → point to the AI (Art. 6)
  if (!flags.dry && res.total) { try { const { p, config } = loadState(); if (config) await foundationPosturePrompt(p, config, flags, process.stdin.isTTY); } catch (_) {} }
}

// Batch settings live in config.json (committed, shared). Default: on, barrier 5.
function batchConfig(config) {
  const b = (config && config.batch) || {};
  return { enabled: b.enabled !== false, barrier: (b.barrier >= 1 && b.barrier <= 100) ? b.barrier : 5 };
}
// `yay batch` — how the AI groups small changes into one Brief before asking you to sign.
function cmdBatch(flags, positional) {
  const { p, config } = loadState();
  if (!config) return fail('run `yay init` first');
  const cur = batchConfig(config);
  const sub = positional[0];
  const setN = (sub && /^\d+$/.test(sub)) ? parseInt(sub, 10) : (flags.barrier && flags.barrier !== true ? parseInt(flags.barrier, 10) : null);
  if (sub === 'off' || flags.off) { config.batch = { enabled: false, barrier: cur.barrier }; U.writeJSON(p.config, config); console.log(U.c.green('✓ batch mode OFF') + U.c.dim(' — every change gets its own Brief. Commit .yaylayer/config.json.')); return; }
  if (sub === 'on' || flags.on) { config.batch = { enabled: true, barrier: cur.barrier }; U.writeJSON(p.config, config); console.log(U.c.green(`✓ batch mode ON`) + U.c.dim(` — barrier ${cur.barrier}. Commit .yaylayer/config.json.`)); return; }
  if (setN != null) {
    if (!(setN >= 1 && setN <= 100)) return fail('barrier must be a number 1–100');
    config.batch = { enabled: true, barrier: setN }; U.writeJSON(p.config, config);
    console.log(U.c.green(`✓ batch barrier set to ${setN}`) + U.c.dim(' — the AI asks whether to close the batch after this many small changes. Commit .yaylayer/config.json.'));
    return;
  }
  console.log(U.c.bold('Batch mode') + (cur.enabled ? U.c.green(' ON') + U.c.dim(` · barrier ${cur.barrier}`) : U.c.yellow(' OFF')));
  console.log(U.c.dim('  Small, low-risk changes are grouped into one Brief; at the barrier the AI asks whether to close it and sign'));
  console.log(U.c.dim('  (in Autopilot the batched Brief is delegated under the grant instead). Sensitive / behaviour-changing edits always get their own Brief.'));
  console.log(U.c.dim('  set: ') + U.c.bold('yay batch <n>') + U.c.dim(' · disable: ') + U.c.bold('yay batch off') + U.c.dim(' · enable: ') + U.c.bold('yay batch on'));
}

function cmdStatus(flags) {
  flags = flags || {};
  const { p, config, lock } = loadState();
  if (!config) return console.log(U.c.dim('not initialized — run `yay init`'));
  const manifest = buildManifest(p.root);
  const verified = verifyManifest(manifest, lock, config, { mutate: false, roster: loadRoster(p), grants: loadGrants(p), rejections: loadRejections(p), tracked: trackedFiles(p.root),root: trustRootPin(flags) });
  const c = verified.counts;
  console.log(U.c.bold(config.project) + U.c.dim(`  · ${Object.keys(manifest.cells).length} Cells · ${Object.keys(config.signers).length} signer(s)`));
  console.log('  ' + U.c.green(`${c.GREEN}●`) + ' ' + U.c.yellow(`${c.YELLOW}●`) + ' ' + U.c.red(`${c.RED}●`) + ' ' + U.c.gray(`${c.UNSIGNED}○`) + '  ' + (verified.passed ? U.c.green('PASS') : U.c.red('BLOCKED')));
  const bc = batchConfig(config);
  if (bc.enabled && c.UNSIGNED > 0) console.log('  ' + U.c.dim(`${c.UNSIGNED} unsigned Cell(s) staged toward the batch (barrier ${bc.barrier}) — `) + U.c.bold('yay sign') + U.c.dim(' to close it.'));
}

function matcherStr(m) {
  m = m || {};
  return [m.path && `path ${m.path}`, m.tag && `tag ${m.tag}`, m.module && `module ${m.module}`].filter(Boolean).join(' · ') || '(no matcher — matches nothing)';
}
function printRules(rules) {
  for (const r of rules) {
    if (r.inert) {
      const lv = String(r.inert).toLowerCase();
      const desc = lv === 'block' ? U.c.red('inert: block') + U.c.dim(' — inert code gate-blocks') : lv === 'note' ? 'inert: note' + U.c.dim(' — findings shown as info only') : U.c.yellow('inert: yellow') + U.c.dim(' — inert code caps at Yellow');
      console.log('  ' + matcherStr(r.match) + U.c.dim(' → ') + desc);
      continue;
    }
    if (r.ignore) {
      console.log('  ' + matcherStr(r.match) + U.c.dim(' → ') + 'ignore: source' + U.c.dim(' — source here may be .yaylayerignore\'d (kept out of the gate)'));
      continue;
    }
    const who = r.signer || (r.signers || []).join(' or ') || '?';
    console.log('  ' + U.c.accent(who) + U.c.dim(' must sign ') + matcherStr(r.match));
  }
}
// `yay policy` — the ENFORCED policy lives owner-signed in the roster (tamper-evident);
// `.yaylayer/policy.json` is the editable DRAFT. `--init` writes a neutral template;
// `--set` owner-signs the draft into effect. Neutral (no rules) blocks nothing.
// `yay tags` — the project's Brief-tag vocabulary. Choose/switch a starter set, or edit it.
function cmdTags(flags, positional) {
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  const sub = positional[0];
  const cur = tagsMod.loadTags(p);
  // Tags already baked into signed Briefs — their label is inside the signature and can't be
  // rewritten, so renaming one would split the history. Count uses to guard rename/remove.
  const tagUses = {};
  for (const a of (lock.approvals || [])) for (const t of ((a.brief && a.brief.tags) || [])) tagUses[tagsMod.norm(t)] = (tagUses[tagsMod.norm(t)] || 0) + 1;

  if (sub === 'sets' || flags['list-sets']) {
    console.log(U.c.bold('Starter tag sets') + U.c.dim(' — pick one with `yay tags --set <id>`:'));
    for (const s of tagsMod.TAG_SETS) {
      console.log('  ' + U.c.accent(s.id.padEnd(15)) + s.name + U.c.dim(' — ' + s.desc));
      console.log('    ' + U.c.dim(s.tags.join(', ')));
    }
    return;
  }

  const setId = (flags.set && flags.set !== true) ? String(flags.set) : (sub === 'set' ? positional[1] : null);
  if (setId) {
    if (setId === 'custom') {
      // tags.json is COMMITTED (a shared project vocabulary) — never gitignored.
      tagsMod.saveTags(p, { project: config.project, set: 'custom', tags: tagsMod.CUSTOM_SEED.slice(), descriptions: {} });
      console.log(U.c.green('✓ custom placeholders') + U.c.dim(' (Custom 1–4) → .yaylayer/tags.json. Relabel with ') + U.c.bold('yay tags rename "Custom 1" "…"') + U.c.dim(' or the dashboard Tags tab.'));
      return;
    }
    const set = tagsMod.setById(setId);
    if (!set) return fail(`unknown tag set "${setId}" — options: ${tagsMod.TAG_SETS.map((s) => s.id).join(', ')}, custom (see \`yay tags sets\`)`);
    tagsMod.saveTags(p, { project: config.project, set: set.id, tags: set.tags.slice() });
    console.log(U.c.green(`✓ tag set → "${set.name}"`) + U.c.dim(` (${set.tags.length} tags). Commit .yaylayer/tags.json.`));
    return;
  }

  if (sub === 'add') {
    const t = cur || { project: config.project, set: 'custom', tags: [] };
    const toAdd = tagsMod.parseTags([], positional.slice(1).join(','));
    if (!toAdd.length) return fail('nothing to add — e.g. `yay tags add "Payments"`');
    let n = 0; for (const x of toAdd) if (!tagsMod.isKnown(t.tags, x)) { t.tags.push(x); n++; }
    tagsMod.saveTags(p, t);
    console.log(U.c.green(`✓ added ${n} tag(s)`) + U.c.dim(` — pool is now ${t.tags.length}. Commit .yaylayer/tags.json.`));
    return;
  }
  if (sub === 'remove' || sub === 'rm') {
    if (!cur) return fail('no tag pool yet — `yay tags --set <id>` first.');
    const toRem = tagsMod.parseTags([], positional.slice(1).join(','));
    const before = cur.tags.length;
    const removedUsed = toRem.map((r) => tagUses[tagsMod.norm(r)] || 0).reduce((a, b) => a + b, 0);
    cur.tags = cur.tags.filter((x) => !toRem.some((r) => tagsMod.norm(r) === tagsMod.norm(x)));
    if (cur.descriptions) for (const r of toRem) for (const k of Object.keys(cur.descriptions)) if (tagsMod.norm(k) === tagsMod.norm(r)) delete cur.descriptions[k];
    tagsMod.saveTags(p, cur);
    console.log(U.c.green(`✓ removed ${before - cur.tags.length} tag(s)`) + U.c.dim(` — pool is now ${cur.tags.length}. Commit .yaylayer/tags.json.`));
    if (removedUsed) console.log(U.c.dim(`  note: ${removedUsed} signed Brief(s) still carry a removed tag in their history (shown under “Retired” in the dashboard) — that's preserved, it just won't be offered for new Briefs.`));
    return;
  }
  if (sub === 'rename') {
    if (!cur) return fail('no tag pool yet — `yay tags --set <id>` first.');
    const from = positional[1]; const to = positional[2];
    if (!from || !to) return fail('usage: yay tags rename "Custom 1" "Payments"');
    const i = cur.tags.findIndex((t) => tagsMod.norm(t) === tagsMod.norm(from));
    if (i < 0) return fail(`no tag "${from}" in the pool.`);
    if (tagUses[tagsMod.norm(from)]) return fail(`"${cur.tags[i]}" is already in ${tagUses[tagsMod.norm(from)]} signed Brief(s) — renaming it would split the history (past Briefs keep the old label in their signatures). Add a new tag with \`yay tags add\` instead, or \`yay tags remove\` it to stop offering it.`);
    const old = cur.tags[i]; cur.tags[i] = String(to).trim();
    cur.descriptions = cur.descriptions || {};
    if (cur.descriptions[old] !== undefined) { cur.descriptions[cur.tags[i]] = cur.descriptions[old]; delete cur.descriptions[old]; }
    tagsMod.saveTags(p, cur);
    console.log(U.c.green(`✓ renamed "${old}" → "${cur.tags[i]}"`) + U.c.dim(' — Commit .yaylayer/tags.json.'));
    return;
  }
  if (sub === 'desc' || sub === 'describe') {
    if (!cur) return fail('no tag pool yet — `yay tags --set <id>` first.');
    const label = positional[1]; const text = positional.slice(2).join(' ').trim();
    if (!label) return fail('usage: yay tags desc "Tag" "what this tag covers"');
    const canon = cur.tags.find((t) => tagsMod.norm(t) === tagsMod.norm(label));
    if (!canon) return fail(`no tag "${label}" in the pool.`);
    cur.descriptions = cur.descriptions || {};
    if (text) cur.descriptions[canon] = text; else delete cur.descriptions[canon];
    tagsMod.saveTags(p, cur);
    console.log(U.c.green(`✓ ${text ? 'set' : 'cleared'} description for "${canon}"`) + U.c.dim(' — Commit .yaylayer/tags.json.'));
    return;
  }

  if (!cur) {
    console.log(U.c.dim('No tag pool set yet. Pick a starter set (Briefs are tagged from it):'));
    console.log('  ' + U.c.bold('yay tags --set responsibility') + U.c.dim('   (see all six with ') + U.c.bold('yay tags sets') + U.c.dim(', or ') + U.c.bold('--set custom') + U.c.dim(' for blank placeholders)'));
    return;
  }
  const set = tagsMod.setById(cur.set);
  const descs = cur.descriptions || {};
  console.log(U.c.bold('Brief tags') + U.c.dim(` — set: ${set ? set.name : cur.set} · ${cur.tags.length} tags · every Brief is tagged from this pool:`));
  cur.tags.forEach((t) => console.log('  ' + U.c.accent(t) + (descs[t] ? U.c.dim(' — ' + descs[t]) : '')));
  const plan = tagsMod.planStatus(cur);
  if (!plan.ok) {
    if (plan.placeholders.length) console.log('\n' + U.c.yellow(`⚠ tag plan UNFINISHED — relabel ${plan.placeholders.map((t) => `"${t}"`).join(', ')} (\`yay tags rename\`)`) + U.c.dim(' — signing is blocked until the plan is finished (no placeholders, ≥' + tagsMod.MIN_PLAN_TAGS + ' unique tags).'));
    else console.log('\n' + U.c.yellow(`⚠ tag plan UNFINISHED — ${plan.unique}/${tagsMod.MIN_PLAN_TAGS} unique tags`) + U.c.dim(' — add more (`yay tags add "<Tag>"`); signing is blocked until the plan has at least ' + tagsMod.MIN_PLAN_TAGS + '.'));
  }
  console.log('\n' + U.c.dim('switch: ') + U.c.bold('yay tags --set <id>') + U.c.dim(' · add/remove: ') + U.c.bold('yay tags add|remove "Tag"') + U.c.dim(' · relabel: ') + U.c.bold('yay tags rename "A" "B"') + U.c.dim(' · describe: ') + U.c.bold('yay tags desc "Tag" "…"'));
}

async function cmdPolicy(flags) {
  const { p, config, lock } = loadState();
  if (!config) return fail('run `yay init` first');
  const ppath = policyMod.policyPath(p);
  if (flags.init) {
    if (fs.existsSync(ppath) && !flags.force) return fail('.yaylayer/policy.json already exists — pass --force to overwrite');
    fs.writeFileSync(ppath, policyMod.TEMPLATE);
    console.log(U.c.green('✓ wrote .yaylayer/policy.json') + U.c.dim(' — neutral (no rules). Fill in the commented examples, then ') + U.c.bold('yay policy --set') + U.c.dim(' to owner-sign it into effect.'));
    return;
  }
  if (flags.set) return cmdPolicySet(p, config, flags);

  const rlog = loadRoster(p);
  const drv = rlog ? rosterMod.deriveRoster(rlog) : null;
  const enforced = (drv && drv.policy) || { rules: [] };
  const draft = policyMod.loadPolicy(p);
  if (draft.problem) console.log(U.c.yellow('  ⚠ ' + draft.problem));
  if (!enforced.rules.length) console.log(U.c.dim('Enforced policy: none — every enrolled signer is treated the same (neutral).'));
  else { console.log(U.c.bold('Enforced policy') + U.c.dim(' (owner-signed, in the roster):')); printRules(enforced.rules); }

  if (JSON.stringify(draft.rules) !== JSON.stringify(enforced.rules)) {
    console.log('\n' + U.c.yellow('Draft in .yaylayer/policy.json differs from what is enforced:'));
    if (draft.rules.length) printRules(draft.rules); else console.log(U.c.dim('  (neutral — no rules)'));
    console.log(U.c.dim('  run ') + U.c.bold('yay policy --set') + U.c.dim(' to owner-sign the draft into effect.'));
  }

  const manifest = buildManifest(p.root);
  const verified = verifyManifest(manifest, lock, config, { mutate: false, roster: rlog, grants: loadGrants(p), rejections: loadRejections(p), tracked: trackedFiles(p.root),root: trustRootPin(flags) });
  const viol = Object.values(verified.results).filter((x) => x.policyOk === false);
  if (viol.length) {
    console.log('\n' + U.c.red(`  ${viol.length} Cell(s) violate the enforced policy:`));
    for (const v of viol) { const note = (v.notes.find((n) => /^policy:/.test(n.text)) || {}).text || ''; console.log('  ' + U.c.red('● ') + v.id + U.c.dim(' — ' + note)); }
  } else if (enforced.rules.length) {
    console.log('\n' + U.c.green('  ✓ all Cells satisfy the policy.'));
  }
}
// Owner-sign the draft policy.json into the roster (a `policy` governance event).
async function cmdPolicySet(p, config, flags) {
  const rlog = loadRoster(p);
  if (!rlog || !rlog.events || !rlog.events.length) return fail('no signed roster yet — run `yay init` first to establish the trust root.');
  const draft = policyMod.loadPolicy(p);
  if (draft.problem) return fail(draft.problem + ' — fix .yaylayer/policy.json first');
  const rules = draft.rules || [];
  const ev = { id: rosterMod.nextEventId(rlog), type: 'policy', rules, by: null, prev: rlog.events[rlog.events.length - 1].id, nonce: C.randomNonce(), at: new Date().toISOString() };
  const summary = {
    title: `Set the signing policy (${rules.length} rule${rules.length === 1 ? '' : 's'}) in ${config.project}?`,
    rows: rules.length ? rules.map((r) => ({ k: r.signer || (r.signers || []).join(' or ') || '?', v: matcherStr(r.match) })) : [{ k: '(neutral)', v: 'no rules — every signer treated the same' }],
    warn: 'Changes who must sign what. Owner-signed and tamper-evident; enforced at the gate.',
  };
  const signed = await authorizeRosterEvent(p, config, rlog, ev, flags, summary);
  if (!signed) return;
  const test = rosterMod.deriveRoster({ ...rlog, events: rlog.events.concat([signed]) });
  if (test.problems.length) return fail('refusing to write — ' + test.problems.join('; '));
  rlog.events.push(signed);
  U.writeJSON(rosterPath(p), rlog);
  console.log(U.c.green(`✓ signing policy set (${rules.length} rule${rules.length === 1 ? '' : 's'})`) + U.c.dim(` — authorized by ${signed.by}. Commit .yaylayer/roster.json; it's now enforced at the gate.`));
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
  yay id                      show THIS clone's Cell-id shard (C-<shard>-n) + the next id it would mint —
                             each working copy gets its own shard so ids never collide when branches merge
  yay merge                   run after a git merge/pull: re-verify + list any id collisions and Cells that
                             need re-signing (edited on both sides). A botched merge never goes green silently.
  yay pair [--name you]      pair your phone as the signer (key stays on the phone; scan the QR) · SSL on by default (--no-https)
                             --relay routes via relay.yaylayer.com (off-LAN, end-to-end encrypted) · --lan forces the local path
                             the FIRST pairing makes the phone the trust root — no local key needed
  yay enroll --name X --pubkey <b64>  enroll another signer via an OWNER-signed event (--role owner|signer)
  yay policy [--init|--set]   signing policy (who must sign what). --init writes a neutral template to
                             .yaylayer/policy.json; edit it, then --set owner-signs it into the roster
                             (tamper-evident, enforced at the gate). Neutral by default — no rules, no blocking.
  yay invite "Bob" [--role signer|owner]  mint a 30-min link a teammate opens to request to join;
                             you approve on your phone (needs a running dashboard). No pubkey to copy.
                             authorize with a local owner key, or --phone to approve on an owner's phone
  yay revoke --name X [--pubkey <b64>]  revoke one key (or the whole identity) via an owner-signed event (--phone)
  yay reroot [--phone]        retire the current trust root and establish a new one (key lost/compromised)
  yay protect [--mode guarded|strict|--off]  FOUNDATION SEAL: owner-sign a baseline of the fixed core files
                             (Constitution, CI workflow, .gitignore, protocol) so any change is REVEALED at
                             verify. --add/--remove/--ignore <glob> tune it. Guarded warns; strict blocks.
  yay ask "<question>"       ask the configured AI about THIS repo + the manual (needs an LLM key in .env;
                             also available as the Ask tab in the dashboard). e.g. which cells need approval?
  yay grant [--for 2h] [--count 20]  Autopilot: owner-signed capability ENVELOPE → the AI approves in-scope
                             (delegated), non-sensitive Cells unattended (no phone) until it expires.
                             envelope: --cell IDs · --allow/--deny "glob" · --allow-tag/--deny-tag TAG · --max-risk low|medium|high
                             --child-grants [--max-depth N] (permit attenuating sub-grants) · --deps/--deploy (recorded)
                             SECURITY GUARD is ON by default — auth/payments/secrets/deploy/CI need a real signature;
                             lift with --no-guard. yay grant list · yay grant revoke [id] (stop it) · sensitive /
                             code-pinned / policy non-delegable ({ "delegable": false }) always need a real sign
  yay ratify [--sign]        list delegated Cells awaiting ratification; --sign signs them for real (human)
                             --reject --reason "<why>" [--category …] [--cell IDs] records a signed, append-only
                             REJECTION (kept as provenance; the code stays unsigned until fixed)
  yay sign [--cell IDs]       approve specs using THIS project's method (phone or local) — no flag needed
                             override with --phone / --local · SSL on by default (--no-https) · --cell to sign a subset
                             a Brief is required by default (Standard §5): --brief "<what you ordered>" supplies it,
                             --title "<headline>" gives it a scannable title (prompted at a terminal)
                             (editable on the phone) · you're prompted if omitted at a terminal · --no-brief skips a trivial re-sign
                             --name "<teammate>" (relay projects) routes the request to THEIR inbox and returns a request id
                             (fire-and-return); collect it later with --check <id> (or --check for all pending)
  yay inbox                   print YOUR on-duty relay link — open it on your phone to receive requests addressed to you
  yay requests [done <id>]    list plain requests queued from the dashboard's "Request a change" button (the AI
                             turns each into a Brief + Cells); "done <id>" or "clear" removes handled ones
  yay briefs [--by-tag] [--tag X]  the Brief ledger in the terminal — newest first; --by-tag groups by
                             tag (tag first, date second); --tag <name> filters to one tag
  yay tags [--set id|add|remove|rename|desc|sets]  the project's Brief-tag vocabulary — every Brief is tagged
                             from it. --set <id> (or --set custom for blank placeholders) · add/remove "Tag" ·
                             rename "A" "B" (blocked once a tag is used in a signed Brief) · desc "Tag" "…" · sets
  yay batch [<n>|off|on]      how the AI groups small changes into one Brief before signing (default barrier 5).
                             "yay batch 8" raises it; "off" = a Brief per change. Batches are per-concern (tag).
  yay verify [--strict] [-d]  the gate — paint every Cell; -d/--details prints each spec, code & checks
                             --problems shows only non-green Cells · --no-mutate skips prover mutation grading
  yay attest [list|verify]   mint a SIGNED verifier attestation over the current verdict (the verifier's own
                             key vouches for "Green" — the third crypto identity). Run at commit / after a green
                             verify. Refuses a blocked gate (--force records a failing one). Append-only, chained,
                             capability-versioned. "list" shows the ledger; "verify" re-checks every attestation
                             (--strict exits non-zero on any invalid) · "verify --registry" also cross-checks each
                             attestation's capability against yaylayer.com/verify (catches over-claim). Key stays
                             machine-side (gitignored); the public verifier of record is pinned in config. Anyone
                             can also verify an attestation in-browser at https://yaylayer.com/verify (no upload).
  yay capability [--json]    the verifier's DERIVED capability descriptor + fingerprint (provers, effect
                             nets, checks, policy kinds); flags DRIFT if detectors changed without a version bump
  yay reverify               re-run verification at the current verifier capability; if a capability bump,
                             a verdict change (e.g. Yellow→Green), or code drift is found, APPEND a new
                             attestation chained to the prior one (never rewrites old Green). Prints an upgrade report.
  yay witness [--strict]     integrity witness — cross-check the attestation chain, the spec archive, and
                             whether the latest attestation still covers the code (git/tree vs ledger vs archive)
  yay metrics                earned-autonomy metrics from the delegation + ratification + rejection history
                             (per-category rejection rates; suggests categories to stop delegating)
  yay archive [enable|…]     Durable mode: keep an encrypted, sha256-anchored copy of SIGNED source so it
                             survives git loss. enable/disable · (default) archive covered files · --forget
                             <hash> --reason (signed tombstone) · --restore <hash> · --verify · install (git
                             post-commit hook). Key is project-held ($YAY_ARCHIVE_KEY or a passphrase),
                             NEVER stored by YayLayer; a pre-archive secret scan refuses to seal secrets
  yay plan [--provider anthropic|openai|custom] [--model m] [--base-url url]
                             AI-synthesize a high-level System Plan → .yaylayer/plan.json
                             key from .env (ANTHROPIC_API_KEY / OPENAI_API_KEY); custom = any OpenAI-compatible
                             endpoint via --base-url (Ollama/LM Studio/vLLM/local — key optional)
  yay map [-o file.html]      write the HTML flowchart (default: yay-layer-map.html)
                             if plan generation is enabled it regenerates the System Plan; --no-plan skips it, --replan forces it
  yay dashboard [--port N]    live control panel: map + auto-refresh + Run-tests & Regenerate-plan buttons (leave running; --open, SSL on by default: --no-https)
  yay test [--test "cmd"]     run the project's own test suite (package.json "test" / config.test); non-zero exit on failure
  yay adversary [--cell IDs]  spec-only adversary: an LLM sees ONLY the specs and writes probes to break the code (needs an LLM key)
  yay gate [dir]              write the CI gate pipeline (+ --hook local pre-push) & print the
                             branch-protection steps for your host. --for github|azure|gitlab|bitbucket|gitea|gerrit
                             (default github) · flags: --scope <dir> --pkg <spec> --hook --force
  yay status                  one-line summary

  docs: standard/STANDARD.md · CONSTITUTION.md · README.md`;

async function main() {
  loadDotenv();
  const [, , cmd, ...rest] = process.argv;
  const { flags, positional } = args(rest);
  switch (cmd) {
    case 'init': return cmdInit(flags, positional);
    case 'keygen': return cmdKeygen(flags);
    case 'sign': return cmdSign(flags, positional);
    case 'inbox': return cmdInbox(flags);
    case 'requests': case 'request': return cmdRequests(flags, positional);
    case 'tags': case 'tag': return cmdTags(flags, positional);
    case 'briefs': return cmdBriefs(flags);
    case 'pair': return cmdPair(flags);
    case 'enroll': return cmdEnroll(flags);
    case 'invite': return cmdInvite(flags, positional);
    case 'revoke': return cmdRevoke(flags);
    case 'reroot': return cmdReroot(flags);
    case 'protect': return cmdProtect(flags, positional);
    case 'ask': return cmdAsk(flags, positional);
    case 'grant': case 'autopilot': return cmdGrant(flags, positional);
    case 'ratify': return cmdRatify(flags);
    case 'verify': case 'check': return cmdVerify(flags);
    case 'attest': case 'attestation': return cmdAttest(flags, positional);
    case 'reverify': return cmdReverify(flags);
    case 'capability': case 'caps': return cmdCapability(flags);
    case 'witness': return cmdWitness(flags);
    case 'metrics': return cmdMetrics(flags);
    case 'archive': return cmdArchive(flags, positional);
    case 'map': return cmdMap(flags);
    case 'dashboard': case 'serve': return cmdDashboard(flags);
    case 'test': case 'tests': return cmdTest(flags);
    case 'adversary': case 'adversarial': return cmdAdversary(flags);
    case 'plan': return cmdPlan(flags);
    case 'adopt': return cmdAdopt(flags, positional);
    case 'constitution': case 'rules': return cmdConstitution(flags, positional);
    case 'gate': case 'ci': return cmdGate(flags, positional);
    case 'id': case 'shard': return cmdId(flags);
    case 'merge': return cmdMerge(flags);
    case 'status': return cmdStatus(flags);
    case 'batch': return cmdBatch(flags, positional);
    case 'policy': return cmdPolicy(flags);
    case 'version': case '--version': case '-v': return console.log(require('../package.json').version);
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
