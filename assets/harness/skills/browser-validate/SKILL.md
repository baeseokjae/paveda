---
name: browser-validate
description: "Validate user-facing UI changes in a browser with screenshots, interaction checks, console/network inspection, and responsive passes. Use for web UI changes when a runnable app or static page is available."
argument-hint: "<url-or-file> [task]"
allowed-tools: Bash, Read
---

# /browser-validate - Browser Validation

Use this skill after UI work or when a visual/runtime issue needs proof in a browser.

## Preconditions

1. Identify the page, URL, or local file to validate.
2. Confirm how the app should be launched. Prefer existing repository scripts.
3. If a server is already running, reuse it. If a server must be started, use the repository's package manager and report the URL.

## Validation Passes

Run the narrowest useful pass first, then broaden when risk justifies it:

- load page and check for blank screens or fatal errors
- inspect console errors
- inspect failed network requests
- exercise the requested interaction path
- capture screenshot evidence
- repeat at one mobile and one desktop viewport when layout is relevant
- verify text is visible and does not overlap nearby controls

## Fallback

If browser automation is unavailable, perform a manual checklist using source files and state clearly that browser runtime evidence is missing.

## Output

Return:

- tested URL or file
- viewport coverage
- interactions performed
- console/network issues
- screenshots or artifact paths when available
- pass/fail verdict with remaining risk
