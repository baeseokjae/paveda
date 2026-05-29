# Paveda Host Adoption Checklist

Use this checklist when applying Paveda to a project for any supported host.
Paveda ships a canonical harness bundle. Host directories such as `.claude`,
`.codex`, `.pi`, and `.hermes` are generated host surfaces; project-owned
`.harness/hooks` and `.harness/checks` are extension points.

Commands are safe by default. Inspection and install commands run as dry-runs
unless `--write` is passed.

## 1. Build Paveda

```bash
pnpm build
```

## 2. Choose A Host

Supported host targets:

| Host | Skill root | Context modules | Instruction file | Extra output |
|---|---|---|---|---|
| `harness` | `.harness/skills` | `.harness/context-modules` | `.harness/AGENTS.md` | none |
| `claude-code` | `.claude/skills` | `.claude/context-modules` | `.claude/CLAUDE.md` | `.claude/settings.json` hook config through `init` |
| `codex` | `.codex/skills` | `.codex/context-modules` | `AGENTS.md` | `agents/openai.yaml` per skill |
| `pi` | `.pi/skills` | `.pi/context-modules` | `.pi/AGENTS.md` | none |
| `hermes` | `.hermes/skills` | `.hermes/context-modules` | `.hermes/AGENTS.md` | `.hermes/config.yaml` skill directory registration |

The canonical harness keeps project hook/check extension paths under
`.harness/hooks` and `.harness/checks` even when skills are rendered into a host
directory.

## 3. Inspect Current Skill Resolution

Before writing files, inspect the project-level skill state:

```bash
node dist/cli.js skills status --cwd /path/to/project
```

Check:

- `selected.scope` shows which skill wins by priority.
- `shadowed` shows lower-priority candidates.
- `issues` should be empty before adoption is considered clean.
- `/do` should eventually report `routerEnabled: true`.

If a host bundle already exists, inspect that host directly:

```bash
node dist/cli.js skills status --host codex --cwd /path/to/project
node dist/cli.js doctor --host codex --cwd /path/to/project --json
```

## 4. Bootstrap The Host Bundle

Use `init` for the normal adoption path. It installs the host skill bundle,
copies context modules, renders the host instruction file, and runs `doctor`.
For `claude-code`, it also merges hook settings.
The JSON result includes `nextCommands[]` for the write step after dry-run and
for the post-write verification flow. When run through the CLI, follow-up and
recovery commands use the current CLI path.

Dry-run first:

```bash
node dist/cli.js init --host codex --cwd /path/to/project
```

Write when the preview is correct:

```bash
node dist/cli.js init --host codex --cwd /path/to/project --write
```

When run through the CLI, Claude Code hook settings use the current CLI path by
default. Use `--cli-path` when a project should pin a different CLI path:

```bash
node dist/cli.js init --host claude-code \
  --cwd /path/to/project \
  --cli-path /path/to/paveda/dist/cli.js \
  --session-start-context off \
  --write
```

Use `--session-start-context off` when the project should keep SessionStart
payloads minimal and skip git context injection.

Use `--skills do,verify` if the host should receive only selected skills:

```bash
node dist/cli.js init --host pi --cwd /path/to/project --skills do,verify --write
```

## 5. Verify The Host Surface

Run host-scoped checks after writing:

```bash
node dist/cli.js doctor --host codex --cwd /path/to/project
node dist/cli.js skills status --host codex --cwd /path/to/project
node dist/cli.js route --host codex --cwd /path/to/project --skill do
node dist/cli.js route --host codex --cwd /path/to/project --skill do --ambiguity-score 0.25
node dist/cli.js runtime-smoke --cwd /path/to/project --json
node dist/cli.js adoption-report --host codex --cwd /path/to/project --runtime-smoke --json
```

Expected:

- `doctor` reports the host skill root, instruction file, context modules, and
  host model metadata, and `/do` router metadata as passing.
- `skills status --host <host>` selects installed host skills from project scope.
- `/do` has `routerEnabled: true`.
- A higher ambiguity score than the selected `/do` threshold returns
  `blocked: true` with `reason: "blocked:ambiguity"`.
- Codex installs include `agents/openai.yaml`.
- Hermes installs include the installed skill root under `.hermes/config.yaml`
  `skills.external_dirs`.
- Claude Code installs include hook settings for `SessionStart`, `PreToolUse`,
  `PostToolUse`, and `Stop`.
- `runtime-smoke` records a synthetic hook session in EventStore and verifies
  replay plus completed session summary materialization.
- `adoption-report` returns the host surface checks, `/do` route gate, and
  optional runtime smoke in one result. When doctor checks fail, the report
  includes each failed doctor check name, message, and path.

`doctor` is read-only. It inspects host bundle files, context modules, `/do`
router metadata, host model metadata, Codex skill discovery metadata, Claude
Code hook settings, and project hook/check executable counts without running
project-owned scripts. Failed checks include `recovery.command` when Paveda can
offer a direct repair command.
`runtime-smoke` writes only Paveda synthetic runtime events and does not execute
project-owned `.harness/hooks`.
`adoption-report` is read-only unless `--runtime-smoke` is present.

