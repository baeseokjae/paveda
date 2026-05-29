# Worker Patterns

Use this module when a change touches queues, scheduled jobs, background
processors, event consumers, retries, or long-running tasks.

## Job Design

- Make jobs idempotent when retries are possible.
- Persist progress markers before irreversible side effects when feasible.
- Keep job payloads small and version tolerant.

## Retries

- Classify failures as retryable, permanent, or operator-actionable.
- Use bounded retry policies with backoff for transient dependencies.
- Avoid retry loops that can amplify load during an outage.

## Side Effects

- Guard external calls with timeout, cancellation, and error handling.
- Record enough context to reconcile partial completion.
- Keep duplicate delivery safe for emails, webhooks, billing, and notifications.

## Observability

- Emit structured logs around job start, completion, failure, retry, and skip
  decisions.
- Track counts, latency, and failure categories for recurring workers.
- Include correlation identifiers when the job originates from a user action or
  request.

## Tests

- Cover success, retryable failure, permanent failure, and duplicate delivery.
- Use fake timers or deterministic schedulers for time-based behavior.
- Add integration tests when queue semantics or persistence matter.
