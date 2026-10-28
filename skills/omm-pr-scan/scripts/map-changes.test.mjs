import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'map-changes.mjs');
const NL = '\\n';

function makeTemp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'map-changes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

function writeTree(base, tree) {
  for (const [relative, content] of Object.entries(tree)) {
    const absolute = path.join(base, ...relative.split('/'));
    if (content === null) {
      fs.mkdirSync(absolute, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
}

function run(args, input = '', options = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    input,
    encoding: 'utf8',
    ...options,
  });
}

function runOk(args, input = '', options = {}) {
  const result = run(args, input, options);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  return JSON.parse(result.stdout);
}

function diagram(...lines) {
  return `graph LR\n${lines.map((line) => `    ${line}`).join('\n')}\n`;
}

function node(id, title, paths) {
  return `${id}["${title}${NL}${paths}"]`;
}

test('the deepest matching element wins when responsible paths overlap', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/arch/diagram.mmd': diagram(
      node('area', 'Area', 'src/'),
      node('specific', 'Specific', 'src/feature/'),
    ),
    '.omm/arch/area/meta.yaml': '',
    '.omm/arch/specific/meta.yaml': '',
  });

  const out = runOk(['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base], 'M\tsrc/feature/x.ts\n');
  assert.deepEqual(out.matched, [
    { file: 'src/feature/x.ts', status: 'M', elements: ['arch/specific'] },
  ]);
});

