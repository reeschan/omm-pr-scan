# omm-pr-scan

English | [日本語](README.ja.md)

A [Claude Code](https://claude.com/claude-code) skill that updates the [oh-my-mermaid](https://github.com/oh-my-mermaid/oh-my-mermaid) (`omm`) architecture docs in `.omm/` **for the files a pull request changed, and nothing else**.

`/omm-scan`, the skill that ships with omm, reads the whole codebase every time. omm-pr-scan maps each changed file to the `.omm/` elements that own it, updates only those elements, and shows the diagrams before and after, so the architecture change of a PR can be read from the diagram diff.

> The skill text (`SKILL.md`) and its spec are written in Japanese. Claude reads it fine either way.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/architecture-dark.svg">
  <img src="assets/architecture-light.svg" alt="omm-pr-scan architecture. The developer runs /omm-pr-scan in Claude Code on their machine and gets one approval question and a report back. Claude Code reads the PR base from GitHub with gh pr view and git fetch, takes git diff --name-status from the Git repository, and passes the changed files to map-changes.mjs. map-changes.mjs reads the diagram labels in the committed .omm/ and returns JSON with the matched, renamed and unmatched files and the deletion candidates. Claude Code then updates only the matched elements through the omm CLI, which writes .omm/ in the working tree only.">
</picture>

The diagram source is `assets/architecture.d2` (rendered with [D2](https://d2lang.com)).

## How it works

1. **Check the prerequisites.** `omm` is installed, you are in a Git repository, and `.omm/` is committed at `HEAD`. Otherwise it stops and tells you what to do.
2. **Decide the range.** `A..B` or `A...B` if given. Otherwise the open PR's base branch (`gh pr view`), then `develop`, then `main`, preferring `origin/<base>` so a stale local branch does not widen the range.
3. **Map changed files to elements.** `scripts/map-changes.mjs` (Node standard library only) reads every `diagram.mmd` in `.omm/`, takes the paths written in node labels (`name\nsrc/path/`), and matches each changed file to the element with the longest matching path, per perspective. Tests, docs, lock files and static assets are excluded by default.
4. **Ask once.** Files that match no element and elements whose files were all deleted become proposals. They are listed with numbers and confirmed in a single question. Nothing is added or deleted without your approval.
5. **Update.** Matched elements get their descriptions fixed against the changed code. Each `diagram.mmd` is written at most once per run, so `omm diff` still compares against the diagram before the run.
6. **Validate and report.** `omm validate <element>` for every diagram written, then a report in the conversation: the range, the elements updated, each diagram before and after, `omm diff`, unmatched files, and a short summary you can paste into the PR description.

It never stages, commits or pushes, never uses omm's cloud commands, never starts `omm view`, and never comments on a PR. The changes stay in your working tree.

## Requirements

- Claude Code
- [oh-my-mermaid](https://github.com/oh-my-mermaid/oh-my-mermaid) CLI 0.2.0 (`npm install -g oh-my-mermaid`)
- Node.js 18 or later, Git
- `gh` (optional, to read the PR's base branch)
- An `.omm/` already generated with `/omm-scan` and **committed**. omm-pr-scan updates an existing `.omm/`; it does not create perspectives.

## Install

Copy the skill folder into your Claude Code skills:

```bash
git clone https://github.com/reeschan/omm-pr-scan.git
cp -r omm-pr-scan/skills/omm-pr-scan ~/.claude/skills/
```

## Usage

```text
/omm-pr-scan                          # the open PR's base (or develop / main) .. HEAD
/omm-pr-scan main..HEAD               # an explicit range
/omm-pr-scan v1.2.0...feature/x       # from the merge base of the two
/omm-pr-scan --working                # include uncommitted changes
/omm-pr-scan --exclude 'src/generated/**'
```

## Limitations

- Mapping is by file path. A perspective split by behavior (for example a state-transition view) may describe a file that none of its labels names; such elements are not updated.
- omm 0.2.0 counts edge labels that contain spaces as nodes, both in the node-count warning of `omm validate` and in `omm diff`. The skill reports those warnings without "fixing" them.

## Development

```bash
node --test skills/omm-pr-scan/scripts/map-changes.test.mjs
```

The design spec is `skills/omm-pr-scan/SPEC.md`.

## License

[MIT](LICENSE)
