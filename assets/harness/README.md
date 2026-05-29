# Paveda Core Harness

The core harness defines Paveda's default workflow skills.

Included instruction file:

- `AGENTS.md`

Included context modules:

- `context-modules/backend-patterns.md`
- `context-modules/frontend-patterns.md`
- `context-modules/worker-patterns.md`
- `context-modules/infra-patterns.md`

Included skills:

- `/do`
- `/specify`
- `/plan`
- `/verify`
- `/debug`
- `/commit`
- `/pr`
- `/surgical-edits`

Optional portable skills:

- `/docs-writer`
- `/review`
- `/browser-validate`
- `/dead-code`

Installers adapt skills, context modules, and instruction files into host-specific locations.
Project-owned hooks and checks remain under `.harness/hooks` and `.harness/checks`,
which are the runtime extension points Paveda executes.