test('when the matching path length ties, the deeper element wins', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/arch/diagram.mmd': diagram(node('parent', 'Parent', 'src/cache/*ListCache.ts')),
    '.omm/arch/parent/meta.yaml': '',
    '.omm/arch/parent/diagram.mmd': diagram(node('child', 'Child', 'src/cache/*ListCache.ts')),
    '.omm/arch/parent/child/meta.yaml': '',
  });

  const out = runOk(['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base], 'M\tsrc/cache/FooListCache.ts\n');
  assert.deepEqual(out.matched, [
    { file: 'src/cache/FooListCache.ts', status: 'M', elements: ['arch/parent/child'] },
  ]);
});

test('a file can match an element in more than one view', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/overall-architecture/diagram.mmd': diagram(node('hooks', 'Hooks', 'src/hooks/')),
    '.omm/overall-architecture/hooks/meta.yaml': '',
    '.omm/dependency-map/diagram.mmd': diagram(node('hooks', 'Hooks', 'src/hooks/')),
    '.omm/dependency-map/hooks/meta.yaml': '',
  });

  const out = runOk(['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base], 'M\tsrc/hooks/x.ts\n');
  assert.deepEqual(out.matched, [
    {
      file: 'src/hooks/x.ts',
      status: 'M',
      elements: ['dependency-map/hooks', 'overall-architecture/hooks'],
    },
  ]);
});

test('a folder path is a prefix match and a file path is an exact match', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(
      node('folder', 'Folder', 'src/hooks/'),
      node('exact', 'Exact', 'src/hooks/a.ts'),
      node('bak', 'Bak', 'src/hooks/a.ts.bak'),
    ),
    '.omm/v/folder/meta.yaml': '',
    '.omm/v/exact/meta.yaml': '',
    '.omm/v/bak/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'M\tsrc/hooks/a.ts\nM\tsrc/hooks/b.ts\nM\tsrc/hooks/a.ts.bak\nM\tsrc/hooks-extra/c.ts\n',
  );
  assert.deepEqual(out.matched, [
    { file: 'src/hooks/a.ts', status: 'M', elements: ['v/exact'] },
    { file: 'src/hooks/a.ts.bak', status: 'M', elements: ['v/bak'] },
    { file: 'src/hooks/b.ts', status: 'M', elements: ['v/folder'] },
  ]);
  assert.deepEqual(out.unmatched, ['src/hooks-extra/c.ts']);
});

test('one label can carry several responsible paths', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(node('multi', 'Multi', 'src/a.ts, src/b.ts、src/c.ts')),
    '.omm/v/multi/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'M\tsrc/a.ts\nM\tsrc/b.ts\nM\tsrc/c.ts\n',
  );
  assert.deepEqual(out.matched, [
    { file: 'src/a.ts', status: 'M', elements: ['v/multi'] },
    { file: 'src/b.ts', status: 'M', elements: ['v/multi'] },
    { file: 'src/c.ts', status: 'M', elements: ['v/multi'] },
  ]);
});

test('non-path label words are dropped, while lower-case extensions are accepted', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(
      node('ok', 'OK', 'src/ok.ts'),
      node('dotted', 'Dotted', 'AppStep.PREVIEW'),
      node('local', 'Local', 'localStorage, Cache Storage'),
      node('expr', 'Expr', 'leaveTarget !== undefined'),
      node('external', 'External', '(外部・決済)'),
      node('arrow', 'Arrow', 'EXTERIOR → EDIT'),
      node('spaced', 'Spaced', '通常 (選択・ドラッグ)'),
      node('ext', 'Ext', 'vite.config.mts, package.json'),
    ),
    '.omm/v/ok/meta.yaml': '',
    '.omm/v/dotted/meta.yaml': '',
    '.omm/v/local/meta.yaml': '',
    '.omm/v/expr/meta.yaml': '',
    '.omm/v/external/meta.yaml': '',
    '.omm/v/arrow/meta.yaml': '',
    '.omm/v/spaced/meta.yaml': '',
    '.omm/v/ext/meta.yaml': '',
  });

  const nonPaths = [
    'AppStep.PREVIEW',
    'localStorage',
    'Cache Storage',
    'leaveTarget !== undefined',
    '(外部・決済)',
    'EXTERIOR → EDIT',
    '通常 (選択・ドラッグ)',
  ];
  const input = [
    'M\tsrc/ok.ts',
    'M\tvite.config.mts',
    'M\tpackage.json',
    ...nonPaths.map((word) => `M\t${word}`),
  ].join('\n');
  const out = runOk(['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base], input);

  assert.deepEqual(out.matched, [
    { file: 'package.json', status: 'M', elements: ['v/ext'] },
    { file: 'src/ok.ts', status: 'M', elements: ['v/ok'] },
    { file: 'vite.config.mts', status: 'M', elements: ['v/ext'] },
  ]);
  assert.deepEqual(out.unmatched, [...nonPaths].sort());
});

test('the default exclusions cover tests, docs, locks, github, omm and static assets', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(node('all', 'All', 'src/')),
    '.omm/v/all/meta.yaml': '',
  });

  const excludedFiles = [
    'src/a.test.ts',
    'src/a.spec.ts',
    'src/__tests__/a.ts',
    'e2e/a.ts',
    'docs/a.ts',
    'README.md',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'bun.lockb',
    '.github/workflows/a.yml',
    '.omm/config.yaml',
    'public/a.png',
    'src/b.svg',
  ];
  const input = ['M\tsrc/a.ts', ...excludedFiles.map((file) => `M\t${file}`)].join('\n');
  const out = runOk(['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base], input);

  assert.deepEqual(out.matched, [{ file: 'src/a.ts', status: 'M', elements: ['v/all'] }]);
  assert.deepEqual(out.unmatched, []);
  assert.equal(out.excluded, excludedFiles.length);
});

test('--exclude adds to the default exclusions and can be repeated', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(node('gen', 'Gen', 'src/generated/')),
    '.omm/v/gen/meta.yaml': '',
  });
  const input = 'M\tsrc/generated/a.ts\nM\tsrc/other.ts\n';

  const plain = runOk(['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base], input);
  assert.deepEqual(plain.matched, [
    { file: 'src/generated/a.ts', status: 'M', elements: ['v/gen'] },
  ]);
  assert.deepEqual(plain.unmatched, ['src/other.ts']);
  assert.equal(plain.excluded, 0);

  const filtered = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base, '--exclude', 'src/generated/**'],
    input,
  );
  assert.deepEqual(filtered.matched, []);
  assert.deepEqual(filtered.unmatched, ['src/other.ts']);
  assert.equal(filtered.excluded, 1);

  const both = runOk(
    [
      '--omm',
      path.join(base, '.omm'),
      '--changes',
      '-',
      '--root',
      base,
      '--exclude',
      'src/generated/**',
      '--exclude',
      'src/other.ts',
    ],
    input,
  );
  assert.deepEqual(both, {
    matched: [],
    renamed: [],
    unmatched: [],
    deletionCandidates: [],
    excluded: 2,
  });
});

test('a rename reports the element whose responsible file path is the old path', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/arch/diagram.mmd': diagram(
      node('app', 'App', 'src/index.tsx, src/view/Root.tsx'),
    ),
    '.omm/arch/app/meta.yaml': '',
    'src/view/Root.tsx': 'keep',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'R100\tsrc/index.tsx\tsrc/main.tsx\n',
  );
  assert.deepEqual(out.matched, [
    {
      file: 'src/main.tsx',
      status: 'R',
      from: 'src/index.tsx',
      elements: ['arch/app'],
    },
  ]);
  assert.deepEqual(out.renamed, [
    { element: 'arch/app', from: 'src/index.tsx', to: 'src/main.tsx' },
  ]);
  assert.deepEqual(out.deletionCandidates, []);
});

test('a rename uses the new path first, but still reports the old element', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/arch/diagram.mmd': diagram(
      node('app', 'App', 'src/app/index.ts'),
      node('lib', 'Lib', 'src/lib/'),
    ),
    '.omm/arch/app/meta.yaml': '',
    '.omm/arch/lib/meta.yaml': '',
    'src/lib/index.ts': 'new home',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'R100\tsrc/app/index.ts\tsrc/lib/index.ts\n',
  );
  assert.deepEqual(out.matched, [
    {
      file: 'src/lib/index.ts',
      status: 'R',
      from: 'src/app/index.ts',
      elements: ['arch/lib'],
    },
  ]);
  assert.deepEqual(out.renamed, [
    { element: 'arch/app', from: 'src/app/index.ts', to: 'src/lib/index.ts' },
  ]);
  assert.deepEqual(out.deletionCandidates, []);
});

test('a rename whose new path is excluded is only counted as excluded', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/arch/diagram.mmd': diagram(node('app', 'App', 'src/a.ts')),
    '.omm/arch/app/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'R100\tsrc/a.ts\tsrc/a.test.ts\n',
  );
  assert.deepEqual(out, {
    matched: [],
    renamed: [],
    unmatched: [],
    deletionCandidates: [],
    excluded: 1,
  });
});

test('a copy is treated as an addition and does not create a rename', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/arch/diagram.mmd': diagram(node('imp', 'Imp', 'src/new.ts')),
    '.omm/arch/imp/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'C075\tsrc/old.ts\tsrc/new.ts\n',
  );
  assert.deepEqual(out.matched, [
    { file: 'src/new.ts', status: 'A', elements: ['arch/imp'] },
  ]);
  assert.equal('from' in out.matched[0], false);
  assert.deepEqual(out.renamed, []);
});

test('deletion candidates are elements hit by D whose every path is gone', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/arch/diagram.mmd': diagram(
      node('gone', 'Gone', 'src/gone.ts, src/gone2.ts'),
      node('alive', 'Alive', 'src/alive.ts, src/alive2.ts'),
      node('folderGone', 'FolderGone', 'src/folder-gone/'),
      node('globGone', 'GlobGone', 'src/cache/*Cache.ts'),
      node('noPaths', 'NoPaths', '(外部)'),
      node('unrelated', 'Unrelated', 'src/unrelated.ts'),
    ),
    '.omm/arch/gone/meta.yaml': '',
    '.omm/arch/alive/meta.yaml': '',
    '.omm/arch/folderGone/meta.yaml': '',
    '.omm/arch/globGone/meta.yaml': '',
    '.omm/arch/noPaths/meta.yaml': '',
    '.omm/arch/unrelated/meta.yaml': '',
    'src/alive.ts': '',
    'src/alive2.ts': '',
    'src/cache/other.ts': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'D\tsrc/gone.ts\nD\tsrc/alive.ts\nD\tsrc/folder-gone/x.ts\nD\tsrc/cache/FooCache.ts\n',
  );
  assert.deepEqual(out.matched, [
    { file: 'src/alive.ts', status: 'D', elements: ['arch/alive'] },
    { file: 'src/cache/FooCache.ts', status: 'D', elements: ['arch/globGone'] },
    { file: 'src/folder-gone/x.ts', status: 'D', elements: ['arch/folderGone'] },
    { file: 'src/gone.ts', status: 'D', elements: ['arch/gone'] },
  ]);
  assert.deepEqual(out.deletionCandidates, [
    { element: 'arch/folderGone', paths: ['src/folder-gone/'] },
    { element: 'arch/globGone', paths: ['src/cache/*Cache.ts'] },
    { element: 'arch/gone', paths: ['src/gone.ts', 'src/gone2.ts'] },
  ]);
});

test('glob responsible paths support *, **, braces and root-relative tokens', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(
      node('cache', 'Cache', 'src/cache/*ListCache.ts'),
      node('fetch', 'Fetch', 'src/usecases/fetch*.ts, get*.ts'),
      node('deep', 'Deep', 'src/**/marker.ts'),
    ),
    '.omm/v/cache/meta.yaml': '',
    '.omm/v/fetch/meta.yaml': '',
    '.omm/v/deep/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    [
      'M\tsrc/cache/ItemListCache.ts',
      'M\tsrc/cache/ListCache.ts',
      'M\tsrc/cache/sub/ItemListCache.ts',
      'M\tsrc/usecases/fetchItems.ts',
      'M\tgetItems.ts',
      'M\tsrc/usecases/getItems.ts',
      'M\tsrc/a/b/marker.ts',
      'M\tmarker.ts',
    ].join('\n'),
  );

  assert.deepEqual(out.matched, [
    { file: 'getItems.ts', status: 'M', elements: ['v/fetch'] },
    { file: 'src/a/b/marker.ts', status: 'M', elements: ['v/deep'] },
    { file: 'src/cache/ItemListCache.ts', status: 'M', elements: ['v/cache'] },
    { file: 'src/cache/ListCache.ts', status: 'M', elements: ['v/cache'] },
    { file: 'src/usecases/fetchItems.ts', status: 'M', elements: ['v/fetch'] },
  ]);
  assert.deepEqual(out.unmatched, [
    'marker.ts',
    'src/cache/sub/ItemListCache.ts',
    'src/usecases/getItems.ts',
  ]);
});

