import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(HERE, 'cache.mjs');
const MAP = path.join(HERE, 'map-changes.mjs');
const NL = '\\n';

function makeTemp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omm-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

function writeTree(base, tree) {
  for (const [relative, content] of Object.entries(tree)) {
    const absolute = path.join(base, ...relative.split('/'));
    if (content === null) {
      fs.rmSync(absolute, { recursive: true, force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
}

function git(repo, ...args) {
  const done = spawnSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
    { cwd: repo, encoding: 'utf8' },
  );
  assert.equal(done.status, 0, done.stderr);
  return done.stdout.trim();
}

// A repository in <temp>/repo, with the cache root in <temp>/cache.
function makeRepo(t, files) {
  const base = makeTemp(t);
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  return { base, repo, cacheDir: path.join(base, 'cache'), commit: commitTree(repo, files, 'first') };
}

function commitTree(repo, files, message) {
  writeTree(repo, files);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function run(script, args, cwd) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

function cache(ctx, ...args) {
  const done = run(CACHE, [...args, '--cache-dir', ctx.cacheDir, '--omm-version', 'omm 0.2.0'], ctx.repo);
  return { ...done, line: done.stdout.trim() };
}

function cacheOk(ctx, ...args) {
  const done = cache(ctx, ...args);
  assert.equal(done.status, 0, done.stderr);
  return done.line;
}

function diagram(...lines) {
  return `graph LR\n${lines.map((line) => `    ${line}`).join('\n')}\n`;
}

function node(id, title, paths) {
  return `${id}["${title}${NL}${paths}"]`;
}

const OMM = {
  'overall-architecture/diagram.mmd': diagram(node('ui', 'UI', 'src/ui/'), node('core', 'Core', 'src/core/')),
  'overall-architecture/description.md': 'top\n',
  'overall-architecture/ui/description.md': 'ui\n',
  'overall-architecture/core/description.md': 'core\n',
};

function treeOf(repo, commit) {
  return git(repo, 'rev-parse', `${commit}:src`);
}

// Store a scan for `commit` directly, as an earlier full scan would have.
function seed(ctx, commit, { omm = OMM, record = {} } = {}) {
  const tree = treeOf(ctx.repo, commit);
  const folder = path.join(ctx.cacheDir, 'repo', tree.slice(0, 12));
  writeTree(path.join(folder, '.omm'), omm);
  fs.writeFileSync(
    path.join(folder, 'fingerprint.json'),
    JSON.stringify({ commit, scan_dirs: ['src'], trees: { src: tree }, omm_version: 'omm 0.2.0', ...record }),
  );
  return folder;
}

const SRC = { 'src/ui/a.ts': 'a\n', 'src/ui/b.ts': 'b\n', 'src/core/c.ts': 'c\n', 'src/core/d.ts': 'd\n' };

test('lookup is a hit when a stored scan has the same tree', (t) => {
  const ctx = makeRepo(t, SRC);
  const folder = seed(ctx, ctx.commit);
  assert.equal(cacheOk(ctx, 'lookup'), `hit ${folder}`);
});

test('a change outside the scan dirs keeps the hit', (t) => {
  const ctx = makeRepo(t, SRC);
  const folder = seed(ctx, ctx.commit);
  commitTree(ctx.repo, { 'README.md': 'x\n' }, 'docs');
  assert.equal(cacheOk(ctx, 'lookup'), `hit ${folder}`);
});

test('lookup picks the stored scan with the fewest changed files, ancestor or not', (t) => {
  const ctx = makeRepo(t, SRC);
  const far = seed(ctx, ctx.commit);
  git(ctx.repo, 'switch', '-q', '-c', 'side');
  const side = commitTree(ctx.repo, { 'src/ui/a.ts': 'a2\n', 'src/ui/b.ts': 'b2\n', 'src/core/c.ts': 'c2\n' }, 'side');
  const near = seed(ctx, side);
  git(ctx.repo, 'switch', '-q', 'main');
  commitTree(ctx.repo, { 'src/ui/a.ts': 'a2\n', 'src/ui/b.ts': 'b2\n', 'src/core/c.ts': 'c2\n', 'src/core/d.ts': 'd2\n' }, 'main');
  assert.notEqual(far, near);
  assert.equal(cacheOk(ctx, 'lookup', '--max-ratio', '1'), `near ${near} ${side} 1`);
});

test('excluded files do not count toward the distance', (t) => {
  const ctx = makeRepo(t, SRC);
  const folder = seed(ctx, ctx.commit);
  commitTree(ctx.repo, { 'src/ui/a.test.ts': 't\n', 'src/ui/logo.PNG': 'p\n', 'src/ui/a.ts': 'a2\n' }, 'one');
  assert.equal(cacheOk(ctx, 'lookup'), `near ${folder} ${ctx.commit} 1`);
});

test('lookup misses when the nearest scan is too far', (t) => {
  const ctx = makeRepo(t, SRC);
  const folder = seed(ctx, ctx.commit);
  commitTree(ctx.repo, { 'src/ui/a.ts': 'a2\n', 'src/ui/b.ts': 'b2\n' }, 'half');
  const line = cacheOk(ctx, 'lookup', '--max-ratio', '0.4');
  assert.match(line, new RegExp(`^miss .* too-far ${path.basename(folder)} 2/4$`));
  assert.match(cacheOk(ctx, 'lookup', '--max-ratio', '0.5'), /^near /);
});

test('scans without the wanted perspectives, too long a chain, another omm or a missing commit are skipped', (t) => {
  const ctx = makeRepo(t, SRC);
  seed(ctx, ctx.commit, { record: { chain_depth: 5 } });
  const second = commitTree(ctx.repo, { 'src/ui/a.ts': 'a2\n' }, 'two');
  seed(ctx, second, { record: { omm_version: 'omm 0.3.1' } });
  const third = commitTree(ctx.repo, { 'src/ui/b.ts': 'b2\n' }, 'three');
  seed(ctx, third, { record: { commit: '0123456789abcdef0123456789abcdef01234567' } });
  commitTree(ctx.repo, { 'src/core/c.ts': 'c2\n' }, 'four');
  assert.match(cacheOk(ctx, 'lookup', '--max-ratio', '1'), / no-candidate$/);

  const fourth = commitTree(ctx.repo, { 'src/core/d.ts': 'd2\n' }, 'five');
  seed(ctx, fourth);
  commitTree(ctx.repo, { 'src/core/d.ts': 'd3\n' }, 'six');
  assert.match(cacheOk(ctx, 'lookup', '--max-ratio', '1'), /^near /);
  assert.match(cacheOk(ctx, 'lookup', '--max-ratio', '1', '--perspectives', 'data-flow'), / no-candidate$/);
});

test('a legacy record with only src_tree is still a candidate', (t) => {
  const ctx = makeRepo(t, SRC);
  const folder = seed(ctx, ctx.commit, { record: { trees: undefined, scan_dirs: undefined, src_tree: treeOf(ctx.repo, ctx.commit) } });
  commitTree(ctx.repo, { 'src/ui/a.ts': 'a2\n' }, 'two');
  assert.ok(cacheOk(ctx, 'lookup').startsWith(`near ${folder} `));
});

test('derive, then store, saves the update under the new fingerprint with its lineage', (t) => {
  const ctx = makeRepo(t, SRC);
  const from = seed(ctx, ctx.commit, { record: { chain_depth: 2, full_scan: { folder: 'aaaaaaaaaaaa', commit: 'x' } } });
  const head = commitTree(ctx.repo, { 'src/ui/a.ts': 'a2\n' }, 'two');
  const [, work, range] = cacheOk(ctx, 'derive', '--from', from).split(' ');
  assert.equal(range, `${ctx.commit}..${head}`);
  assert.ok(fs.existsSync(path.join(work, '.omm', 'overall-architecture', 'diagram.mmd')));
  assert.ok(!fs.existsSync(path.join(work, 'fingerprint.json')));

  const update = path.join(ctx.base, 'update.json');
  fs.writeFileSync(update, JSON.stringify({ files: 1, elements_written: 1, kept: ['overall-architecture/ui'] }));
  const stored = cacheOk(ctx, 'store', '--work', work, '--update', update);
  const folder = path.join(ctx.cacheDir, 'repo', treeOf(ctx.repo, head).slice(0, 12));
  assert.equal(stored, `stored ${folder}`);
  assert.ok(!fs.existsSync(work));
  assert.ok(!fs.existsSync(path.join(folder, 'derive.json')));
  const record = JSON.parse(fs.readFileSync(path.join(folder, 'fingerprint.json'), 'utf8'));
  assert.equal(record.commit, head);
  assert.deepEqual(record.derived_from, { folder: path.basename(from), commit: ctx.commit });
  assert.equal(record.chain_depth, 3);
  assert.deepEqual(record.full_scan, { folder: 'aaaaaaaaaaaa', commit: 'x' });
  assert.equal(record.update.range, `${ctx.commit}..${head}`);
  assert.deepEqual(record.update.kept, ['overall-architecture/ui']);
  assert.ok(fs.existsSync(path.join(from, 'fingerprint.json')), 'the source scan is left as it was');
  assert.equal(cacheOk(ctx, 'lookup'), `hit ${folder}`);
});

test('store keeps a scan another run already stored for the same tree', (t) => {
  const ctx = makeRepo(t, SRC);
  const from = seed(ctx, ctx.commit);
  commitTree(ctx.repo, { 'src/ui/a.ts': 'a2\n' }, 'two');
  const work1 = cacheOk(ctx, 'derive', '--from', from).split(' ')[1];
  const update = path.join(ctx.base, 'update.json');
  fs.writeFileSync(update, '{}');
  const folder = cacheOk(ctx, 'store', '--work', work1, '--update', update).split(' ')[1];
  const work2 = `${folder}.partial-1`;
  fs.cpSync(work1.replace(/\.partial-\d+$/, ''), work2, { recursive: true });
  fs.renameSync(path.join(work2, 'fingerprint.json'), path.join(work2, 'derive.json'));
  fs.writeFileSync(path.join(work2, 'derive.json'), JSON.stringify({
    from: { folder: 'x', commit: ctx.commit }, from_chain_depth: 0, from_full_scan: {}, at: 'y',
    scan_dirs: ['src'], trees: JSON.parse(fs.readFileSync(path.join(folder, 'fingerprint.json'), 'utf8')).trees,
  }));
  assert.equal(cacheOk(ctx, 'store', '--work', work2, '--update', update), `exists ${folder}`);
  assert.ok(!fs.existsSync(work2));
});

test('store without --work moves the working tree .omm/ and refuses a tracked one', (t) => {
  const ctx = makeRepo(t, SRC);
  writeTree(path.join(ctx.repo, '.omm'), OMM);
  const folder = cacheOk(ctx, 'store', '--perspectives', 'overall-architecture').split(' ')[1];
  assert.ok(!fs.existsSync(path.join(ctx.repo, '.omm')));
  const record = JSON.parse(fs.readFileSync(path.join(folder, 'fingerprint.json'), 'utf8'));
  assert.equal(record.chain_depth, 0);
  assert.equal(record.src_tree, treeOf(ctx.repo, ctx.commit));
  assert.equal(cacheOk(ctx, 'check'), 'none');

  writeTree(path.join(ctx.repo, '.omm'), OMM);
  git(ctx.repo, 'add', '.omm');
  const refused = cache(ctx, 'store');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /tracked/);
  assert.equal(cache(ctx, 'check').status, 1);
});

test('an exact tree without a wanted perspective is not a hit', (t) => {
  const ctx = makeRepo(t, SRC);
  seed(ctx, ctx.commit);
  assert.match(cacheOk(ctx, 'lookup', '--perspectives', 'data-flow'), / no-candidate$/);
  assert.match(cacheOk(ctx, 'lookup', '--perspectives', 'overall-architecture'), /^hit /);
});

test('a full scan with a new perspective replaces the stored one and keeps its other perspectives', (t) => {
  const ctx = makeRepo(t, SRC);
  const folder = seed(ctx, ctx.commit);
  writeTree(path.join(ctx.repo, '.omm'), {
    'data-flow/diagram.mmd': diagram(node('ui', 'UI', 'src/ui/')),
    'data-flow/ui/description.md': 'ui\n',
  });
  assert.equal(cacheOk(ctx, 'store', '--perspectives', 'data-flow'), `stored ${folder}`);
  assert.ok(fs.existsSync(path.join(folder, '.omm', 'data-flow', 'diagram.mmd')));
  assert.ok(fs.existsSync(path.join(folder, '.omm', 'overall-architecture', 'diagram.mmd')));
  const record = JSON.parse(fs.readFileSync(path.join(folder, 'fingerprint.json'), 'utf8'));
  assert.deepEqual(record.perspectives.sort(), ['data-flow', 'overall-architecture']);
  assert.deepEqual(fs.readdirSync(path.dirname(folder)), [path.basename(folder)]);

  writeTree(path.join(ctx.repo, '.omm'), { 'data-flow/diagram.mmd': 'graph LR\n' });
  assert.equal(cacheOk(ctx, 'store', '--perspectives', 'data-flow'), `exists ${folder}`);
  assert.ok(!fs.existsSync(path.join(ctx.repo, '.omm')));
});

test('store refuses a full scan whose working tree does not match the commit', (t) => {
  const ctx = makeRepo(t, SRC);
  const first = ctx.commit;
  commitTree(ctx.repo, { 'src/ui/a.ts': 'a2\n' }, 'two');
  writeTree(path.join(ctx.repo, '.omm'), OMM);
  const other = cache(ctx, 'store', '--at', first);
  assert.equal(other.status, 2);
  assert.match(other.stderr, /does not match/);
  writeTree(ctx.repo, { 'src/ui/b.ts': 'dirty\n' });
  assert.equal(cache(ctx, 'store').status, 2);
  assert.ok(fs.existsSync(path.join(ctx.repo, '.omm')), 'the scan is left in place');
});

test('export refuses to replace a .omm/ that holds ignored files', (t) => {
  const ctx = makeRepo(t, SRC);
  seed(ctx, ctx.commit);
  commitTree(ctx.repo, { '.omm/overall-architecture/description.md': 'old\n', '.gitignore': '.omm/*.local\n' }, 'omm');
  writeTree(ctx.repo, { '.omm/notes.local': 'mine\n' });
  const refused = cache(ctx, 'export');
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /ignored/);
  assert.ok(fs.existsSync(path.join(ctx.repo, '.omm', 'notes.local')));
});

test('discard removes only work folders', (t) => {
  const ctx = makeRepo(t, SRC);
  const from = seed(ctx, ctx.commit);
  commitTree(ctx.repo, { 'src/ui/a.ts': 'a2\n' }, 'two');
  const work = cacheOk(ctx, 'derive', '--from', from).split(' ')[1];
  assert.equal(cacheOk(ctx, 'discard', '--work', work), `discarded ${work}`);
  assert.ok(!fs.existsSync(work));
  assert.equal(cache(ctx, 'discard', '--work', from).status, 2);
  assert.ok(fs.existsSync(from));
});

function gateFor(ctx, mapping) {
  const from = seed(ctx, ctx.commit);
  commitTree(ctx.repo, { 'src/ui/a.ts': 'a2\n' }, 'two');
  const work = cacheOk(ctx, 'derive', '--from', from).split(' ')[1];
  const file = path.join(ctx.base, 'mapping.json');
  fs.writeFileSync(file, JSON.stringify({ matched: [], unmatched: [], deletionCandidates: [], ...mapping }));
  return cache(ctx, 'gate', '--work', work, '--mapping', file).line;
}

test('gate is ok for a small change inside known folders', (t) => {
  const ctx = makeRepo(t, SRC);
  const line = gateFor(ctx, {
    matched: [{ file: 'src/ui/a.ts', status: 'M', elements: ['overall-architecture/ui'] }],
    unmatched: ['src/ui/new.ts', 'src/main.ts'],
  });
  assert.equal(line, 'ok');
});

test('gate asks for a full scan when a new top folder appears', (t) => {
  const ctx = makeRepo(t, SRC);
  assert.equal(gateFor(ctx, { unmatched: ['src/payments/pay.ts'] }), 'full new-top-folder src/payments/');
});

test('gate asks for a full scan when a top element loses all its paths', (t) => {
  const ctx = makeRepo(t, SRC);
  const line = gateFor(ctx, { deletionCandidates: [{ element: 'overall-architecture/core', paths: ['src/core/'] }] });
  assert.equal(line, 'full top-element-gone overall-architecture/core');
});

test('gate asks for a full scan when more than half of the elements are hit', (t) => {
  const ctx = makeRepo(t, SRC);
  const line = gateFor(ctx, {
    matched: [
      { file: 'src/ui/a.ts', status: 'M', elements: ['overall-architecture/ui'] },
      { file: 'src/core/c.ts', status: 'M', elements: ['overall-architecture/core'] },
    ],
  });
  assert.equal(line, 'full too-many-elements 2/2');
});

test('map-changes --at judges deleted paths by that commit, not the working tree', (t) => {
  const ctx = makeRepo(t, SRC);
  const omm = path.join(ctx.base, 'omm');
  writeTree(omm, OMM);
  const head = commitTree(ctx.repo, { 'src/core/c.ts': null, 'src/core/d.ts': null }, 'drop core');
  writeTree(ctx.repo, { 'src/core/c.ts': 'back in the working tree\n' });
  const changes = path.join(ctx.base, 'changes');
  fs.writeFileSync(changes, 'D\tsrc/core/c.ts\nD\tsrc/core/d.ts\n');

  const byTree = JSON.parse(run(MAP, ['--omm', omm, '--changes', changes, '--root', ctx.repo], ctx.repo).stdout);
  assert.deepEqual(byTree.deletionCandidates, []);
  const done = run(MAP, ['--omm', omm, '--changes', changes, '--root', ctx.repo, '--at', head], ctx.repo);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(JSON.parse(done.stdout).deletionCandidates, [
    { element: 'overall-architecture/core', paths: ['src/core/'] },
  ]);
});

test('unknown commands and arguments exit with code 2', (t) => {
  const ctx = makeRepo(t, SRC);
  assert.equal(cache(ctx, 'nope').status, 2);
  assert.equal(cache(ctx, 'lookup', '--bogus', 'x').status, 2);
  assert.equal(cache(ctx, 'derive').status, 2);
});
