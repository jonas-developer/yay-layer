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

console.log(`\nAll ${n} checks passed.`);
