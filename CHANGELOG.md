# Changelog

## 0.1.0 - 2026-05-22

Initial release candidate for Paveda as a portable agent harness.

### Added

- SQLite EventStore with lifecycle events, session summaries, router decisions,
  instincts, schema migration tracking, and time-filtered query commands.
- Claude Code hook adapter and installer for `SessionStart`, `PreToolUse`,
  `PostToolUse`, and `Stop`.
- Built-in harness hooks for session context, cost guard, destructive command
  blocking, dependency blast checks, tooling enforcement, worktree port
  resolution, and test process cleanup.
- Project-owned hook and check runners under `.harness/hooks` and
  `.harness/checks`.
- SKILL.md loader with project, user, and packaged builtin skill priority.
- Packaged builtin core harness skills: `/do`, `/specify`, `/plan`, `/verify`,
  `/debug`, `/commit`, `/pr`, and `/surgical-edits`.
- Host skill bundle installer for `.harness`, `.claude`, `.codex`, `.pi`, and
  `.hermes` skill roots, including Codex skill discovery metadata.
- Runtime smoke and adoption report commands for verifying host readiness and
  EventStore write/replay behavior.
- PAL Router seed for `/do`, including ambiguity gate blocking and escalation
  signals for tool retries, verify failures, ambiguity, and elapsed time.
- CLI commands for status, event replay, router traces, decision export, hook
  dispatch, hook install, skill management, host initialization, adoption
  diagnostics, port resolution, and project checks.
- Packaged CLI smoke coverage for repairing project `/do` router metadata.
- Release gate with typecheck, tests, lint, build, performance smoke, package
  packing, CI, and tarball smoke coverage for packaged CLI flows.

### Changed

- Standardized project storage paths on `.harness/*` for EventStore files,
  hooks, checks, and managed harness assets.
- Made `strict` hook profile more sensitive by default and added verbose
  EventStore dispatch metadata.
- Added an EventStore busy timeout so overlapping CLI commands do not fail on
  transient SQLite locks.
- Require explicit opt-in before executing project-owned `.harness/hooks`.
- Refuse symlinked EventStore paths before opening SQLite.

### Notes

- Runtime dependencies are intentionally empty; SQLite uses Node.js 22's
  built-in `node:sqlite`.
