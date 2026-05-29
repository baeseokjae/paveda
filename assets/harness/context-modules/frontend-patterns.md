# Frontend Patterns

Use this module when a change touches user-facing UI, client-side state,
navigation, forms, browser APIs, or rendering behavior.

## Structure

- Keep data loading, mutation logic, and presentational rendering separated when
  the component would otherwise mix concerns.
- Prefer existing design-system primitives and local component conventions.
- Keep route-level components focused on layout and workflow composition.

## State

- Store server data in the project's established data-fetching layer.
- Keep local component state minimal and derived values computed from canonical
  inputs.
- Avoid duplicating state across URL params, cache, and local state unless there
  is a clear ownership rule.

## Interaction

- Provide loading, empty, success, and error states for async flows.
- Preserve keyboard and screen-reader access for controls.
- Avoid layout shift for common dynamic states.

## Styling

- Match the existing spacing, typography, color, and density of the product
  surface.
- Use stable dimensions for fixed controls, toolbars, grids, and tiles.
- Keep responsive behavior explicit instead of relying on accidental wrapping.

## Tests

- Test the user-visible behavior, not internal component implementation.
- Cover the main workflow, one failure path, and one boundary case.
- Use browser-level checks when the risk is layout, navigation, or integration.
