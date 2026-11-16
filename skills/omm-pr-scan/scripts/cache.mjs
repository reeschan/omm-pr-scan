#!/usr/bin/env node
// Keep omm scans outside the repository, keyed by the tree of the scanned commit, and bring the
// nearest stored scan up to another commit by its diff. Node standard library only.
//
//   node cache.mjs lookup [--at REF] [--perspectives a,b] [--max-ratio 0.4] [--max-chain 5]
//   node cache.mjs derive --from FOLDER [--at REF]
//   node cache.mjs gate   --work DIR --mapping FILE
//   node cache.mjs store  [--work DIR --update FILE | --at REF --perspectives a,b] [--note TEXT]
//   node cache.mjs discard --work DIR
//   node cache.mjs check
//   node cache.mjs export [--at REF]
//
// Common options: --repo DIR (default: the current directory), --cache-dir DIR, --scan-dirs a,b.
//
// Cache root: --cache-dir, else $OMM_CACHE_DIR, else .omm-cache beside the main clone.
// Under it: <main clone name>/<first 12 of the fingerprint>/ holds .omm/ and fingerprint.json.
// Fingerprint: for each scan dir, `git rev-parse <commit>:<dir>`. One dir: that hash. Several: the
// sha256 of the sorted "<dir> <hash>" lines. Scan dirs default to src when it exists, else the root.
//
// lookup prints one line: `hit <folder>`, `near <folder> <commit> <files>` or `miss <folder> <reason>`.
//   near: the stored scan whose commit is closest to REF (fewest changed files under the scan dirs,
//   not counting the files map-changes excludes). Any stored commit counts, not only ancestors.
// derive copies the near folder's .omm/ into <target>.partial-<pid>/ and prints
//   `derived <work dir> <from commit>..<at commit>`. Run omm with that folder as the working directory.
// gate reads map-changes output for the work dir and prints `ok`, or `full <reason>` when a full
//   scan is the better choice (a new top folder, a removed top element, too many elements hit).
// store saves a work dir under its fingerprint (or, with --at, moves the working tree's .omm/ there; the
//   scan dirs of the working tree must then match REF). A stored scan of the same trees is kept only when it
//   has every perspective of the new one; otherwise the new one replaces it and takes over its other perspectives.
// Exit codes: 0 = done, 1 = (check) .omm/ is left in the working tree, 2 = bad arguments, git or input.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_EXCLUDES,
  DEFAULT_EXCLUDES_IGNORE_CASE,
  globToRegExp,
  readElements,
} from './map-changes.mjs';

const OMM = '.omm';
const PREFIX = 12;
const RECORD = 'fingerprint.json';
const DERIVE = 'derive.json';
const PARTIAL = '.partial-';
export const DEFAULTS = { maxRatio: 0.4, maxChain: 5, maxHitRatio: 0.5 };

class Failure extends Error {}

function fail(message) {
  throw new Failure(message);
}

