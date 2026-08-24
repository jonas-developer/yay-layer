'use strict';
// Self-contained smoke test — no disk state, no passphrase prompts.
// Exercises: crypto sign/verify roundtrip, manifest extraction on the example,
// and the color gate (C-040 → GREEN, C-041 → RED via purity violation).

const assert = require('assert');
const path = require('path');
const C = require('../src/crypto');
const { canonical } = require('../src/util');
const { buildManifest } = require('../src/manifest');
const { verifyManifest } = require('../src/verify');

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); console.log('  ✓ ' + msg); };

// 1) ed25519 + keystore roundtrip
const { pubB64, privDer } = C.generateKeypair();
const msg = canonical({ hello: 'world', n: 1 });
const sig = C.sign(msg, privDer);
ok(C.verify(msg, sig, pubB64), 'sign/verify roundtrip succeeds');
ok(!C.verify(msg + 'x', sig, pubB64), 'verify fails on tampered message');
const ks = C.encryptKeystore(privDer, 'pw-123456');
ok(Buffer.compare(C.decryptKeystore(ks, 'pw-123456'), privDer) === 0, 'keystore decrypts with right passphrase');
assert.throws(() => C.decryptKeystore(ks, 'wrong'), 'keystore rejects wrong passphrase');
ok(true, 'keystore rejects wrong passphrase');

// 2) manifest extraction on the example
const exDir = path.join(__dirname, '..', 'examples');
const manifest = buildManifest(exDir);
ok(manifest.cells['C-040'] && manifest.cells['C-041'], 'extracts C-040 and C-041 from examples');
ok(manifest.cells['C-040'].specHash && manifest.cells['C-040'].specHash.length === 64, 'computes a sha256 spec hash');

// 3) unsigned → UNSIGNED
let v = verifyManifest(manifest, { approvals: [] }, { signers: {} });
ok(v.results['C-040'].state === 'UNSIGNED', 'unsigned Cell is UNSIGNED');
ok(!v.passed, 'gate is blocked when Cells are unsigned');

// 4) sign both cells, then GREEN + RED
const approval = {
  id: 'A-0001', project: 'test', prev: 'genesis', nonce: 'n', at: 't', signer: 'tester',
  items: { 'C-040': manifest.cells['C-040'].specHash, 'C-041': manifest.cells['C-041'].specHash },
};
approval.signature = C.sign(canonical(approval), privDer);
const config = { signers: { tester: pubB64 } };
v = verifyManifest(manifest, { approvals: [approval] }, config);
ok(v.results['C-040'].state === 'GREEN', 'signed clean pure Cell → GREEN');
ok(v.results['C-041'].state === 'RED', 'signed impure-but-declared-pure Cell → RED (purity violation)');

// 5) a forged/altered approval must not verify
const forged = { ...approval, items: { ...approval.items }, signer: 'tester' };
forged.items['C-041'] = 'deadbeef'.repeat(8);
const { signature, ...rest } = forged;
ok(!C.verify(canonical(rest), approval.signature, pubB64), 'tampered approval fails signature check');

// 6) AST analyzer finds nested units, not just top-level functions
const { analyze } = require('../src/analyze');
const a = analyze('(function(){ function inner(){} const o = { m(){}, ar: () => 1 }; class K { go(){} } })();');
ok(a.ok, 'analyzer parses an IIFE/object/class snippet');
const names = a.units.map((u) => u.name);
ok(names.includes('inner'), 'analyzer finds a function nested in an IIFE');
ok(names.includes('m'), 'analyzer finds an object method');
ok(names.includes('ar'), 'analyzer finds an arrow-property');
ok(names.some((x) => x.endsWith('.go')), 'analyzer finds a class method');

// 7) TypeScript + JSX are parsed too (via @babel/parser)
const ts = analyze('export class Svc { getV(): number { return 1; } } function u(x: string): string { return x; }');
ok(ts.ok, 'analyzer parses TypeScript');
ok(ts.units.some((u) => u.name.endsWith('.getV')) && ts.units.some((u) => u.name === 'u'), 'TS: finds class method + function');
const jsx = analyze('export default function App(){ return <div className="x"/>; } const h = () => 1;');
ok(jsx.ok, 'analyzer parses JSX');
ok(jsx.units.some((u) => u.name === 'App') && jsx.units.some((u) => u.name === 'h'), 'JSX: finds component + arrow');

// 8) unit-level call graph: calls are attributed to the enclosing unit
const cg = analyze('function a(){ return b() + 1; } function b(){ return 2; } function lonely(){ return 0; }');
ok(cg.units.find((u) => u.name === 'a').callsOut.includes('b'), 'call graph: a() records calling b()');
ok(!cg.units.find((u) => u.name === 'b').callsOut.includes('b'), "call graph: b() doesn't record calling itself");

