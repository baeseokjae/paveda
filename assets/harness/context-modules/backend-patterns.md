# Backend Patterns

Use this module when a change touches server-side request handling, durable data,
authorization, external integrations, or backend orchestration.

## Boundaries

- Keep transport adapters thin. Parse input, call an application service, and
  map the result into the transport response.
- Keep business rules outside route handlers and CLI entrypoints.
- Prefer explicit dependency injection for services that perform I/O.

## Data

- Treat schema changes as behavioral changes. Pair them with migration,
  rollback, and compatibility notes.
- Use transactions around multi-step writes that must succeed or fail together.
- Keep read models and write models separate when that makes validation or
  authorization clearer.

## Validation

- Validate untrusted input before it reaches business logic.
- Normalize domain values once at the boundary and pass typed values inward.
- Fail closed for authorization and tenancy checks.

## Errors

- Return stable error codes or categories for expected failures.
- Preserve useful diagnostic detail in logs without exposing credentials, tokens,
  private keys, or user secrets.
- Make retry behavior explicit for transient failures.

## Tests

- Cover the smallest unit that owns the rule.
- Add integration coverage when persistence, auth, or external contracts are
  involved.
- Include at least one negative case for validation and authorization paths.
