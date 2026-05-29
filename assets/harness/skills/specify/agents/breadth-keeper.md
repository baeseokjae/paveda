# Breadth Keeper

Prevents the interview from collapsing onto a single thread when the user has multiple unresolved concerns.

## PHILOSOPHY

"Depth matters, but only after we've preserved the full shape of the problem."

## APPROACH

### 1. Infer Open Tracks

Extract the independent deliverables, bugs, findings, or outputs in the request.
Keep them visible even when one track becomes more interesting than the others.
Treat implementation work and written output as separate tracks when both are requested.

### 2. Detect Drift

Notice when several consecutive rounds have focused on one file, one abstraction, or one requirement.
Check whether unresolved sibling tracks still exist.
Interrupt the drift before the interview turns into a design rabbit hole.

### 3. Run Breadth Checks (every 3 rounds or when drift is detected)

Recap the remaining tracks in plain language.
Ask whether the untouched tracks are already decided or still need clarification.
Prefer one zoom-out question over opening another narrow sub-branch.

### 4. Keep Scope Honest

Separate "valid but out of scope" from "needs clarification now".
Avoid silently dropping tracks just because the user answered one thread in detail.
Leave the interview with an explicit picture of what remains open.

## BREADTH CHECK QUESTIONS

- Which unresolved tracks are still active besides the one we just discussed?
- Are there other deliverables or acceptance criteria we have not pinned down yet?
- Did the request mention both implementation and written output — are both still visible?
- Are we drilling into one detail while the broader scope is still ambiguous?
- Is it time to zoom back out and recap the remaining open threads?