// 9) blast radius + bloat from the manifest influence pass
const { computeInfluence } = require('../src/manifest');
if (computeInfluence) {
  const cells = {
    'C-1': { unitName: 'a', module: 'm', group: 'Public API', callsOut: ['b'], contains: [] },
    'C-2': { unitName: 'b', module: 'm', group: 'Internal', callsOut: ['c'], contains: [] },
    'C-3': { unitName: 'c', module: 'm', group: 'Internal', callsOut: [], contains: [] },
    'C-4': { unitName: 'orphan', module: 'm', group: 'Internal', callsOut: [], contains: [] },
  };
  computeInfluence(cells);
  ok(cells['C-3'].blast === 2, 'blast: c is depended on transitively by a and b (blast=2)');
  ok(cells['C-3'].directCallers === 1, 'blast: c has 1 direct caller (b)');
  ok(cells['C-4'].bloat === true, 'bloat: orphan with no callers, not public → flagged');
  ok(cells['C-1'].bloat === false, 'bloat: public-API entry with no callers → not flagged');
}

// 10) constitution writer: creates harness files, is idempotent, preserves user text
const os = require('os');
const fs = require('fs');
const { writeConstitution, resolveKeys } = require('../src/constitution');
const tmp = fs.mkdtempSync(require('path').join(os.tmpdir(), 'yay-con-'));
let rep = writeConstitution(tmp, resolveKeys('claude,copilot'));
ok(rep.find((r) => r.key === 'claude').action === 'created', 'constitution: CLAUDE.md created');
const claudeMd = fs.readFileSync(require('path').join(tmp, 'CLAUDE.md'), 'utf8');
ok(/YayLayer Constitution/.test(claudeMd) && /YAYLAYER:BEGIN/.test(claudeMd), 'constitution: CLAUDE.md holds the Constitution + markers');
ok(fs.existsSync(require('path').join(tmp, '.github/copilot-instructions.md')), 'constitution: nested copilot path created');
rep = writeConstitution(tmp, resolveKeys('claude'));
ok(rep[0].action === 'unchanged', 'constitution: re-run is idempotent (unchanged)');
fs.writeFileSync(require('path').join(tmp, 'AGENTS.md'), '# My own notes\nkeep me\n');
writeConstitution(tmp, resolveKeys('agents'));
const agents = fs.readFileSync(require('path').join(tmp, 'AGENTS.md'), 'utf8');
ok(/keep me/.test(agents) && /YAYLAYER:BEGIN/.test(agents), 'constitution: appends to an existing file without destroying user text');
fs.rmSync(tmp, { recursive: true, force: true });