## 6. Install A Host Bundle Directly

Use `skills install-bundle` when you want the host bundle install step without
the full `init` workflow:

```bash
node dist/cli.js skills install-bundle --host codex --cwd /path/to/project
node dist/cli.js skills install-bundle --host codex --cwd /path/to/project --write
node dist/cli.js skills install-bundle --host codex --cwd /path/to/project --skills do,verify --write
```

When writing a host bundle, Paveda rewrites canonical `.harness` skill and
context paths to the target host directory. Compatibility paths under `.claude`
are also rewritten when encountered. Project hook and check extension paths stay
under `.harness/hooks` and `.harness/checks`.

If `--target-root` is provided, relative paths are resolved from `--cwd`.
Generated skill path references use the resolved install location while context
modules and instruction files remain in the host default project surface.
Pass the same `--target-root` to `doctor`, `skills status`, `route`, and
`adoption-report` when verifying a custom install location:

```bash
node dist/cli.js doctor --host codex --cwd /path/to/project --target-root vendor/codex-skills
node dist/cli.js skills status --host codex --cwd /path/to/project --target-root vendor/codex-skills
node dist/cli.js route --host codex --cwd /path/to/project --target-root vendor/codex-skills --skill do --ambiguity-score 0.25
node dist/cli.js adoption-report --host codex --cwd /path/to/project --target-root vendor/codex-skills --json
```

For `hermes`, the direct bundle install also creates or updates
`.hermes/config.yaml` so the installed skill directory is discoverable through
`skills.external_dirs`.

For `claude-code`, `skills install-bundle` does not install hook settings by
itself. Use `init --host claude-code --write` for full adoption, or run the hook
installer separately:

```bash
node dist/cli.js install claude-code \
  --path /path/to/project/.claude/settings.json \
  --cli-path /path/to/paveda/dist/cli.js \
  --session-start-context off \
  --write
```

## 7. Customize A Single Builtin Skill

Use `skills install` when you want a managed copy of one manifest-declared
Paveda builtin skill under `.harness/skills/` for inspection or local
customization. Without this step, Paveda still loads its packaged builtin bundle.

Dry-run:

```bash
node dist/cli.js skills install do --cwd /path/to/project
```

Write:

```bash
node dist/cli.js skills install do --cwd /path/to/project --write
```

`--write` copies the full skill directory, including `agents/`, `references/`,
`personas/`, `scripts/`, `templates/`, and eval fixtures when they exist.

## 8. Fix Existing `/do` Overrides

If a project already has a higher-priority `/do` skill, `skills status` may show:

```text
router-enabled-skill-shadowed
```

That means the selected project skill is shadowing a router-enabled Paveda
candidate. If the project override should remain, add router metadata to the
selected skill:

```bash
node dist/cli.js skills enable-router do --cwd /path/to/project
node dist/cli.js skills enable-router do --cwd /path/to/project --write
```

This updates the selected `do/SKILL.md` frontmatter with:

```yaml
router: enabled
ambiguity-required: 0.2
```

If the packaged Paveda harness should be authoritative, remove or relocate the
project override instead.

## 9. Move Project Hooks

Project-owned hooks should live under `.harness/hooks/` when they are not generic
Paveda behavior. Only move and enable hooks from repositories you trust; Paveda
executes matching executable files with the current user's permissions after
`PAVEDA_PROJECT_HOOKS=on` or `--project-hooks` is configured.

Rules:

- Paveda runs executable files in matching hook directories:
  - `.harness/hooks/*.sh` for all events.
  - `.harness/hooks/<HookEvent>/*.sh` for a Claude Code event such as `PostToolUse` or `Stop`.
  - `.harness/hooks/<HookEvent>/<ToolName>/*.sh` for a tool-specific event such as `PostToolUse/Edit`.
- `<HookEvent>` and `<ToolName>` directory names must be single path segments
  using only ASCII letters, numbers, `_`, and `-`.
- The Claude Code hook payload is passed to each hook on stdin.
- Hooks should self-filter by `hook_event_name` and `tool_name`.
- If a hook prints JSON with `decision` or `hookSpecificOutput`, Paveda forwards that response to Claude Code.
- Non-executable files, symlinks, and subdirectories are ignored.

Example:

```bash
mkdir -p .harness/hooks/PostToolUse
git mv .claude/hooks/project-policy-check.sh .harness/hooks/PostToolUse/project-policy-check.sh
chmod +x .harness/hooks/PostToolUse/project-policy-check.sh
```

Project hook execution remains off unless explicitly enabled:

```bash
node dist/cli.js install claude-code \
  --path /path/to/project/.claude/settings.json \
  --project-hooks \
  --write
```

## 10. Move Project Checks

Project validation scripts that should run on demand should live under
`.harness/checks/`.

Paveda runs executable files in `.harness/checks/`:

```bash
paveda check --cwd /path/to/project
paveda check playwright-setup --cwd /path/to/project
paveda check playwright-setup --cwd /path/to/project --json
```

Use checks for acceptance gates that are not lifecycle hooks, such as browser or
MCP setup verification.
