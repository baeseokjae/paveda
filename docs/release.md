# Release Checklist

Use pnpm for every local verification command.

## Preconditions

- Node.js 22 or newer is available.
- `pnpm install --frozen-lockfile` succeeds from a clean checkout.
- The package version in `package.json` is the version being verified.

## Local Gate

```bash
pnpm release:check
```

This runs:

- `pnpm typecheck`
- `pnpm test`
- `pnpm lint`
- `pnpm build`
- `pnpm performance:check`
- `pnpm package:check`

The performance check imports the built library API and runs smoke-level timing
guards for the spec's non-functional targets: EventStore append latency,
minimal hook dispatch overhead, and 10-skill loading cold path.

The package check creates a tarball and verifies required entries:

- `dist/`
- `assets/harness/manifest.json`
- the `assets/harness/manifest.json` instruction file entry
- every `assets/harness/manifest.json` context module entry
- every `assets/harness/manifest.json` skill entry's `SKILL.md`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`
- `package.json`

It also fails if package entries include local docs, env files, npm config,
private key paths, or blocked content markers.

After the archive checks, it extracts the tarball into a temporary directory and
runs the packaged `dist/cli.js` against the packaged harness assets. The smoke
checks cover `help`, packaged `skills`, host matrix `init`, host matrix
`doctor`, host matrix `skills install-bundle --skills do,verify`, host matrix
`skills status`, Claude Code hook settings installation, Codex
`agents/openai.yaml`, Hermes skill directory registration, packaged hook
dispatch with EventStore replay/status, adoption report output with runtime
smoke, EventStore CLI filters/markdown/exit-code/decision-export behavior,
instinct add/list/status behavior, user-store scope selection, project `/do`
router metadata repair, overlapping route CLI access, worktree port resolution,
project check command execution, and the `/do` ambiguity gate. It also checks
invalid CLI inputs that must fail before creating a project EventStore, and
verifies project hook/check execution guards for path
traversal and symlinked executables. Host asset smoke scans the rendered skill,
context, and instruction text for stale host paths, unadapted model tiers, and
unsupported model frontmatter. Custom target smoke also runs installed
`/specify` and `/do` helper scripts against packaged fixtures.

## Tarball Smoke Test

```bash
PAVEDA_PACK_DESTINATION=/private/tmp pnpm package:check
mkdir -p /private/tmp/paveda-pack-smoke
cd /private/tmp/paveda-pack-smoke
pnpm add /private/tmp/paveda-0.1.0.tgz
pnpm exec paveda help
pnpm exec paveda skills
pnpm exec paveda init --host codex --cwd /private/tmp/paveda-pack-smoke-project --write --force
pnpm exec paveda skills install do --cwd /private/tmp/paveda-pack-smoke-project
pnpm exec paveda skills install-bundle --host codex --cwd /private/tmp/paveda-pack-smoke-bundle --skills do,verify --write --force
pnpm exec paveda skills status --host codex --cwd /private/tmp/paveda-pack-smoke-bundle
pnpm exec paveda doctor --host codex --cwd /private/tmp/paveda-pack-smoke-project
pnpm exec paveda route --host codex --cwd /private/tmp/paveda-pack-smoke-project --skill do --ambiguity-score 0.25
pnpm exec paveda runtime-smoke --cwd /private/tmp/paveda-pack-smoke-project --json
pnpm exec paveda adoption-report --host codex --cwd /private/tmp/paveda-pack-smoke-project --runtime-smoke --json
```

The automated package check runs a broader matrix than the manual Codex example:
`harness`, `claude-code`, `codex`, `pi`, and `hermes` are all initialized,
checked with `doctor`, installed through `skills install-bundle --skills
do,verify`, and inspected with `skills status --host`. The Claude Code path also
checks hook settings installation. Each host also runs `adoption-report
--runtime-smoke`. The packaged CLI dispatches `SessionStart`, `PreToolUse`, and
`Stop` hook payloads into a temporary EventStore and verifies `events` replay
plus `status` materialization. It also verifies deterministic worktree port
output and executable project check reporting.

Expected results:

- `paveda help` prints the CLI command list.
- `paveda skills` loads the packaged builtin core harness skills, including
  `/do`, `/specify`, `/plan`, `/verify`, `/debug`, `/commit`, `/pr`, and
  `/surgical-edits`.
- `runtime-smoke` writes a synthetic hook session to EventStore and verifies
  replay plus session summary materialization without running project hooks.
- Overlapping route commands against a fresh project store complete without
  surfacing a transient SQLite lock.
- `--store-scope user` selects the user EventStore when no explicit `--db` is
  provided.
- `instincts add/list/set-status` records operating patterns, filters them, and
  updates their lifecycle status.
- `adoption-report` summarizes host readiness, `/do` route gate behavior, and
  runtime smoke in one result.
- `skills install do` dry-run targets
  `.harness/skills/do/SKILL.md`; with `--write` it copies the full skill
  directory, not only `SKILL.md`.
- `skills enable-router do --write` repairs a project `/do` override without
  changing files during dry-run and preserves an existing ambiguity threshold
  unless a new threshold is explicitly requested.
- `init --host <host> --write` writes the host bundle, context modules,
  instruction file, and returns a doctor result.
- `skills install-bundle --host <host> --skills do,verify --write` installs the
  selected packaged harness skills to the host skill root.
- Custom `--target-root` installs can be verified by passing the same root to
  `doctor`, `skills status`, `route`, and `adoption-report`.
- With `--write`, generated host bundles rewrite skill and context paths to the
  selected host directory while keeping project hook/check extension paths under
  `.harness/hooks` and `.harness/checks`.
- Generated host bundle text does not retain stale host paths after rendering.
- Host model metadata is rendered for the selected host: Claude Code receives
  concrete model names, while Codex, pi, and Hermes do not receive unsupported
  `model:` frontmatter.
- Custom `--target-root` installs keep helper scripts runnable from the installed
  skill root, including `/specify` ambiguity checks and `/do` stagnation
  detectors.
- With `--write`, canonical context modules are copied to the selected host
  directory.
- With `--write`, the canonical instruction file is rendered to the selected
  host instruction path.
- `skills status --host <host>` selects installed host skills from project scope.
- `hook claude-code` records lifecycle events and a completed session summary in
  EventStore.
- `port` prints deterministic shell exports and matching JSON output.
- `check` executes `.harness/checks` scripts, reports stdout/stderr in JSON, and
  returns a failing exit code when a check fails.
- Codex bundle writes also generate `agents/openai.yaml` for each installed skill.
- Hermes bundle writes also register the installed skill root in `.hermes/config.yaml`.
- `doctor --host <host>` reports host bundle, instruction, context modules, `/do` router,
  host model metadata, Codex skill metadata, Hermes skill registration, Claude
  Code hook settings, and project executable-check status without running
  project scripts. Failed checks include recovery commands when a direct repair
  command is available.
- `route --ambiguity-score 0.25` returns `blocked: true` with
  `reason: "blocked:ambiguity"`.

## Adoption Check

For a project that should use the packaged CLI:

```bash
paveda install claude-code --path /path/to/project/.claude/settings.json --write
```

If the project uses reviewed `.harness/hooks`, enable project hook execution
explicitly:

```bash
paveda install claude-code \
  --path /path/to/project/.claude/settings.json \
  --project-hooks \
  --write
```

For local checkout verification, use:

```bash
node /path/to/paveda/dist/cli.js install claude-code \
  --path /path/to/project/.claude/settings.json \
  --cli-path /path/to/paveda/dist/cli.js \
  --write
```