// 11) behavioural prover: satisfied ensures → pass, violated → fail, prose → skip
const { proveManifest } = require('../src/prove');
const P = require('path');
const ptmp = fs.mkdtempSync(P.join(os.tmpdir(), 'yay-prove-'));
fs.writeFileSync(P.join(ptmp, 'p.js'), 'function good(id){return `/pfps/${id}.png`;}\nfunction bad(id){return `/x/${id}.png`;}\n');
const mkcell = (id, unit, ens) => ({ id, file: 'p.js', unitName: unit, unitFound: true, contains: [], spec: { pure: 'yes', in: 'id:number', out: 'string', ensures: ens } });
const pm = proveManifest({ root: ptmp, cells: {
  'C-1': mkcell('C-1', 'good', 'out == `/pfps/${id}.png`'),
  'C-2': mkcell('C-2', 'bad', 'out == `/pfps/${id}.png`'),
  'C-3': mkcell('C-3', 'good', 'the url should be nice'),
} });
ok(pm['C-1'].status === 'pass', 'prover: satisfied ensures → pass');
ok(pm['C-2'].status === 'fail' && /bad\(/.test(pm['C-2'].counterexample), 'prover: violated ensures → fail with counterexample');
ok(pm['C-3'].status === 'skip', 'prover: prose ensures → skip (not machine-checkable, not a false pass)');
fs.rmSync(ptmp, { recursive: true, force: true });

// 12) mutation testing: a tight ensures kills mutants; a loose one lets them survive
const mtmp = fs.mkdtempSync(P.join(os.tmpdir(), 'yay-mut-'));
fs.writeFileSync(P.join(mtmp, 'm.js'), 'function url(id){ return `/pfps/${id}.png`; }\n');
const mkc = (unit, ens, body, start) => ({ id: unit, file: 'm.js', unitName: unit, unitFound: true, unitBody: body, unitBodyStart: start, contains: [], spec: { pure: 'yes', in: 'id:number', out: 'string', ensures: ens } });
const bodyLine = 'function url(id){ return `/pfps/${id}.png`; }';
const strong = proveManifest({ root: mtmp, cells: { url: mkc('url', 'out == `/pfps/${id}.png`', bodyLine, 0) } }, { mutate: true }).url;
ok(strong.status === 'pass' && strong.mutation && strong.mutation.total > 0, 'mutation: mutants were generated and run');
ok(strong.mutation.score >= 0.8, 'mutation: a tight ensures kills most mutants (high score)');
const weak = proveManifest({ root: mtmp, cells: { url: mkc('url', 'out.length > 0', bodyLine, 0) } }, { mutate: true }).url;
ok(weak.mutation.survived > 0 && weak.mutation.score < 0.5, 'mutation: a loose ensures (out.length>0) lets mutants survive (low score)');
fs.rmSync(mtmp, { recursive: true, force: true });

// 13) `yay gate` generators: workflow + hook content, idempotent write
const G = require('../src/gate');
ok(/yay verify --strict/.test(G.ciWorkflow()) && /gate:/.test(G.ciWorkflow()), 'gate: workflow runs `yay verify --strict` under a `gate` job');
ok(/--dir src/.test(G.ciWorkflow({ scope: 'src' })), 'gate: --scope adds --dir to the workflow');
ok(/npm install -g github:/.test(G.ciWorkflow({ pkg: 'github:jonas-developer/yay-layer' })), 'gate: --pkg sets the install source');
ok(/yay verify --strict/.test(G.prePushHook()) && /no-verify/.test(G.prePushHook()), 'gate: pre-push hook verifies and documents the bypass');
const gtmp = fs.mkdtempSync(P.join(os.tmpdir(), 'yay-gate-'));
const w1 = G.writeWorkflow(gtmp);
ok(w1.action === 'created' && fs.existsSync(P.join(gtmp, G.WORKFLOW_REL)), 'gate: writes the workflow file');
ok(G.writeWorkflow(gtmp).action === 'skipped', 'gate: re-run is idempotent (skips existing)');
ok(G.writeWorkflow(gtmp, { force: true }).action === 'overwritten', 'gate: --force overwrites');
fs.rmSync(gtmp, { recursive: true, force: true });

// 13) multi-key identity: one name may hold several keys; a seal by ANY of them verifies
const { pubKeysOf } = require('../src/util');
ok(pubKeysOf('x').length === 1 && pubKeysOf([{ pub: 'a' }, { pub: 'b' }]).length === 2 && pubKeysOf(['a', 'b']).length === 2, 'roster: pubKeysOf normalizes string / [str] / [{pub}]');
const decoy = C.generateKeypair();
// `approval` (from check 4) was signed by the tester key; enroll it as the SECOND key of the identity
const multiRoster = { signers: { tester: [{ pub: decoy.pubB64, kind: 'phone' }, { pub: pubB64, kind: 'local' }] } };
let mv = verifyManifest(manifest, { approvals: [approval] }, multiRoster, { mutate: false });
ok(mv.results['C-040'].state === 'GREEN', 'multi-key: a seal by the identity\'s second key still verifies GREEN');
const wrongOnly = { signers: { tester: [{ pub: decoy.pubB64, kind: 'phone' }] } };
mv = verifyManifest(manifest, { approvals: [approval] }, wrongOnly, { mutate: false });
ok(mv.results['C-040'].state === 'UNSIGNED', 'multi-key: if none of the enrolled keys match, it is UNSIGNED');

// 13b) signed roster governance — an owner-signed chain; unauthorized adds are rejected
const R = require('../src/roster');
const kO = C.generateKeypair(), kA = C.generateKeypair(), kE = C.generateKeypair();
function mkEvent(log, type, name, pub, role, signPriv) {
  const e = { id: R.nextEventId(log), type, name, pub, role, prev: log.events.length ? log.events[log.events.length - 1].id : 'genesis', nonce: 'n' + log.events.length, at: '2026-01-01T00:00:00.000Z' };
  e.signature = C.sign(R.eventBytes(e), signPriv);
  log.events.push(e); return e;
}
// happy path: genesis (self-signed owner) + owner-signed add-signer
const logA = { events: [] };
mkEvent(logA, 'genesis', 'L.J Bergman', kO.pubB64, 'owner', kO.privDer);
mkEvent(logA, 'add-signer', 'Alice', kA.pubB64, 'signer', kO.privDer);
let dA = R.deriveRoster(logA);
ok(dA.ok && dA.roster['L.J Bergman'][0] === kO.pubB64 && dA.roster['Alice'][0] === kA.pubB64, 'roster: genesis + owner-signed add-signer enroll both identities');
ok(dA.roles['L.J Bergman'] === 'owner' && dA.roles['Alice'] === 'signer', 'roster: roles assigned (owner / signer)');
// THE attack: a malignant key enrolls itself (self-signed, not by an owner)
const logB = { events: [] };
mkEvent(logB, 'genesis', 'L.J Bergman', kO.pubB64, 'owner', kO.privDer);
mkEvent(logB, 'add-signer', 'EvilAI', kE.pubB64, 'owner', kE.privDer); // signed by itself
const dB = R.deriveRoster(logB);
ok(!dB.roster['EvilAI'] && !dB.ok && /not signed by an owner/.test(dB.problems.join(' ')), 'roster: a self-signed (non-owner) enrollment is REJECTED — the AI cannot add itself');
// a non-owner signer cannot enroll others
const logC = { events: [] };
mkEvent(logC, 'genesis', 'L.J Bergman', kO.pubB64, 'owner', kO.privDer);
mkEvent(logC, 'add-signer', 'Alice', kA.pubB64, 'signer', kO.privDer);
mkEvent(logC, 'add-signer', 'Bob', kE.pubB64, 'signer', kA.privDer); // Alice is only a signer
ok(!R.deriveRoster(logC).roster['Bob'], 'roster: a non-owner signer cannot enroll others');
// tampered genesis → no trust root
ok(!R.deriveRoster({ events: [{ type: 'genesis', name: 'X', pub: kO.pubB64, prev: 'genesis', nonce: 'n', at: 't', signature: C.sign('wrong', kO.privDer) }] }).ok, 'roster: invalid genesis signature → no trust root established');
// root pinning
ok(R.deriveRoster(logA, { root: dA.rootFp }).ok, 'roster: matching root pin passes');
ok(!R.deriveRoster(logA, { root: 'DEAD-BEEF-DEAD-BEEF' }).ok && /MISMATCH/.test(R.deriveRoster(logA, { root: 'DEAD-BEEF-DEAD-BEEF' }).problems.join(' ')), 'roster: a wrong root pin is caught (swap detection)');

// 14) phone signing over LAN — simulate the phone with Node crypto (same wire
// formats: SPKI-DER pubkey, raw ed25519 sig over canonical(approval)).
(async function () {
  const { pairOverLan, signOverLan, confirmCode } = require('../src/phone');
  const kp = C.generateKeypair(); // { pubB64, privDer }
  const post = (base, body) => fetch(base + '/api/submit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const get = (base) => fetch(base + '/api/session').then((r) => r.json());

  // pairing
  const ps = await pairOverLan({ project: 'demo' });
  const pbase = 'http://127.0.0.1:' + ps.port;
  const psess = await get(pbase);
  ok(psess.mode === 'pair' && !!psess.challenge, 'phone: pair session serves a challenge');
  const pres = await post(pbase, { name: 'Jonas', pubB64: kp.pubB64, proof: C.sign(psess.challenge, kp.privDer) });
  ok(pres.ok && pres.code === confirmCode(kp.pubB64), 'phone: valid possession proof accepted, confirm code bound to key');
  const pdone = await ps.done; ps.close();
  ok(pdone.name === 'Jonas' && pdone.pubB64 === kp.pubB64, 'phone: pairing resolves with the device identity');

  const bs = await pairOverLan({ project: 'demo' });
  const bres = await post('http://127.0.0.1:' + bs.port, { name: 'X', pubB64: kp.pubB64, proof: C.sign('wrong', kp.privDer) });
  ok(!!bres.error, 'phone: pairing rejects a bad possession proof'); bs.close();

  // signing
  const approval = { id: 'A-0001', project: 'demo', prev: 'genesis', nonce: 'abc', at: '2026-01-01T00:00:00.000Z', signer: 'Jonas', items: { 'C-1': 'hash' } };
  const ss = await signOverLan({ project: 'demo', approval, summary: [{ id: 'C-1', unit: 'f', intent: 'x', state: 'GREEN', color: '#1f9d57' }], expectPubB64: kp.pubB64 });
  const sbase = 'http://127.0.0.1:' + ss.port;
  const ssess = await get(sbase);
  ok(ssess.mode === 'approve' && ssess.approval && ssess.approval.id === 'A-0001', 'phone: approve session serves the unsigned approval + summary');
  const sig = C.sign(canonical(ssess.approval), kp.privDer);
  const sres = await post(sbase, { signature: sig });
  ok(!!sres.ok, 'phone: signature over canonical(approval) is accepted');
  const sdone = await ss.done; ss.close();
  ok(sdone.signature === sig, 'phone: signing resolves with the signature');

  const ws = await signOverLan({ project: 'demo', approval, summary: [], expectPubB64: kp.pubB64 });
  const wres = await post('http://127.0.0.1:' + ws.port, { signature: C.sign('not the approval', kp.privDer) });
  ok(!!wres.error, 'phone: a signature over the wrong bytes is rejected'); ws.close();

  console.log(`\nAll ${n} checks passed.`);
})().catch((e) => { console.error('smoke failed:', e); process.exit(1); });
