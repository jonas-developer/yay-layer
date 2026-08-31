'use strict';
// Scenario factory — the single, reusable way to stand up a realistic YayLayer project.
//
// Tests, the demo dashboard, and the confirmation report all need "a real project with a deliberate
// spread of Cell states, signers, grants, delegated/rejected Cells, a foundation seal, and (optionally)
// a Durable history." Before this, each of those hand-rolled the same boilerplate (mkdtemp + git init +
// env + a yay()/git() shell + a spec-block template). This is that boilerplate, once, as a small builder.
//
// It drives the REAL CLI — it never fakes state — so a scenario is byte-for-byte what a user would get.
// Every mutating method returns `this`, so steps chain; the read methods (paths/config/snapshots/key)
// hand back live handles for assertions.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const U = require('../../src/util');
const D = require('../../src/durable');

const YAY = path.join(__dirname, '..', '..', 'bin', 'yay.js');

// Render a spec block in the real marker grammar (∷YAY⟨…⟩ … ∷YAY-END⟨…⟩) followed by the unit body.
// Only the fields you supply are emitted, in the canonical order; `pure` defaults to yes.
function specBlock(id, spec, body) {
  const L = ['//∷YAY⟨' + id + '⟩'];
  if (spec.unit) L.push('// unit: ' + spec.unit);
  if (spec.intent) L.push('// intent: ' + spec.intent);
  if (spec.in) L.push('// in: ' + spec.in);
  if (spec.out) L.push('// out: ' + spec.out);
  if (spec.ensures) L.push('// ensures: ' + spec.ensures);
  if (spec.tag) L.push('// tag: ' + spec.tag);
  L.push('// pure: ' + (spec.pure === false ? 'no' : 'yes'));
  L.push('//∷YAY-END⟨' + id + '⟩');
  return L.join('\n') + '\n' + body + '\n';
}

class Scenario {
  // opts: { dir?, name?, passphrase?, archiveKey? }. With no dir a throwaway temp project is created
  // (removed by cleanup()); pass dir to build into a location you own.
  constructor(opts) {
    opts = opts || {};
    this.env = { ...process.env };
    this.passphrase = opts.passphrase || 'secret123';
    this.env.YAY_PASSPHRASE = this.passphrase;
    this.archiveKey = opts.archiveKey || null;
    if (this.archiveKey) this.env.YAY_ARCHIVE_KEY = this.archiveKey;
    if (opts.dir) { this.dir = opts.dir; this._work = null; }
    else {
      this._work = fs.mkdtempSync(path.join(os.tmpdir(), 'yay-scn-'));
      this.dir = path.join(this._work, opts.name || 'project');
    }
    fs.mkdirSync(this.dir, { recursive: true });
    this.files = {};      // file -> current rendered content (mirror)
    this.cells = {};      // id  -> { spec, file }
    this._order = {};     // file -> [cell ids, in insertion order]
  }

  // ── low-level shells ──────────────────────────────────────────────────────────────────────────
  yay(args) { return execFileSync('node', [YAY, ...args], { cwd: this.dir, env: this.env, stdio: 'pipe' }).toString(); }
  git(args) { return execFileSync('git', args, { cwd: this.dir, env: this.env, stdio: 'pipe' }).toString(); }