test('backslashes are normalized and CRLF lines are accepted', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(node('hooks', 'Hooks', 'src/hooks/')),
    '.omm/v/hooks/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'M\tsrc\\hooks\\a.ts\r\n',
  );
  assert.deepEqual(out.matched, [
    { file: 'src/hooks/a.ts', status: 'M', elements: ['v/hooks'] },
  ]);
});

test('an empty change list returns the five empty keys', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(),
    '.omm/v/meta.yaml': '',
  });

  const out = runOk(['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base], '');
  assert.deepEqual(Object.keys(out), [
    'matched',
    'renamed',
    'unmatched',
    'deletionCandidates',
    'excluded',
  ]);
  assert.deepEqual(out, {
    matched: [],
    renamed: [],
    unmatched: [],
    deletionCandidates: [],
    excluded: 0,
  });
});

test('matched and unmatched lists are sorted', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(
      node('a', 'A', 'src/a.ts'),
      node('b', 'B', 'src/b.ts'),
      node('c', 'C', 'src/c.ts'),
    ),
    '.omm/v/a/meta.yaml': '',
    '.omm/v/b/meta.yaml': '',
    '.omm/v/c/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'M\tsrc/c.ts\nM\tsrc/a.ts\nM\tsrc/b.ts\nM\tz.ts\nM\tm.ts\n',
  );
  assert.deepEqual(
    out.matched.map((entry) => entry.file),
    ['src/a.ts', 'src/b.ts', 'src/c.ts'],
  );
  assert.deepEqual(out.unmatched, ['m.ts', 'z.ts']);
});

