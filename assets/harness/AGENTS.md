# Paveda Harness Instructions

Paveda is the canonical agent harness for this project.

## Operating Rules

- Use the installed Paveda workflow skills for planning, implementation, verification, debugging, commits, and pull requests.
- Treat project-local hooks, checks, and skills as overrides or extensions only when they are present.
- Keep changes scoped to the user's request and the active repository state.
- Start vague work with `/specify`, implementation planning with `/plan`, approved execution with `/do`, root-cause work with `/debug`, validation with `/verify`, and git handoff with `/commit` then `/pr`.
- For failures, prove the root cause before changing code.
- Prefer test-first or regression-test coverage when behavior changes.
- Prefer `pnpm` for Node.js projects when package manager metadata points to `pnpm`.
- Run the narrowest meaningful verification first, then broaden verification before handoff.
- Do not expose credentials, private keys, tokens, local absolute paths, or unreviewed environment files.
- Do not enable project hook execution unless the project has explicitly opted in.

## Skill Roots

- Workflow skills: `.harness/skills`
- Project hooks: `.harness/hooks`
- Project checks: `.harness/checks`
- Context modules: `.harness/context-modules`
- Harness instructions: `.harness/AGENTS.md`
- Optional skills: install with `--include-optional` or explicit `--skills`

## Expected Flow

- Vague feature requests: use `/specify`, then `/plan` or `/do`.
- Implementation work: use `/do` and keep the plan, tests, and code aligned.
- Debugging work: use `/debug` to prove root cause before changing code.
- Verification work: use `/verify` after code changes.
- Git handoff work: use `/commit` and `/pr` only when the user asks.