  // ── files & cells ─────────────────────────────────────────────────────────────────────────────
  gitInit(user) {
    user = user || {};
    this.git(['init', '-q']);
    this.git(['config', 'user.email', user.email || 't@example.com']);
    this.git(['config', 'user.name', user.name || 'T']);
    return this;
  }
  // Write a raw file (non-Cell content, or a hand-authored source file).
  write(file, content) {
    const full = path.join(this.dir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    this.files[file] = content;
    return this;
  }
  // Declare or replace a Cell. spec: { unit, intent, in, out, ensures, tag, pure, body, file }.
  // Cells sharing a file are concatenated in first-seen order; re-declaring an id (same or new body)
  // rewrites that block in place — this is how a scenario evolves a Cell across Durable states.
  cell(id, spec) {
    spec = spec || {};
    const file = spec.file || 'main.js';
    const body = spec.body || ('function ' + (spec.unit || 'fn') + '() { return null; }');
    this.cells[id] = { spec, file, block: specBlock(id, spec, body) };
    if (!this._order[file]) this._order[file] = [];
    if (this._order[file].indexOf(id) < 0) this._order[file].push(id);
    this._render(file);
    return this;
  }
  _render(file) {
    const content = this._order[file].map((id) => this.cells[id].block).join('');
    this.write(file, content);
    return this;
  }

  // ── lifecycle / CLI verbs ─────────────────────────────────────────────────────────────────────
  // opts: { durable, key='local', name='alex', adopt=false, plan=false, pair=false, tags='none' }
  init(opts) {
    opts = opts || {};
    const a = ['init', '--key', opts.key || 'local', '--name', opts.name || 'alex'];
    if (opts.key !== false) a.push('--passphrase', this.passphrase);
    if (opts.durable) a.push('--durable');
    if (opts.adopt === false || opts.adopt === undefined) a.push('--no-adopt');
    if (opts.plan === false || opts.plan === undefined) a.push('--no-plan');
    if (opts.pair === false || opts.pair === undefined) a.push('--no-pair');
    a.push('--tags', opts.tags || 'none');
    this.yay(a);
    return this;
  }
  // Sign one or more Cells. cells: id | [ids]. opts: { title|false, brief, tags, yes=true }.
  sign(cells, opts) {
    opts = opts || {};
    const ids = Array.isArray(cells) ? cells.join(',') : cells;
    const a = ['sign', '--cell', ids];
    if (opts.title === false || opts.title === undefined) a.push('--no-title');
    else a.push('--title', opts.title);
    a.push('--brief', opts.brief || 'Signed by the scenario factory.');
    if (opts.tags) a.push('--tags', opts.tags);
    if (opts.yes !== false) a.push('--yes');
    this.yay(a);
    return this;
  }
  keygen(name) { this.yay(['keygen', '--name', name]); return this; }
  // opts: { for='2h', count=5, allow='src/**', maxRisk='medium' }
  grant(opts) {
    opts = opts || {};
    this.yay(['grant', '--for', opts.for || '2h', '--count', String(opts.count || 5),
      '--allow', opts.allow || 'src/**', '--max-risk', opts.maxRisk || 'medium']);
    return this;
  }
  // Reject a delegated Cell. opts: { cell, reason, category }
  reject(opts) {
    opts = opts || {};
    const a = ['ratify', '--reject', '--cell', opts.cell, '--reason', opts.reason || 'Redo.'];
    if (opts.category) a.push('--category', opts.category);
    this.yay(a);
    return this;
  }
  attest(opts) { opts = opts || {}; this.yay(opts.force === false ? ['attest'] : ['attest', '--force']); return this; }
  protect(opts) { opts = opts || {}; this.yay(['protect', '--mode', opts.mode || 'guarded']); return this; }
  archive(opts) { opts = opts || {}; this.yay(opts.quiet === false ? ['archive'] : ['archive', '--quiet']); return this; }
  commit(msg) { this.git(['add', '-A']); this.git(['commit', '-q', '-m', msg || 'snapshot']); return this; }
  map(opts) { opts = opts || {}; const a = ['map']; if (opts.demo) a.push('--demo'); if (opts.out) a.push('-o', opts.out); this.yay(a); return this; }

  // ── read handles (for assertions / reports) ───────────────────────────────────────────────────
  paths() { return U.paths(this.dir); }
  config() { return U.readJSON(this.paths().config, {}); }
  snapshots() { return D.listSnapshots(this.paths()); }
  // Resolve the Durable archive key (needed to reconstruct snapshots in reverify).
  archiveKeyResolved() {
    if (!this.archiveKey) throw new Error('scenario has no archive key (pass { archiveKey } to build a Durable history)');
    const arc = D.loadArchive(this.paths());
    return D.resolveKey(this.archiveKey, arc.salt);
  }

  cleanup() { if (this._work) { try { fs.rmSync(this._work, { recursive: true, force: true }); } catch (_) {} } }
}

// Convenience: `scenario({...})` == `new Scenario({...})`.
function scenario(opts) { return new Scenario(opts); }

module.exports = { scenario, Scenario, specBlock };