test('class, classDef and arrow labels are not node definitions', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': [
      'graph LR',
      '    a["A' + NL + 'src/a.ts"]',
      '    b["B' + NL + '(外部)"]',
      '    a -->|"src/fake.ts"| b',
      '    class a entry',
      '    classDef entry fill:#fff',
      '',
    ].join('\n'),
    '.omm/v/a/meta.yaml': '',
    '.omm/v/b/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'M\tsrc/fake.ts\nM\tsrc/a.ts\n',
  );
  assert.deepEqual(out.matched, [{ file: 'src/a.ts', status: 'M', elements: ['v/a'] }]);
  assert.deepEqual(out.unmatched, ['src/fake.ts']);
});

test('a node without a matching folder is ignored', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(node('ghost', 'Ghost', 'src/ghost.ts')),
    '.omm/v/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'M\tsrc/ghost.ts\n',
  );
  assert.deepEqual(out.matched, []);
  assert.deepEqual(out.unmatched, ['src/ghost.ts']);
});

test('renamed is only emitted when the old path exactly equals a file path', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(
      node('folder', 'Folder', 'src/foo/'),
      node('glob', 'Glob', 'src/bar/*.ts'),
    ),
    '.omm/v/folder/meta.yaml': '',
    '.omm/v/glob/meta.yaml': '',
    'src/foo/other.ts': '',
    'src/bar/other.ts': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'R100\tsrc/foo/bar.ts\tsrc/foo/baz.ts\nR100\tsrc/bar/a.ts\tsrc/bar/b.ts\n',
  );
  assert.deepEqual(out.matched, [
    {
      file: 'src/bar/b.ts',
      status: 'R',
      from: 'src/bar/a.ts',
      elements: ['v/glob'],
    },
    {
      file: 'src/foo/baz.ts',
      status: 'R',
      from: 'src/foo/bar.ts',
      elements: ['v/folder'],
    },
  ]);
  assert.deepEqual(out.renamed, []);
  assert.deepEqual(out.deletionCandidates, []);
});