function git(root, args, { allowFail = false } = {}) {
  const done = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (done.status !== 0) {
    if (allowFail) return null;
    fail(`git ${args.join(' ')}: ${(done.stderr || '').trim()}`);
  }
  return done.stdout.replace(/\n$/, '');
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function list(value) {
  return (value || '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

export function excludeMatchers() {
  return [
    ...DEFAULT_EXCLUDES.map((glob) => globToRegExp(glob)),
    ...DEFAULT_EXCLUDES_IGNORE_CASE.map((glob) => globToRegExp(glob, 'i')),
  ];
}

function counted(files) {
  const matchers = excludeMatchers();
  return files.filter((file) => file !== '' && !matchers.some((matcher) => matcher.test(file)));
}

export function fingerprintOf(trees) {
  const dirs = Object.keys(trees);
  if (dirs.length === 1) return trees[dirs[0]];
  const joined = dirs
    .sort()
    .map((dir) => `${dir} ${trees[dir]}`)
    .join('\n');
  return crypto.createHash('sha256').update(joined, 'utf8').digest('hex');
}

function semverOf(text) {
  const match = /(\d+)\.(\d+)/.exec(text || '');
  return match ? `${match[1]}.${match[2]}` : null;
}

class Repo {
  constructor(options) {
    this.options = options;
    this.root = git(path.resolve(options.repo || '.'), ['rev-parse', '--show-toplevel']);
    const common = git(this.root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    this.mainClone = path.basename(common) === '.git' ? path.dirname(common) : common;
  }

  commit(ref) {
    return git(this.root, ['rev-parse', '--verify', `${ref || 'HEAD'}^{commit}`]);
  }

  scanDirs(commit) {
    const given = list(this.options['scan-dirs']);
    if (given.length > 0) return given;
    return git(this.root, ['cat-file', '-e', `${commit}:src`], { allowFail: true }) === null ? ['.'] : ['src'];
  }

  trees(commit, dirs) {
    const found = {};
    for (const dir of dirs) {
      const spec = dir === '.' || dir === '' ? `${commit}^{tree}` : `${commit}:${dir.replace(/\/+$/, '')}`;
      found[dir] = git(this.root, ['rev-parse', spec]);
    }
    return found;
  }

  cacheRoot() {
    const configured = this.options['cache-dir'] || process.env.OMM_CACHE_DIR;
    const base = configured ? path.resolve(configured) : path.join(path.dirname(this.mainClone), '.omm-cache');
    return path.join(base, path.basename(this.mainClone));
  }

  target(ref) {
    const commit = this.commit(ref);
    const dirs = this.scanDirs(commit);
    const trees = this.trees(commit, dirs);
    return { commit, dirs, trees, folder: path.join(this.cacheRoot(), fingerprintOf(trees).slice(0, PREFIX)) };
  }

  hasCommit(commit) {
    return git(this.root, ['cat-file', '-e', `${commit}^{commit}`], { allowFail: true }) !== null;
  }

  pathspec(dirs) {
    return dirs.map((dir) => (dir === '' ? '.' : dir));
  }

  changedFiles(from, to, dirs) {
    const out = git(this.root, ['diff', '--name-only', '-z', from, to, '--', ...this.pathspec(dirs)]);
    return counted(out.split('\0'));
  }

  fileCount(commit, dirs) {
    const out = git(this.root, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', commit, '--', ...this.pathspec(dirs)]);
    return counted(out.split('\0')).length;
  }

  isAncestor(commit, of) {
    return git(this.root, ['merge-base', '--is-ancestor', commit, of], { allowFail: true }) !== null;
  }
}

function storedTrees(record) {
  if (record && record.trees && typeof record.trees === 'object') return record.trees;
  if (record && typeof record.src_tree === 'string' && record.src_tree) return { src: record.src_tree };
  return null;
}

function sameDirs(a, b) {
  return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
}

function isHit(folder, trees) {
  const stored = storedTrees(readJson(path.join(folder, RECORD)));
  return Boolean(stored) && JSON.stringify(sortKeys(stored)) === JSON.stringify(sortKeys(trees))
    && fs.existsSync(path.join(folder, OMM));
}

function sortKeys(object) {
  return Object.fromEntries(Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function perspectivesIn(folder) {
  try {
    return fs
      .readdirSync(path.join(folder, OMM), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function covers(folder, wanted) {
  const has = perspectivesIn(folder);
  return wanted.every((name) => has.includes(name));
}

function ommVersion() {
  const done = spawnSync('omm', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', windowsHide: true });
  const out = done.status === 0 ? done.stdout.trim() : '';
  if (!out) return null;
  return out.startsWith('omm ') ? out : `omm ${out}`;
}

// Each stored scan that could be brought up to `target`, with why the others cannot.
export function candidates(repo, target, options) {
  const wanted = list(options.perspectives);
  const current = semverOf(options.ommVersion);
  const found = [];
  const rejected = [];
  let entries = [];
  try {
    entries = fs.readdirSync(repo.cacheRoot(), { withFileTypes: true });
  } catch {
    return { found, rejected };
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.includes(PARTIAL)) continue;
    const folder = path.join(repo.cacheRoot(), entry.name);
    const record = readJson(path.join(folder, RECORD));
    const trees = storedTrees(record);
    const reject = (reason) => rejected.push({ folder: entry.name, reason });
    if (!record || !trees || typeof record.commit !== 'string') {
      reject('no commit or tree in fingerprint.json');
      continue;
    }
    if (!fs.existsSync(path.join(folder, OMM))) {
      reject('no .omm');
      continue;
    }
    if (!sameDirs(Object.keys(trees), target.dirs)) {
      reject('other scan dirs');
      continue;
    }
    if (!repo.hasCommit(record.commit)) {
      reject('commit not in this clone');
      continue;
    }
    const has = perspectivesIn(folder);
    const missing = wanted.filter((name) => !has.includes(name));
    if (missing.length > 0) {
      reject(`missing perspectives ${missing.join(',')}`);
      continue;
    }
    const stored = semverOf(record.omm_version);
    if (current && stored && current !== stored) {
      reject(`omm ${stored} (now ${current})`);
      continue;
    }
    const chain = Number.isInteger(record.chain_depth) ? record.chain_depth : 0;
    if (chain >= options.maxChain) {
      reject(`chain depth ${chain}`);
      continue;
    }
    found.push({
      folder,
      name: entry.name,
      commit: record.commit,
      chain,
      scannedAt: record.scanned_at || '',
      files: repo.changedFiles(record.commit, target.commit, target.dirs).length,
      ancestor: repo.isAncestor(record.commit, target.commit),
    });
  }
  found.sort(
    (a, b) =>
      a.files - b.files ||
      Number(b.ancestor) - Number(a.ancestor) ||
      a.chain - b.chain ||
      (a.scannedAt < b.scannedAt ? 1 : a.scannedAt > b.scannedAt ? -1 : 0),
  );
  return { found, rejected };
}

function numberOption(options, name, fallback) {
  if (options[name] === undefined) return fallback;
  const value = Number(options[name]);
  if (!Number.isFinite(value) || value < 0) fail(`--${name} must be a non-negative number`);
  return value;
}

export function lookup(repo, options) {
  const target = repo.target(options.at);
  if (isHit(target.folder, target.trees) && covers(target.folder, list(options.perspectives))) {
    return `hit ${target.folder}`;
  }
  const settings = {
    perspectives: options.perspectives,
    maxChain: numberOption(options, 'max-chain', DEFAULTS.maxChain),
    ommVersion: options['omm-version'] ?? ommVersion(),
  };
  const maxRatio = numberOption(options, 'max-ratio', DEFAULTS.maxRatio);
  const { found } = candidates(repo, target, settings);
  if (found.length === 0) return `miss ${target.folder} no-candidate`;
  const best = found[0];
  const total = repo.fileCount(target.commit, target.dirs);
  if (total > 0 && best.files / total > maxRatio) return `miss ${target.folder} too-far ${best.name} ${best.files}/${total}`;
  return `near ${best.folder} ${best.commit} ${best.files}`;
}

function copyDir(source, target) {
  fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
}

export function derive(repo, options) {
  if (!options.from) fail('--from is required');
  const from = path.resolve(options.from);
  const record = readJson(path.join(from, RECORD));
  if (!record || typeof record.commit !== 'string' || !fs.existsSync(path.join(from, OMM))) {
    fail(`${from} has no stored scan`);
  }
  const target = repo.target(options.at);
  const work = `${target.folder}${PARTIAL}${process.pid}`;
  if (fs.existsSync(work)) fail(`${work} already exists`);
  fs.mkdirSync(work, { recursive: true });
  copyDir(path.join(from, OMM), path.join(work, OMM));
  writeJson(path.join(work, DERIVE), {
    from: { folder: path.basename(from), commit: record.commit },
    from_chain_depth: Number.isInteger(record.chain_depth) ? record.chain_depth : 0,
    from_full_scan: record.full_scan || { folder: path.basename(from), commit: record.commit },
    at: target.commit,
    scan_dirs: target.dirs,
    trees: target.trees,
    perspectives: perspectivesIn(work),
    omm_version: record.omm_version || null,
  });
  return `derived ${work} ${record.commit}..${target.commit}`;
}

function topFolders(dirs, files) {
  const tops = new Set();
  for (const file of files) {
    for (const dir of dirs) {
      const prefix = dir === '.' || dir === '' ? '' : `${dir.replace(/\/+$/, '')}/`;
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length).split('/');
      if (rest.length > 1) tops.add(`${prefix}${rest[0]}/`);
    }
  }
  return [...tops].sort();
}

// Whether a path the elements are responsible for covers the top folder (or a part of it).
function covered(top, elements) {
  return elements.some((element) =>
    element.paths.some((p) => {
      const literal = p.split(/[*?{]/)[0];
      return literal.startsWith(top) || (literal.endsWith('/') && top.startsWith(literal));
    }),
  );
}

export function gate(options) {
  if (!options.work) fail('--work is required');
  if (!options.mapping) fail('--mapping is required');
  const work = path.resolve(options.work);
  const info = readJson(path.join(work, DERIVE));
  if (!info) fail(`${work} is not a derived work folder`);
  const mapping = readJson(path.resolve(options.mapping));
  if (!mapping || !Array.isArray(mapping.matched)) fail(`cannot read map-changes output: ${options.mapping}`);
  const elements = readElements(path.join(work, OMM));

  const fresh = topFolders(info.scan_dirs, mapping.unmatched || []).filter((top) => !covered(top, elements));
  if (fresh.length > 0) return `full new-top-folder ${fresh.join(',')}`;

  const removed = (mapping.deletionCandidates || [])
    .map((candidate) => candidate.element)
    .filter((element) => element.split('/').length === 2);
  if (removed.length > 0) return `full top-element-gone ${removed.join(',')}`;

  const maxHitRatio = numberOption(options, 'max-hit-ratio', DEFAULTS.maxHitRatio);
  const hit = new Set(mapping.matched.flatMap((entry) => entry.elements || []));
  const withPaths = elements.filter((element) => element.paths.length > 0);
  if (withPaths.length > 0 && hit.size / withPaths.length > maxHitRatio) {
    return `full too-many-elements ${hit.size}/${withPaths.length}`;
  }
  return 'ok';
}

function remoteName(repo) {
  const url = git(repo.root, ['remote', 'get-url', 'origin'], { allowFail: true });
  if (!url) return null;
  return url.replace(/\/+$/, '').replace(/\.git$/, '').replace(/:/g, '/').split('/').slice(-2).join('/');
}

function baseRecord(repo, { commit, dirs, trees }) {
  const record = {
    repository: remoteName(repo),
    commit,
    scan_dirs: dirs,
    trees,
    fingerprint_rule: 'git rev-parse <commit>:<dir> for each scan_dirs entry equals trees: reuse this .omm/',
  };
  if (dirs.length === 1 && dirs[0] === 'src') record.src_tree = trees.src;
  return record;
}

// Whether the scan stored at `folder` can stand in for `work`: the same trees and every perspective of work.
function keeps(folder, work, trees) {
  return fs.existsSync(folder) && isHit(folder, trees) && covers(folder, perspectivesIn(work));
}

// Perspectives are separate folders, so the ones only the stored scan of the same trees has are carried over.
function carryPerspectives(folder, work, trees) {
  if (!isHit(folder, trees)) return;
  const has = perspectivesIn(work);
  const added = perspectivesIn(folder).filter((name) => !has.includes(name));
  for (const name of added) copyDir(path.join(folder, OMM, name), path.join(work, OMM, name));
  if (added.length === 0) return;
  const record = readJson(path.join(work, RECORD));
  if (record) writeJson(path.join(work, RECORD), { ...record, perspectives: perspectivesIn(work) });
}

// Put `work` (a folder holding .omm/) at `folder`. A stored scan of the same trees that already has
// every perspective of work wins; otherwise work replaces it, and the old folder is restored on failure.
function settle(work, folder, trees) {
  const dropWork = () => fs.rmSync(work, { recursive: true, force: true });
  if (keeps(folder, work, trees)) {
    dropWork();
    return `exists ${folder}`;
  }
  const had = fs.existsSync(folder);
  if (had) carryPerspectives(folder, work, trees);
  const old = `${folder}${PARTIAL}replaced-${process.pid}`;
  if (had) fs.renameSync(folder, old);
  try {
    fs.renameSync(work, folder);
  } catch (error) {
    // Another run published the same trees between the check above and this rename.
    if (keeps(folder, work, trees)) {
      dropWork();
      if (had) fs.rmSync(old, { recursive: true, force: true });
      return `exists ${folder}`;
    }
    if (had && !fs.existsSync(folder)) fs.renameSync(old, folder);
    throw error;
  }
  if (had) fs.rmSync(old, { recursive: true, force: true });
  return `stored ${folder}`;
}

// A rename cannot cross file systems (EXDEV); then copy, and leave the source for the caller to remove.
function moveOrCopy(source, target) {
  try {
    fs.renameSync(source, target);
    return 'moved';
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    copyDir(source, target);
    return 'copied';
  }
}

// A full scan reads the working tree, so it may be stored under a commit only when the scan dirs match it.
function assertTreeMatches(repo, target) {
  const head = repo.commit('HEAD');
  const same = JSON.stringify(sortKeys(repo.trees(head, target.dirs))) === JSON.stringify(sortKeys(target.trees));
  const dirty = git(repo.root, ['status', '--porcelain', '--untracked-files=all', '--', ...repo.pathspec(target.dirs)]);
  if (!same || dirty) {
    fail(`the working tree does not match ${target.commit} in ${target.dirs.join(',')}; scan a checkout of that commit`);
  }
}

export function store(repo, options) {
  if (options.work) return storeDerived(repo, options);
  const target = repo.target(options.at);
  const source = path.join(repo.root, OMM);
  if (git(repo.root, ['ls-files', '--', OMM])) fail(`${OMM}/ is tracked in this repository; leave it as it is`);
  if (!fs.existsSync(source)) fail(`${source} is missing (run the scan first)`);
  assertTreeMatches(repo, target);
  const work = `${target.folder}${PARTIAL}${process.pid}`;
  fs.mkdirSync(work, { recursive: true });
  let how;
  try {
    how = moveOrCopy(source, path.join(work, OMM));
  } catch (error) {
    fs.rmSync(work, { recursive: true, force: true });
    throw error;
  }
  writeJson(path.join(work, RECORD), {
    ...baseRecord(repo, target),
    omm_version: ommVersion(),
    scanned_at: new Date().toISOString(),
    perspectives: list(options.perspectives).length > 0 ? list(options.perspectives) : perspectivesIn(work),
    scanned_for: options.note || 'omm-scan',
    chain_depth: 0,
    full_scan: { folder: path.basename(target.folder), commit: target.commit },
  });
  const line = settle(work, target.folder, target.trees);
  if (how === 'copied') fs.rmSync(source, { recursive: true, force: true });
  return line;
}

function storeDerived(repo, options) {
  const work = path.resolve(options.work);
  const info = readJson(path.join(work, DERIVE));
  if (!info) fail(`${work} is not a derived work folder`);
  if (!options.update) fail('--update is required with --work');
  const update = readJson(options.update === '-' ? 0 : path.resolve(options.update));
  if (!update || typeof update !== 'object') fail(`cannot read --update: ${options.update}`);
  const folder = path.join(repo.cacheRoot(), fingerprintOf(info.trees).slice(0, PREFIX));
  if (!work.startsWith(`${folder}${PARTIAL}`)) fail(`${work} does not belong to ${folder}`);
  fs.rmSync(path.join(work, DERIVE));
  writeJson(path.join(work, RECORD), {
    ...baseRecord(repo, { commit: info.at, dirs: info.scan_dirs, trees: info.trees }),
    omm_version: ommVersion() || info.omm_version,
    scanned_at: new Date().toISOString(),
    perspectives: perspectivesIn(work),
    scanned_for: options.note || 'omm-pr-scan --cache',
    derived_from: info.from,
    update: {
      range: `${info.from.commit}..${info.at}`,
      files: update.files ?? null,
      elements_written: update.elements_written ?? null,
      added: update.added ?? [],
      deleted: update.deleted ?? [],
      unmatched: update.unmatched ?? [],
      kept: update.kept ?? [],
    },
    chain_depth: info.from_chain_depth + 1,
    full_scan: info.from_full_scan,
  });
  return settle(work, folder, info.trees);
}

export function discard(options) {
  if (!options.work) fail('--work is required');
  const work = path.resolve(options.work);
  if (!path.basename(work).includes(PARTIAL)) fail(`${work} is not a work folder`);
  fs.rmSync(work, { recursive: true, force: true });
  return `discarded ${work}`;
}

function check(repo) {
  const left = path.join(repo.root, OMM);
  return fs.existsSync(left) ? { line: `left ${left}`, code: 1 } : { line: 'none', code: 0 };
}

function exportScan(repo, options) {
  const target = repo.target(options.at);
  if (!isHit(target.folder, target.trees)) fail(`no stored ${OMM}/ for this commit in ${target.folder}`);
  const dest = path.join(repo.root, OMM);
  if (fs.existsSync(dest)) {
    if (!git(repo.root, ['ls-files', '--', OMM])) fail(`${dest} is already in the working tree and not tracked`);
    if (git(repo.root, ['status', '--porcelain', '--untracked-files=all', '--ignored', '--', OMM])) {
      fail(`${dest} has local changes, untracked or ignored files`);
    }
  }
  const fresh = `${dest}.export-${process.pid}`;
  const old = `${dest}.replaced-${process.pid}`;
  copyDir(path.join(target.folder, OMM), fresh);
  try {
    if (fs.existsSync(dest)) fs.renameSync(dest, old);
    try {
      fs.renameSync(fresh, dest);
    } catch (error) {
      if (fs.existsSync(old)) fs.renameSync(old, dest);
      throw error;
    }
  } catch (error) {
    fs.rmSync(fresh, { recursive: true, force: true });
    throw error;
  }
  fs.rmSync(old, { recursive: true, force: true });
  return `placed ${dest}`;
}

const VALUE_OPTIONS = new Set([
  'repo', 'cache-dir', 'scan-dirs', 'at', 'perspectives', 'max-ratio', 'max-chain', 'max-hit-ratio',
  'from', 'work', 'mapping', 'update', 'note', 'omm-version',
]);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const name = arg.startsWith('--') ? arg.slice(2) : null;
    if (!name || !VALUE_OPTIONS.has(name)) fail(`unknown argument: ${arg}`);
    if (rest[i + 1] === undefined) fail(`${arg} requires a value`);
    options[name] = rest[i + 1];
    i += 1;
  }
  return { command, options };
}

export function run(argv) {
  const { command, options } = parseArgs(argv);
  switch (command) {
    case 'lookup':
      return { line: lookup(new Repo(options), options), code: 0 };
    case 'derive':
      return { line: derive(new Repo(options), options), code: 0 };
    case 'gate':
      return { line: gate(options), code: 0 };
    case 'store':
      return { line: store(new Repo(options), options), code: 0 };
    case 'discard':
      return { line: discard(options), code: 0 };
    case 'check':
      return check(new Repo(options));
    case 'export':
      return { line: exportScan(new Repo(options), options), code: 0 };
    default:
      return fail(`unknown command: ${command ?? '(none)'}`);
  }
}

function main() {
  try {
    const { line, code } = run(process.argv.slice(2));
    process.stdout.write(`${line}\n`);
    process.exit(code);
  } catch (error) {
    process.stderr.write(`cache: ${error.message}\n`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
