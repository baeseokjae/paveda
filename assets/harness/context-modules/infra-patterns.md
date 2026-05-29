# Infrastructure Patterns

Use this module when a change touches configuration, deployment, CI, runtime
processes, secrets handling, containers, networking, or operational scripts.

## Configuration

- Keep environment-specific values outside committed defaults.
- Validate required variables early with clear failure messages.
- Document any new operator action required to run or deploy the project.

## Secrets

- Never commit credentials, tokens, private keys, generated env files, or local
  machine paths.
- Prefer runtime secret injection over checked-in config.
- Keep logs free of secret values and long-lived credentials.

## Deployment

- Make deploy steps repeatable and idempotent.
- Separate build-time checks from runtime health checks.
- Include rollback notes for changes that alter data, networking, or process
  topology.

## CI

- Keep checks deterministic and scoped to the changed surface.
- Cache dependencies through the package manager's supported mechanism.
- Fail with actionable output when required tools or config are missing.

## Tests

- Smoke-test the generated artifact or runtime entrypoint when possible.
- Validate scripts in the same shell mode they use in automation.
- Add config regression tests for parsing and merge behavior.
