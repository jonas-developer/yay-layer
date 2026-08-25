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
// method-aware: a phone-signed project tells the AI to approve with `yay sign --phone`
const tmpP = fs.mkdtempSync(require('path').join(require('os').tmpdir(), 'con-'));
writeConstitution(tmpP, resolveKeys('claude'), 'phone');
const conP = fs.readFileSync(require('path').join(tmpP, 'CLAUDE.md'), 'utf8');
ok(/`yay sign`/.test(conP) && !/--phone/.test(conP) && /phone/.test(conP) && /returns a completed signature/.test(conP), 'constitution: phone project → plain `yay sign` (auto-phone) + auto-proceed');
ok(/git commit/.test(conP) && /git push` unless/.test(conP), 'constitution: instructs commit-after-verify (durable seal + diff baseline), no auto-push');
writeConstitution(tmpP, resolveKeys('agents'), 'local');
const conL = fs.readFileSync(require('path').join(tmpP, 'AGENTS.md'), 'utf8');
ok(/`yay sign`/.test(conL) && /passphrase/.test(conL), 'constitution: local project → plain `yay sign` (local key)');
fs.rmSync(tmpP, { recursive: true, force: true });

// 10d) spec diff (what the phone shows before approving): LCS line diff + block extract
const SD = require('../src/specdiff');
const dOld = ['intent: add two numbers', 'pure: yes', 'ensures: out == a+b'];
const dNew = ['intent: add two integers', 'pure: yes', 'ensures: out === a+b', 'throws: never'];
const dd = SD.lineDiff(dOld, dNew);
ok(dd && dd.some((x) => x.t === '-') && dd.some((x) => x.t === '+') && dd.some((x) => x.t === ' '), 'specdiff: line diff marks removed / added / unchanged lines');
ok(SD.lineDiff(dOld, dOld) === null, 'specdiff: identical spec → null (nothing to show)');
ok(SD.lineDiff(null, dNew) === null, 'specdiff: no previous version → null (new spec, no diff)');
const dContent = '//∷YAY⟨C-1⟩\n//  intent: foo\n//  pure: yes\n//∷YAY-END⟨C-1⟩\nfunction f(){}';
ok(JSON.stringify(SD.specLinesFromContent(dContent, 'C-1')).includes('intent: foo'), 'specdiff: extracts a cell spec block from raw content');
ok(SD.specLinesFromContent(dContent, 'C-9') === null, 'specdiff: a missing cell id → null');
// end-to-end: specDiffForCell against a REAL git HEAD (guards the cell.specBlock wiring)
try {
  const cp = require('child_process');
  const gdir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'yay-gd-'));
  const gf = require('path').join(gdir, 'x.js');
  fs.writeFileSync(gf, '//∷YAY⟨C-9⟩\n//  unit: f\n//  intent: old intent\n//  pure: yes\n//∷YAY-END⟨C-9⟩\nfunction f(){ return 1; }\n');
  cp.execFileSync('git', ['-C', gdir, 'init', '-q']);
  cp.execFileSync('git', ['-C', gdir, 'add', '-A']);
  cp.execFileSync('git', ['-C', gdir, '-c', 'user.email=x@y.z', '-c', 'user.name=x', 'commit', '-qm', 'base']);
  fs.writeFileSync(gf, '//∷YAY⟨C-9⟩\n//  unit: f\n//  intent: NEW intent\n//  pure: yes\n//∷YAY-END⟨C-9⟩\nfunction f(){ return 1; }\n');
  const gm = buildManifest(gdir);
  const gd = SD.specDiffForCell(gdir, gm.cells['C-9']);
  ok(gd && gd.some((d) => d.t === '-' && /old intent/.test(d.text)) && gd.some((d) => d.t === '+' && /NEW intent/.test(d.text)),
    'specdiff(e2e): specDiffForCell diffs working spec vs committed HEAD (uses cell.specBlock)');
  fs.rmSync(gdir, { recursive: true, force: true });
} catch (e) { ok(false, 'specdiff(e2e): ' + e.message); }

// 10f) parseIn keeps object/array param types intact (bracket-aware split)
const PI = require('../src/prove').parseIn;
ok(JSON.stringify(PI({ in: 'paddle: {x,y,w,h}, step: number, w: number' }).map((p) => p.name)) === '["paddle","step","w"]', 'prove: parseIn keeps object params intact (no comma shredding)');
const EH = require('../src/prove').ensuresHint;
ok(/every/.test(EH('every b.alive == true')) && /implication/.test(EH('a => b')) && /prose/.test(EH('just words here')), 'prove: ensuresHint gives actionable guidance to strengthen prose ensures');
ok(require('../src/prove').normalizeEnsures('|dx| < 3; a >= 0') === 'Math.abs(dx) < 3 &&  a >= 0', 'prove: normalizeEnsures makes |x| and ; evaluable (safe transforms only)');

// 10g) scanner ignores the generated map + honours .yaylayerignore
const igDir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'yay-ig-'));
fs.writeFileSync(require('path').join(igDir, 'yay-layer-map.html'), '<div>//∷YAY⟨C-900⟩ no end marker here</div>');
fs.writeFileSync(require('path').join(igDir, 'a.js'), '//∷YAY⟨C-1⟩\n//  intent: x\n//∷YAY-END⟨C-1⟩\nfunction a(){}\n');
const igMan = buildManifest(igDir);
ok(!igMan.cells['C-900'] && !igMan.problems.some((p) => /map\.html/.test(p.file || '')), 'manifest: generated yay-layer-map.html is not scanned as source');
fs.writeFileSync(require('path').join(igDir, '.yaylayerignore'), 'a.js\n');
ok(!buildManifest(igDir).cells['C-1'], 'manifest: .yaylayerignore excludes listed files');
fs.rmSync(igDir, { recursive: true, force: true });

// 10h) legibility: a signed + machine-checkable ensures counts as PROVEN, prose as unproven
const lgDir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'yay-lg-'));
fs.writeFileSync(require('path').join(lgDir, 'm.js'),
  '//∷YAY⟨C-P⟩\n//  unit: inc\n//  intent: add one\n//  in: a:number\n//  out: number\n//  pure: yes\n//  ensures: out === a + 1\n//∷YAY-END⟨C-P⟩\nfunction inc(a){return a+1;}\n\n' +
  '//∷YAY⟨C-Q⟩\n//  unit: greet\n//  intent: greet by name\n//  in: name:string\n//  out: string\n//  pure: yes\n//  ensures: the greeting is friendly\n//∷YAY-END⟨C-Q⟩\nfunction greet(name){return "hi "+name;}\n');
const lgm = buildManifest(lgDir);
const kpl = C.generateKeypair();
const apl = { id: 'A-1', project: 'x', prev: 'genesis', nonce: 'n', at: '2026-01-01T00:00:00.000Z', signer: 'me', items: { 'C-P': lgm.cells['C-P'].specHash, 'C-Q': lgm.cells['C-Q'].specHash } };
apl.signature = C.sign(canonical(apl), kpl.privDer);
const lgv = verifyManifest(lgm, { approvals: [apl] }, { signers: { me: [{ pub: kpl.pubB64 }] }, owners: ['me'] }, { mutate: false });
ok(lgv.results['C-P'].state === 'GREEN' && lgv.results['C-P'].proven === true, 'verify: a signed + machine-checkable ensures is PROVEN');
ok(lgv.results['C-Q'].state === 'GREEN' && lgv.results['C-Q'].proven === false && lgv.results['C-Q'].hasEnsures, 'verify: a signed prose ensures is GREEN but NOT proven (signed-only)');
ok(lgv.counts.proven >= 1 && lgv.counts.unproven >= 1, 'verify: counts split green into machine-proven vs signed-only');
fs.rmSync(lgDir, { recursive: true, force: true });

// 10e) unit-name mismatch (A) + dangling-reference (B) checks
const abDir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'yay-ab-'));
fs.writeFileSync(require('path').join(abDir, 'a.js'),
  '//∷YAY⟨C-A⟩\n//  unit: doThing\n//  intent: does a thing\n//  pure: yes\n//∷YAY-END⟨C-A⟩\nfunction doThingRenamed(){ return 1; }\n\n' +
  '//∷YAY⟨C-B⟩\n//  unit: caller\n//  intent: calls a helper\n//∷YAY-END⟨C-B⟩\nfunction caller(){ return missingHelper(2) + doThingRenamed(); }\n');
const abMan = buildManifest(abDir);
const abVer = verifyManifest(abMan, { approvals: [] }, {}, { mutate: false });
const noteA = (abVer.results['C-A'].notes || []).map((n) => n.text).join(' | ');
const noteB = (abVer.results['C-B'].notes || []).map((n) => n.text).join(' | ');
ok(/unit name mismatch/.test(noteA) && /doThingRenamed/.test(noteA), 'verify(A): flags unit-name mismatch (spec `unit:` vs the real function)');
ok(/undefined name/.test(noteB) && /missingHelper/.test(noteB) && !/doThingRenamed/.test(noteB), 'verify(B): flags a dangling call (missingHelper) but not a defined one (doThingRenamed)');
fs.rmSync(abDir, { recursive: true, force: true });

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

// 12b) plan digest — compact, structured input for the LLM synthesis
const { buildDigest } = require('../src/plan');
const dig = buildDigest(manifest, 'CoinWatch');
ok(dig.project === 'CoinWatch' && Array.isArray(dig.modules) && Array.isArray(dig.moduleFlows), 'plan: buildDigest returns modules + moduleFlows');
ok(dig.modules.every((m) => typeof m.name === 'string' && Array.isArray(m.units) && m.units.length <= 40), 'plan: digest modules carry a capped, structured unit list');

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
// add-key: an owner adds a SECOND key to their own identity (the "go mobile" path)
const logK = { events: [] };
mkEvent(logK, 'genesis', 'L.J Bergman', kO.pubB64, 'owner', kO.privDer);
mkEvent(logK, 'add-key', 'L.J Bergman', kA.pubB64, 'owner', kO.privDer); // owner adds a phone key to self
const dK = R.deriveRoster(logK);
ok(dK.ok && dK.roster['L.J Bergman'].length === 2, 'roster: an owner can add a second key to their own identity (local → mobile)');
// tampered genesis → no trust root
ok(!R.deriveRoster({ events: [{ type: 'genesis', name: 'X', pub: kO.pubB64, prev: 'genesis', nonce: 'n', at: 't', signature: C.sign('wrong', kO.privDer) }] }).ok, 'roster: invalid genesis signature → no trust root established');

// revocation: an owner-signed revoke-key removes a compromised key going forward
const kX = C.generateKeypair();
const logR = { events: [] };
mkEvent(logR, 'genesis', 'Owner', kO.pubB64, 'owner', kO.privDer);
mkEvent(logR, 'add-signer', 'Alice', kA.pubB64, 'signer', kO.privDer);
mkEvent(logR, 'add-key', 'Alice', kX.pubB64, 'signer', kO.privDer);
mkEvent(logR, 'revoke-key', 'Alice', kA.pubB64, 'signer', kO.privDer);
const dR = R.deriveRoster(logR);
ok(dR.ok && dR.roster['Alice'] && dR.roster['Alice'].length === 1 && dR.roster['Alice'][0] === kX.pubB64, 'roster: revoke-key removes just the named key, identity keeps its other key');
// remove-signer drops the whole identity; past attribution is unaffected (history stays in the log)
const logRS = { events: [] };
mkEvent(logRS, 'genesis', 'Owner', kO.pubB64, 'owner', kO.privDer);
mkEvent(logRS, 'add-signer', 'Bob', kA.pubB64, 'signer', kO.privDer);
mkEvent(logRS, 'remove-signer', 'Bob', undefined, undefined, kO.privDer);
const dRS = R.deriveRoster(logRS);
ok(dRS.ok && !dRS.roster['Bob'], 'roster: remove-signer drops the identity entirely');
// a non-owner cannot revoke
const logRB = { events: [] };
mkEvent(logRB, 'genesis', 'Owner', kO.pubB64, 'owner', kO.privDer);
mkEvent(logRB, 'add-signer', 'Alice', kA.pubB64, 'signer', kO.privDer);
mkEvent(logRB, 'revoke-key', 'Owner', kO.pubB64, 'owner', kA.privDer); // signed by the non-owner Alice
ok(!R.deriveRoster(logRB).ok && /not signed by an owner/.test(R.deriveRoster(logRB).problems.join(' ')), 'roster: a non-owner cannot revoke');
// lockout guard: revoking the sole owner key leaves no owner → rejected
const logLock = { events: [] };
mkEvent(logLock, 'genesis', 'Owner', kO.pubB64, 'owner', kO.privDer);
mkEvent(logLock, 'revoke-key', 'Owner', kO.pubB64, 'owner', kO.privDer);
ok(!R.deriveRoster(logLock).ok && /no owner/i.test(R.deriveRoster(logLock).problems.join(' ')), 'roster: revoking the last owner key is refused (no governance lockout)');
// root pinning
ok(R.deriveRoster(logA, { root: dA.rootFp }).ok, 'roster: matching root pin passes');
ok(!R.deriveRoster(logA, { root: 'DEAD-BEEF-DEAD-BEEF' }).ok && /MISMATCH/.test(R.deriveRoster(logA, { root: 'DEAD-BEEF-DEAD-BEEF' }).problems.join(' ')), 'roster: a wrong root pin is caught (swap detection)');

// 13c) verify uses the signed roster authoritatively and blocks on tampering
const vlog = { events: [] };
mkEvent(vlog, 'genesis', 'tester', pubB64, 'owner', privDer); // `approval` (check 4) was signed by this key
let rvA = verifyManifest(manifest, { approvals: [approval] }, {}, { mutate: false, roster: vlog });
ok(rvA.signedRoster && rvA.results['C-040'].state === 'GREEN', 'verify: signed roster is authoritative — an enrolled owner\'s seal is GREEN');
const vlogTampered = { events: vlog.events.concat() };
mkEvent(vlogTampered, 'add-signer', 'EvilAI', kE.pubB64, 'owner', kE.privDer); // self-signed, not by an owner
const rvB = verifyManifest(manifest, { approvals: [approval] }, {}, { mutate: false, roster: vlogTampered });
ok(rvB.rosterOk === false && rvB.passed === false, 'verify: a tampered roster (unauthorized add) blocks the gate');
const rvC = verifyManifest(manifest, { approvals: [approval] }, {}, { mutate: false, roster: vlog, root: 'DEAD-BEEF-DEAD-BEEF' });
ok(rvC.passed === false && /MISMATCH/.test((rvC.rosterProblems || []).join(' ')), 'verify: a wrong trust-root pin blocks the gate');
// an AI-injected key that isn't in the signed roster simply doesn't count
const injected = { signers: { EvilAI: kE.pubB64 } }; // config edit only, no signed event
const evilApproval = { ...approval, signer: 'EvilAI' };
evilApproval.signature = C.sign(canonical({ id: approval.id, project: approval.project, prev: approval.prev, nonce: approval.nonce, at: approval.at, signer: 'EvilAI', items: approval.items }), kE.privDer);
const rvD = verifyManifest(manifest, { approvals: [evilApproval] }, injected, { mutate: false, roster: vlog });
ok(rvD.results['C-040'].state === 'UNSIGNED', 'verify: with a signed roster, a config-only injected signer is ignored');

// 13d) pure-JS signer interop: TweetNaCl sig with an SPKI-wrapped key verifies at the gate
const nacl = require('../src/vendor/tweetnacl.min.js');
const nkp = nacl.sign.keyPair();
const npub = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(nkp.publicKey)]).toString('base64');
const nsig = Buffer.from(nacl.sign.detached(new TextEncoder().encode('canonical-bytes'), nkp.secretKey)).toString('base64');
ok(C.verify('canonical-bytes', nsig, npub), 'pure-JS signer: TweetNaCl signature (SPKI-wrapped key) verifies with the gate');

// 14) phone signing over LAN — simulate the phone with Node crypto (same wire
// formats: SPKI-DER pubkey, raw ed25519 sig over canonical(approval)).
(async function () {
  process.env.YAY_PHONE_PORT = '0'; // tests open many servers at once → random ports (prod uses the stable 8787)
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

  // completion ping: after the phone submits, it polls /api/status and the laptop
  // publishes the outcome so the phone screen flips to ✓ instead of hanging.
  const cs = await pairOverLan({ project: 'demo' });
  const cbase = 'http://127.0.0.1:' + cs.port;
  const csess = await get(cbase);
  await post(cbase, { name: 'Dev', pubB64: kp.pubB64, proof: C.sign(csess.challenge, kp.privDer) });
  await cs.done;
  ok((await fetch(cbase + '/api/status').then((r) => r.json())).final === null, 'phone-status: no final outcome until the laptop confirms');
  cs.setFinal({ ok: true, message: 'Paired' });
  const st = await fetch(cbase + '/api/status').then((r) => r.json());
  ok(st.final && st.final.ok, 'phone-status: after the laptop confirms, the phone polls a ✓ outcome');
  await cs.settled;
  ok(true, 'phone-status: settled resolves once the phone has read the final status');
  cs.close();

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

  // phone-as-genesis: the phone self-signs the genesis event → becomes the trust root, no local key.
  const roster = require('../src/roster');
  const gk = C.generateKeypair();
  const gpart = { id: 'R-0001', type: 'genesis', role: 'owner', prev: 'genesis', nonce: 'n0', at: '2026-01-01T00:00:00.000Z' };
  const gs = await pairOverLan({ project: 'demo', genesis: gpart });
  const gbase = 'http://127.0.0.1:' + gs.port;
  const gsess = await get(gbase);
  ok(gsess.genesis && gsess.genesis.id === 'R-0001', 'phone-genesis: session advertises the genesis event to self-sign');
  const gev = { ...gpart, name: 'Ada', pub: gk.pubB64, by: 'Ada' };
  const gproof = C.sign(canonical(gev), gk.privDer);
  const gres = await post(gbase, { name: 'Ada', pubB64: gk.pubB64, proof: gproof });
  ok(gres.ok && gres.code === confirmCode(gk.pubB64), 'phone-genesis: self-signed genesis accepted, confirm code bound to key');
  const gdone = await gs.done; gs.close();
  const drvG = roster.deriveRoster({ project: 'demo', events: [gdone.genesisEvent] });
  ok(drvG.ok && drvG.roles['Ada'] === 'owner' && drvG.rootFp === roster.fingerprint(gk.pubB64),
    'phone-genesis: resulting roster is a valid, owner-rooted trust root');

  // a phone that signs a TAMPERED genesis (self-promoting nonce) can't get past the laptop's authoritative rebuild
  const ts = await pairOverLan({ project: 'demo', genesis: gpart });
  const tampered = { ...gpart, nonce: 'ATTACKER', name: 'Mallory', pub: gk.pubB64, by: 'Mallory' };
  const tres = await post('http://127.0.0.1:' + ts.port, { name: 'Mallory', pubB64: gk.pubB64, proof: C.sign(canonical(tampered), gk.privDer) });
  ok(!!tres.error, 'phone-genesis: a genesis signed over tampered fields is rejected'); ts.close();

  // phone-authorized governance: an OWNER's phone signs a roster event (enroll/revoke)
  // so a phone-only owner can manage the roster with no key on the laptop.
  const { authorizeOverLan } = require('../src/phone');
  const ownerKp = C.generateKeypair();      // the owner (their key is enrolled)
  const strangerKp = C.generateKeypair();   // not an owner
  const rev = { id: 'R-0002', type: 'add-signer', name: 'Carol', pub: kp.pubB64, role: 'signer', by: 'Owner', prev: 'R-0001', nonce: 'z1', at: '2026-01-01T00:00:00.000Z' };
  const as = await authorizeOverLan({ project: 'demo', event: rev, summary: { title: 'Add Carol?' }, ownerPubs: [ownerKp.pubB64] });
  const abase = 'http://127.0.0.1:' + as.port;
  const asess = await get(abase);
  ok(asess.mode === 'authorize' && asess.event && asess.event.name === 'Carol', 'phone-authorize: session serves the governance event to sign');
  const bad = await post(abase, { signature: C.sign(canonical(rev), strangerKp.privDer) });
  ok(!!bad.error, 'phone-authorize: a non-owner signature is rejected');
  const good = await post(abase, { signature: C.sign(canonical(rev), ownerKp.privDer) });
  ok(!!good.ok, 'phone-authorize: a current owner signature is accepted');
  const adone = await as.done; as.close();
  ok(C.verify(canonical(rev), adone.signature, ownerKp.pubB64), 'phone-authorize: the returned signature is a valid roster event signature');

  // dashboard: the live control-panel server (map + auto-refresh + action buttons).
  const { startDashboard } = require('../src/dashboard');
  let dv = 'A';
  const ds = await startDashboard({
    buildMapHTML: () => ({ html: '<html><body>MAPBODY</body></html>', count: 1 }),
    version: () => dv,
    testInfo: () => ({ configured: true, cmd: 'echo hi' }),
    runTests: () => Promise.resolve({ configured: true, ok: true, code: 0, output: 'ran', cmd: 'echo hi' }),
    regenPlan: () => Promise.resolve({ ok: true, provider: 'openai', model: 'gpt-4o', subsystems: 2 }),
    diffs: () => [{ id: 'C-1', unit: 'add', file: 'a.js', diff: [{ t: ' ', text: 'intent: x' }, { t: '-', text: 'ensures: a' }, { t: '+', text: 'ensures: b' }] }],
    adversary: () => Promise.resolve({ results: [{ id: 'C-1', unit: 'add', status: 'broke', counterexample: 'add(1,1) wrong' }] }),
  }, { port: 0 });
  const dbase = 'http://127.0.0.1:' + ds.port;
  ok((await fetch(dbase + '/api/ping').then((r) => r.json())).yay === 'dashboard', 'dashboard: /api/ping identifies a running dashboard');
  const dpage = await fetch(dbase + '/').then((r) => r.text());
  ok(dpage.includes('MAPBODY') && dpage.includes('yd-refresh') && dpage.includes('yd-tests') && dpage.includes('yd-plan'), 'dashboard: serves the live map with Refresh + Run-tests + System-Plan buttons');
  const dver1 = (await fetch(dbase + '/api/version').then((r) => r.json())).v; dv = 'B';
  const dver2 = (await fetch(dbase + '/api/version').then((r) => r.json())).v;
  ok(dver1 === 'A' && dver2 === 'B', 'dashboard: /api/version reflects state so the page auto-refreshes on change');
  const dtres = await fetch(dbase + '/api/tests/run', { method: 'POST' }).then((r) => r.json());
  ok(dtres.ok === true && dtres.output === 'ran', 'dashboard: /api/tests/run runs the suite and returns the result');
  const pres2 = await fetch(dbase + '/api/plan/regen', { method: 'POST' }).then((r) => r.json());
  ok(pres2.ok === true && pres2.subsystems === 2, 'dashboard: /api/plan/regen regenerates the System Plan on demand');
  const dfs = await fetch(dbase + '/api/diffs').then((r) => r.json());
  ok(dfs.diffs && dfs.diffs[0].id === 'C-1' && dfs.diffs[0].diff.some((d) => d.t === '+'), 'dashboard: /api/diffs returns per-Cell spec changes vs last commit');
  ok(dpage.includes('yd-diffs') && dpage.includes('yd-adv'), 'dashboard: has Changes + Adversary buttons');
  const advr = await fetch(dbase + '/api/adversary/run', { method: 'POST' }).then((r) => r.json());
  ok(advr.results && advr.results[0].status === 'broke', 'dashboard: /api/adversary/run returns per-Cell adversary results');
  ds.close();

  // spec-only adversary: an LLM sees ONLY the spec (never the code) and tries to break it.
  const A = require('../src/adversary');
  const advDir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'yay-adv-'));
  const specBlock = '//∷YAY⟨C-1⟩\n//  unit: add\n//  in: (a:number,b:number)\n//  out: number\n//  pure: yes\n//  ensures: out === a + b\n//∷YAY-END⟨C-1⟩\n';
  // the LLM proposes INPUTS only (spec-only); our deterministic checker judges them.
  const fakeChat = async () => '[[1,1],[2,3],[-2,-2],[10,-4]]';
  fs.writeFileSync(require('path').join(advDir, 'm.js'), specBlock + 'function add(a,b){return a-b;}\n'); // BUG
  let am = await A.adversaryManifest(buildManifest(advDir), { provider: 'x' }, { chat: fakeChat });
  ok(am['C-1'].status === 'broke' && /ensures failed/.test(am['C-1'].counterexample), 'adversary: proposed inputs + deterministic judge BREAK buggy code (machine-confirmed counterexample)');
  fs.writeFileSync(require('path').join(advDir, 'm.js'), specBlock + 'function add(a,b){return a+b;}\n'); // fixed
  am = await A.adversaryManifest(buildManifest(advDir), { provider: 'x' }, { chat: fakeChat });
  ok(am['C-1'].status === 'survived', 'adversary: the same inputs SURVIVE once the code matches the spec (no false positive)');
  // false-positive guard: a bad expectation can no longer break it — the machine judges, not the LLM.
  fs.writeFileSync(require('path').join(advDir, 'e.js'), '//∷YAY⟨C-2⟩\n//  unit: idnum\n//  in: (a:number)\n//  out: number\n//  pure: yes\n//  ensures: out === a\n//∷YAY-END⟨C-2⟩\nfunction idnum(a){return a;}\n');
  const am2 = await A.adversaryManifest(buildManifest(advDir), { provider: 'x' }, { chat: async () => '[[0],[-5],[999]]' });
  ok(am2['C-2'].status === 'survived', 'adversary: correct code survives even hostile inputs (no LLM-judgment false positives)');
  fs.rmSync(advDir, { recursive: true, force: true });

  // recovery: BIP39 mnemonic → ed25519 key (the phone's key-backup layer), roster-compatible.
  const R = require('../src/vendor/recovery');
  const hx = (b) => Buffer.from(b).toString('hex');
  const z16 = new Uint8Array(16);
  ok(R.entropyToMnemonic(z16) === 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about', 'recovery: entropyToMnemonic matches the official BIP39 vector');
  ok(hx(R.mnemonicToSeed(R.entropyToMnemonic(z16), 'TREZOR')) === 'c55257c360c07c72029aebc1b53c05ed0362ada38ead3e3e9efa3708e53495531f09a6987599d18264c1e1c92f2cf141630c7a3c4ab7c81b2f001698e7463b04', 'recovery: PBKDF2-HMAC-SHA512 seed matches the official vector');
  const ent = new Uint8Array(32); for (let i = 0; i < 32; i++) ent[i] = (i * 37 + 11) & 0xff;
  const phrase = R.entropyToMnemonic(ent);
  ok(hx(R.mnemonicToEntropy(phrase)) === hx(ent), 'recovery: a 24-word phrase round-trips its entropy (checksum ok)');
  let mtamper = false; try { const w = phrase.split(' '); w[3] = 'zoo'; R.mnemonicToEntropy(w.join(' ')); } catch (_) { mtamper = true; }
  ok(mtamper, 'recovery: a wrong word fails the checksum');
  const rk1 = R.mnemonicToKeypair(phrase), rk2 = R.mnemonicToKeypair(phrase);
  ok(rk1.pub === rk2.pub && rk1.sec === rk2.sec, 'recovery: same phrase restores the identical keypair (device loss → same identity)');
  const rsig = require('../src/vendor/tweetnacl.min.js').sign.detached(new TextEncoder().encode('m'), Buffer.from(rk1.sec, 'base64'));
  ok(C.verify('m', Buffer.from(rsig).toString('base64'), rk1.pub), 'recovery: a mnemonic-derived signature verifies via crypto.js (enrollable in the roster)');

  // PIN-encrypted keystore: only ciphertext is stored; right PIN restores, wrong PIN fails.
  const blob = R.sealSecret(rk1.sec, 'correct horse battery', 2000);
  ok(!JSON.stringify(blob).includes(rk1.sec) && blob.ct && blob.nonce && blob.salt, 'keystore: sealed blob holds ciphertext, not the plaintext key');
  ok(R.openSecret(blob, 'correct horse battery') === rk1.sec, 'keystore: the right PIN unlocks the exact secret');
  ok(R.openSecret(blob, 'wrong pin here') === null, 'keystore: a wrong PIN returns null (no key leaked)');

  console.log(`\nAll ${n} checks passed.`);
})().catch((e) => { console.error('smoke failed:', e); process.exit(1); });