test('label words containing ASCII whitespace are not responsible paths', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(
      node('hooks', 'Hooks', 'src/hooks/'),
      node('spaced', 'Spaced', 'src/hooks/useX.ts and more'),
    ),
    '.omm/v/hooks/meta.yaml': '',
    '.omm/v/spaced/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'M\tsrc/hooks/useX.ts\n',
  );
  assert.deepEqual(out.matched, [
    { file: 'src/hooks/useX.ts', status: 'M', elements: ['v/hooks'] },
  ]);
});

test('a trailing non-ASCII note after a path is dropped and the path is kept', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(
      node('hooks', 'Hooks', 'src/hooks/'),
      node('spaced', 'Spaced', 'src/hooks/useX.ts ほか, src/y/ など'),
    ),
    '.omm/v/hooks/meta.yaml': '',
    '.omm/v/spaced/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'M\tsrc/hooks/useX.ts\nM\tsrc/y/z.ts\n',
  );
  assert.deepEqual(out.matched, [
    { file: 'src/hooks/useX.ts', status: 'M', elements: ['v/spaced'] },
    { file: 'src/y/z.ts', status: 'M', elements: ['v/spaced'] },
  ]);
});

test('when a file appears more than once, the last line wins', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(node('a', 'A', 'src/a.ts'), node('b', 'B', 'src/b.ts')),
    '.omm/v/a/meta.yaml': '',
    '.omm/v/b/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'M\tsrc/a.ts\nD\tsrc/a.ts\nA\tsrc/b.ts\nR100\tsrc/old.ts\tsrc/b.ts\nM\tsrc/b.ts\n',
  );
  assert.deepEqual(out.matched, [
    { file: 'src/a.ts', status: 'D', elements: ['v/a'] },
    { file: 'src/b.ts', status: 'M', elements: ['v/b'] },
  ]);
  assert.deepEqual(out.renamed, []);
  assert.equal(out.matched.length, 2);
});

test('quoted git paths are decoded, including octal UTF-8 bytes and escapes', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(node('q', 'Q', 'src/')),
    '.omm/v/q/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'M\t"src/\\343\\201\\202.ts"\nM\t"src/a\\"b\\\\c.ts"\nM\t"src/t\\tn.ts"\n',
  );
  assert.deepEqual(out.matched, [
    { file: 'src/a"b/c.ts', status: 'M', elements: ['v/q'] },
    { file: 'src/t\tn.ts', status: 'M', elements: ['v/q'] },
    { file: 'src/あ.ts', status: 'M', elements: ['v/q'] },
  ]);
});

test('a rename falls back to the old path only in the views where the new path misses', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/viewA/diagram.mmd': diagram(node('news', 'News', 'src/new/')),
    '.omm/viewA/news/meta.yaml': '',
    '.omm/viewB/diagram.mmd': diagram(node('olds', 'Olds', 'src/old/')),
    '.omm/viewB/olds/meta.yaml': '',
    'src/new/x.ts': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'R100\tsrc/old/x.ts\tsrc/new/x.ts\n',
  );
  assert.deepEqual(out.matched, [
    {
      file: 'src/new/x.ts',
      status: 'R',
      from: 'src/old/x.ts',
      elements: ['viewA/news', 'viewB/olds'],
    },
  ]);
});

