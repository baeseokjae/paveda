---
status: accepted
date: 2026-05-21
---

# ADR 0001: TypeScript Package with Node SQLite

## Context

Paveda is a TypeScript package with Node-focused CLI distribution metadata.

The first implementation target is the EventStore. Keeping the EventStore in
the TypeScript package avoids adding a second runtime before the harness API is
stable.

## Decision

Use TypeScript as the implementation language and Node's built-in `node:sqlite`
module for the initial SQLite EventStore.

The package requires Node.js 22 or newer for the EventStore implementation.
External SQLite bindings can be revisited if `node:sqlite` proves too unstable
for downstream users.

## Consequences

- The initial package stays dependency-light.
- The EventStore API can ship as part of the same package as the hook
  runtime, skill loader, router, and Claude Code adapter.
- Runtime details stay inside this package instead of adding a second runtime
  dependency.
- Node 20 is not a valid runtime target for the current package.
