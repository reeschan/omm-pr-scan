#!/usr/bin/env node
// Map changed files to the .omm elements that own them.
// Usage: node map-changes.mjs --omm <.omm folder> --changes <file | -> [--root <repo root>] [--exclude <glob>]...
// --changes is the output of `git diff --name-status -M`. Node standard library only.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_EXCLUDES = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**',
  'e2e/**',
  '**/*.md',
  'docs/**',
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/bun.lockb',
  '.github/**',
  '.omm/**',
];

// Static assets are matched without regard to the case of the extension.
const DEFAULT_EXCLUDES_IGNORE_CASE = [
  '**/*.{png,jpg,jpeg,gif,svg,webp,ico,woff,woff2,ttf,otf,glb,gltf,mp3,mp4}',
];

const NODE_RE = /([A-Za-z0-9_.-]+)\s*[\{\(\[]+"([^"]*)"/g;
const EXTENSION_RE = /^\.?[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*\.[a-z0-9]{1,5}$/;

function usageError(message) {
  process.stderr.write(`map-changes: ${message}\n`);
  process.exit(2);
}

function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toPosix(value) {
  return String(value).replace(/\\/g, '/');
}

const QUOTED_ESCAPES = {
  n: 10,
  t: 9,
  r: 13,
  a: 7,
  b: 8,
  f: 12,
  v: 11,
  '"': 34,
  '\\': 92,
};

// Decode a path quoted by git in C style (octal bytes are read as UTF-8).
function unquoteGitPath(value) {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const chars = Array.from(value.slice(1, -1));
  const bytes = [];
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    if (char !== '\\' || i + 1 >= chars.length) {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = chars[i + 1];
    if (/[0-7]/.test(next)) {
      let digits = '';
      while (digits.length < 3 && i + 1 < chars.length && /[0-7]/.test(chars[i + 1])) {
        i += 1;
        digits += chars[i];
      }
      bytes.push(parseInt(digits, 8) & 255);
    } else if (next in QUOTED_ESCAPES) {
      i += 1;
      bytes.push(QUOTED_ESCAPES[next]);
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

function normalizeChangePath(value) {
  let result = toPosix(unquoteGitPath(value));
  if (result.startsWith('./')) result = result.slice(2);
  return result;
}

function parseArgs(argv) {
  const options = { omm: null, changes: null, root: null, excludes: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--omm' || arg === '--changes' || arg === '--root' || arg === '--exclude') {
      const value = argv[i + 1];
      if (value === undefined) usageError(`${arg} requires a value`);
      i += 1;
      if (arg === '--omm') options.omm = value;
      else if (arg === '--changes') options.changes = value;
      else if (arg === '--root') options.root = value;
      else options.excludes.push(value);
    } else {
      usageError(`unknown argument: ${arg}`);
    }
  }
  if (!options.omm) usageError('--omm is required');
  if (!options.changes) usageError('--changes is required');
  return options;
}

function escapeRegExpChar(char) {
  return /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
}

// Glob support for the subset the contract needs: **, *, ? and {a,b}.
function globSource(glob) {
  let source = '';
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*') {
        i += 1;
        if (glob[i + 1] === '/') {
          i += 1;
          source += '(?:[^/]+/)*';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      const end = glob.indexOf('}', i + 1);
      if (end === -1) {
        source += '\\{';
      } else {
        const alternatives = glob.slice(i + 1, end).split(',');
        source += `(?:${alternatives.map((part) => globSource(part)).join('|')})`;
        i = end;
      }
    } else {
      source += escapeRegExpChar(char);
    }
  }
  return source;
}

function globToRegExp(glob, flags = '') {
  return new RegExp(`^${globSource(toPosix(glob))}$`, flags);
}

function isResponsiblePath(word) {
  if (!word) return false;
  if (/[^A-Za-z0-9_.\-\/*@{}]/.test(word)) return false;
  if (word.includes('/') || word.includes('*')) return true;
  return EXTENSION_RE.test(word);
}

function parseResponsiblePaths(label) {
  const separator = label.indexOf('\\n');
  if (separator === -1) return [];
  const field = label.slice(separator + 2);
  const result = [];
  for (const raw of field.split(/[,、]/)) {
    let word = toPosix(raw.trim());
    const space = word.search(/\s/);
    if (space !== -1) {
      // "src/x.ts ほか": a trailing note made only of non-ASCII characters is dropped.
      const note = word.slice(space).trim();
      if (note === '' || !/^[^\x00-\x7f]+$/.test(note)) continue;
      word = word.slice(0, space);
    }
    if (!isResponsiblePath(word)) continue;
    if (!result.includes(word)) result.push(word);
  }
  return result;
}

function collectDiagramFiles(dir, base, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectDiagramFiles(absolute, base, out);
    } else if (entry.isFile() && entry.name === 'diagram.mmd') {
      out.push({ absolute, relative: toPosix(path.relative(base, absolute)) });
    }
  }
}

function readElements(ommRoot) {
  const diagrams = [];
  collectDiagramFiles(ommRoot, ommRoot, diagrams);
  diagrams.sort((a, b) => byCodeUnit(a.relative, b.relative));

  const elements = new Map();
  for (const diagram of diagrams) {
    const dir = path.posix.dirname(diagram.relative);
    const elementDir = dir === '.' ? '' : dir;
    let text;
    try {
      text = fs.readFileSync(diagram.absolute, 'utf8');
    } catch {
      continue;
    }
    text = text.replace(/^\uFEFF/, '');
    for (const match of text.matchAll(NODE_RE)) {
      const id = match[1];
      if (id === '.' || id === '..') continue;
      const elementPath = elementDir ? `${elementDir}/${id}` : id;
      const absoluteElement = path.join(ommRoot, ...elementPath.split('/'));
      let stat;
      try {
        stat = fs.statSync(absoluteElement);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;

      let element = elements.get(elementPath);
      if (!element) {
        element = {
          path: elementPath,
          view: elementPath.split('/')[0],
          depth: elementPath.split('/').length,
          paths: [],
        };
        elements.set(elementPath, element);
      }
      for (const responsiblePath of parseResponsiblePaths(match[2])) {
        if (!element.paths.includes(responsiblePath)) element.paths.push(responsiblePath);
      }
    }
  }
  return [...elements.values()];
}

function responsiblePathKind(responsiblePath) {
  if (responsiblePath.endsWith('/')) return 'dir';
  if (responsiblePath.includes('*')) return 'glob';
  return 'file';
}

function matchesResponsiblePath(responsiblePath, file) {
  const kind = responsiblePathKind(responsiblePath);
  if (kind === 'dir') return file.startsWith(responsiblePath);
  if (kind === 'file') return file === responsiblePath;
  return globToRegExp(responsiblePath).test(file);
}

function matchFile(file, elements) {
  const bestPerView = new Map();
  for (const element of elements) {
    let bestLength = -1;
    for (const responsiblePath of element.paths) {
      if (responsiblePath.length > bestLength && matchesResponsiblePath(responsiblePath, file)) {
        bestLength = responsiblePath.length;
      }
    }
    if (bestLength === -1) continue;

    const current = bestPerView.get(element.view);
    const better =
      !current ||
      bestLength > current.length ||
      (bestLength === current.length && element.depth > current.element.depth) ||
      (bestLength === current.length &&
        element.depth === current.element.depth &&
        element.path < current.element.path);
    if (better) bestPerView.set(element.view, { element, length: bestLength });
  }
  const byView = new Map();
  for (const [view, entry] of bestPerView) byView.set(view, entry.element.path);
  return byView;
}

// A rename is matched per view: the new path first, and the old path only in
// the views where the new path matches nothing.
function matchRename(change, elements) {
  const byView = matchFile(change.file, elements);
  for (const [view, elementPath] of matchFile(change.old, elements)) {
    if (!byView.has(view)) byView.set(view, elementPath);
  }
  return [...byView.values()].sort(byCodeUnit);
}

// Later lines for the same file (the new path for R and C) replace earlier ones.
function parseChanges(text) {
  const changes = new Map();
  const normalized = text.replace(/^\uFEFF/, '');
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.trim() === '') continue;
    const fields = line.split('\t');
    const status = fields[0];
    if (!status) continue;

    if (status.startsWith('R')) {
      if (fields.length < 3) continue;
      const oldPath = normalizeChangePath(fields[1]);
      const newPath = normalizeChangePath(fields[2]);
      if (!oldPath || !newPath) continue;
      changes.set(newPath, { status: 'R', old: oldPath, file: newPath });
    } else if (status.startsWith('C')) {
      if (fields.length < 3) continue;
      const newPath = normalizeChangePath(fields[2]);
      if (!newPath) continue;
      changes.set(newPath, { status: 'A', old: null, file: newPath });
    } else {
      if (fields.length < 2) continue;
      const file = normalizeChangePath(fields[1]);
      if (!file) continue;
      let mappedStatus = 'M';
      if (status === 'A') mappedStatus = 'A';
      else if (status === 'D') mappedStatus = 'D';
      changes.set(file, { status: mappedStatus, old: null, file });
    }
  }
  return [...changes.values()];
}

function absoluteUnderRoot(root, relativePath) {
  const clean = relativePath.replace(/^\/+/, '');
  const parts = clean.split('/').filter((part) => part !== '');
  return path.join(root, ...parts);
}

function globExistsUnderRoot(root, glob) {
  const matcher = globToRegExp(glob);
  const firstSpecial = glob.search(/[*?{]/);
  const prefix = firstSpecial === -1 ? glob : glob.slice(0, firstSpecial);
  let directory = prefix.endsWith('/') ? prefix.slice(0, -1) : path.posix.dirname(prefix);
  if (directory === '.' || directory === '/') directory = '';
  const start = absoluteUnderRoot(root, directory);

  let found = false;
  const walk = (dir) => {
    if (found) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found) return;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
      } else if (entry.isFile()) {
        const relative = toPosix(path.relative(root, absolute));
        if (matcher.test(relative)) {
          found = true;
          return;
        }
      }
    }
  };
  walk(start);
  return found;
}

// movedFrom: old paths of renames in the same input whose new path exists under root.
function responsiblePathStillExists(root, responsiblePath, movedFrom) {
  const kind = responsiblePathKind(responsiblePath);
  if (movedFrom.some((old) => matchesResponsiblePath(responsiblePath, old))) return true;
  if (kind === 'glob') return globExistsUnderRoot(root, responsiblePath);
  const target = absoluteUnderRoot(root, responsiblePath.replace(/\/+$/, ''));
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return false;
  }
  return kind === 'dir' ? stat.isDirectory() : stat.isFile();
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  const ommRoot = path.resolve(options.omm);
  let ommStat;
  try {
    ommStat = fs.statSync(ommRoot);
  } catch {
    usageError(`--omm folder not found: ${options.omm}`);
  }
  if (!ommStat.isDirectory()) usageError(`--omm is not a folder: ${options.omm}`);

  let changesText;
  try {
    changesText =
      options.changes === '-'
        ? fs.readFileSync(0, 'utf8')
        : fs.readFileSync(path.resolve(options.changes), 'utf8');
  } catch {
    usageError(`cannot read --changes: ${options.changes}`);
  }

  const root = path.resolve(options.root ?? process.cwd());
  const excludes = [
    ...[...DEFAULT_EXCLUDES, ...options.excludes].map((glob) => globToRegExp(glob)),
    ...DEFAULT_EXCLUDES_IGNORE_CASE.map((glob) => globToRegExp(glob, 'i')),
  ];
  const elements = readElements(ommRoot);
  const changes = parseChanges(changesText);
  const movedFrom = changes
    .filter((change) => change.status === 'R' && fs.existsSync(absoluteUnderRoot(root, change.file)))
    .map((change) => change.old);

  const matched = [];
  const renamedByIdentity = new Map();
  const unmatched = new Set();
  const deletionHits = new Set();
  let excluded = 0;

  for (const change of changes) {
    if (excludes.some((matcher) => matcher.test(change.file))) {
      excluded += 1;
      continue;
    }

    if (change.status === 'R') {
      const hit = matchRename(change, elements);

      for (const element of elements) {
        if (element.paths.some((p) => responsiblePathKind(p) === 'file' && p === change.old)) {
          renamedByIdentity.set(`${element.path}\u0000${change.old}\u0000${change.file}`, {
            element: element.path,
            from: change.old,
            to: change.file,
          });
        }
      }

      if (hit.length > 0) {
        const entry = { file: change.file, status: 'R', from: change.old, elements: hit };
        matched.push(entry);
      } else {
        unmatched.add(change.file);
      }
      continue;
    }

    const hit = [...matchFile(change.file, elements).values()].sort(byCodeUnit);
    if (hit.length > 0) {
      matched.push({ file: change.file, status: change.status, elements: hit });
      if (change.status === 'D') {
        for (const elementPath of hit) deletionHits.add(elementPath);
      }
    } else {
      unmatched.add(change.file);
    }
  }

  matched.sort((a, b) => byCodeUnit(a.file, b.file) || byCodeUnit(a.status, b.status));
  for (const entry of matched) entry.elements.sort(byCodeUnit);

  const renamed = [...renamedByIdentity.values()].sort(
    (a, b) =>
      byCodeUnit(a.element, b.element) ||
      byCodeUnit(a.from, b.from) ||
      byCodeUnit(a.to, b.to),
  );

  const deletionCandidates = [];
  for (const element of elements) {
    if (!deletionHits.has(element.path)) continue;
    if (element.paths.length === 0) continue;
    if (element.paths.every((p) => !responsiblePathStillExists(root, p, movedFrom))) {
      deletionCandidates.push({ element: element.path, paths: [...element.paths] });
    }
  }
  deletionCandidates.sort((a, b) => byCodeUnit(a.element, b.element));

  const result = {
    matched,
    renamed,
    unmatched: [...unmatched].sort(byCodeUnit),
    deletionCandidates,
    excluded,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main();