test('a rename alone never produces a deletion candidate', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(node('gone', 'Gone', 'src/gone.ts')),
    '.omm/v/gone/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'R100\tsrc/gone.ts\tsrc/elsewhere.ts\n',
  );
  assert.deepEqual(out.matched, [
    { file: 'src/elsewhere.ts', status: 'R', from: 'src/gone.ts', elements: ['v/gone'] },
  ]);
  assert.deepEqual(out.renamed, [
    { element: 'v/gone', from: 'src/gone.ts', to: 'src/elsewhere.ts' },
  ]);
  assert.deepEqual(out.deletionCandidates, []);
});

test('a path moved by a rename in the same input counts as existing for deletion candidates', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(
      node('pair', 'Pair', 'src/a.ts, src/b.ts'),
      node('moved', 'Moved', 'src/c.ts, src/d.ts'),
    ),
    '.omm/v/pair/meta.yaml': '',
    '.omm/v/moved/meta.yaml': '',
    'src/b2.ts': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'D\tsrc/a.ts\nR100\tsrc/b.ts\tsrc/b2.ts\nD\tsrc/c.ts\nR100\tsrc/d.ts\tsrc/d2.ts\n',
  );
  assert.deepEqual(out.deletionCandidates, [
    { element: 'v/moved', paths: ['src/c.ts', 'src/d.ts'] },
  ]);
});

test('static asset extensions are excluded regardless of case', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(node('all', 'All', 'src/')),
    '.omm/v/all/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'M\tpublic/a.PNG\nM\tsrc/b.Svg\nM\tsrc/c.ts\n',
  );
  assert.deepEqual(out.matched, [{ file: 'src/c.ts', status: 'M', elements: ['v/all'] }]);
  assert.deepEqual(out.unmatched, []);
  assert.equal(out.excluded, 2);
});

test('same length and same depth ties are broken by element path order', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(
      node('b', 'B', 'src/*.ts'),
      node('a', 'A', 'src/*.ts'),
    ),
    '.omm/v/a/meta.yaml': '',
    '.omm/v/b/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', path.join(base, '.omm'), '--changes', '-', '--root', base],
    'M\tsrc/x.ts\n',
  );
  assert.deepEqual(out.matched, [{ file: 'src/x.ts', status: 'M', elements: ['v/a'] }]);
});

test('--changes can be a file instead of standard input', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(node('x', 'X', 'src/x.ts')),
    '.omm/v/x/meta.yaml': '',
    'changes.txt': 'M\tsrc/x.ts\n',
  });

  const out = runOk([
    '--omm',
    path.join(base, '.omm'),
    '--changes',
    path.join(base, 'changes.txt'),
    '--root',
    base,
  ]);
  assert.deepEqual(out.matched, [{ file: 'src/x.ts', status: 'M', elements: ['v/x'] }]);
});

test('--root defaults to the current working directory', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(node('gone', 'Gone', 'src/gone.ts')),
    '.omm/v/gone/meta.yaml': '',
  });

  const out = runOk(
    ['--omm', '.omm', '--changes', '-'],
    'D\tsrc/gone.ts\n',
    { cwd: base },
  );
  assert.deepEqual(out.deletionCandidates, [
    { element: 'v/gone', paths: ['src/gone.ts'] },
  ]);
});

test('usage errors exit with code 2 and one line on standard error', (t) => {
  const base = makeTemp(t);
  writeTree(base, {
    '.omm/v/diagram.mmd': diagram(),
    '.omm/v/meta.yaml': '',
  });
  const omm = path.join(base, '.omm');

  const cases = [
    ['--changes', '-'],
    ['--omm', omm],
    ['--omm', path.join(base, 'no-such-dir'), '--changes', '-'],
    ['--omm', omm, '--changes', path.join(base, 'no-such-file.txt')],
    ['--omm', omm, '--changes', '-', '--bogus'],
    ['--omm', omm, '--changes'],
    ['--omm', omm, '--changes', '-', 'extra'],
  ];
  for (const args of cases) {
    const result = run(args, '');
    assert.equal(result.status, 2, `args: ${args.join(' ')}`);
    assert.equal(result.stdout, '', `args: ${args.join(' ')}`);
    assert.equal(
      result.stderr.trim().split(/\r?\n/).length,
      1,
      `args: ${args.join(' ')}: ${result.stderr}`,
    );
    assert.match(result.stderr, /^map-changes: /);
  }
});
