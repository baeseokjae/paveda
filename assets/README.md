# Paveda Assets

This directory is the packaged harness surface.

- `harness/` contains the canonical Paveda core workflow bundle.
- `hosts/` is reserved for host-specific bundle output such as Codex, pi, and Hermes.
- `project-packs/` is reserved for optional consumer-project extensions that should not live in the core harness.

Project-local files are overrides or extensions. Paveda must keep working from the packaged `assets/harness` bundle when a consuming repository has no local harness files.
