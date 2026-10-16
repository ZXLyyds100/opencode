# OpenCode #56247 — permission diagnostics evidence

This is a logic-only change. The screenshots and recording show **captured local service logs**, not OpenCode's product UI. They are supplementary to the executable reproduction.

## Scope and provenance

- Before: unchanged `dev`, `4e95dacd8170b56567a83006fef88451d3c22739`.
- After: permission fix, `101ec31`, rebased onto `07bbd0f`. The rebase only adds the unrelated WinGet publishing change; the captured permission source hashes remain unchanged.
- `repro.mjs` imports the real `Permission.Service`, SQLite-backed owners, real plugin hook registry and production file logger from the selected checkout.
- HOME/XDG are isolated; sessions and resources are synthetic. There is no live model, product UI, HTTP/TUI end-to-end run, or existing user data. The script explicitly supplies `role=server`.
- Each `.log` includes its permission source SHA-256.

## Observed before / after

| Measurement | Before | After |
| --- | --- | --- |
| Permission diagnostics | 0 | 16 |
| Actual decision sequence | allow, ask, ask, allow, deny, ask, deny, ask | unchanged |
| Private fixture sentinel leakage | none | none |
| Pending requests after close | 0 | 0 |

The fixture covers configured allow/deny, once/always/reject, a saved approval, a real hook overriding allow to deny, and close rejecting a pending request.

The new log uses an index into the effective ruleset instead of logging private resource patterns or the entire ruleset. `rule=-1` means the default rule; `ruleEffect` is the pre-hook result and `effect` is the final result.

## Reproduce

Install the repository's locked dependencies in both checkouts. Use Bun 1.4.2.

```sh
bun repro.mjs /absolute/unchanged-checkout /absolute/new-before-runtime.log > new-before.log
bun repro.mjs /absolute/fixed-checkout /absolute/new-after-runtime.log > new-after.log
```

Use a **fresh runtime log path on each invocation**, since the production logger appends. Serve this directory with a local static server and open `evidence.html` to inspect the unmodified captured outputs.

## Verification

On the final rebased commit:

- `bun run test` in `packages/core`: **6,641 pass, 43 skip, 0 fail**, 6,684 tests across 263 files. Skips are the suite's existing platform/optional checks.
- `bun run script/test.ts test/permission.test.ts --rerun-each 10 --randomize`: **1,140 pass, 0 fail**, seed `4041314570`, run alongside the full suite. JUnit output showed no test over 1 second.
- `bun run check` at the repository root: passed, **35/35 package typechecks**; the final run reused their unchanged valid cache entries.
- Focused permission/saved-approval tests: **116 pass, 0 fail**.
- Regression proof on unchanged source: **9 new diagnostics tests failed** because the diagnostics were absent, then passed with the production fix.
- `git diff --check`: clean.

Local environment: macOS arm64; pinned Bun 1.4.2. The system Bash 3.2 caused seven unrelated shell syntax failures. All seven were separately reproduced on unchanged `dev`. With workspace-local Bash 5.3 first on PATH, the unchanged shell tests and the final full core suite passed. No test skips, gates or product shell behavior were changed.

Review was a fresh full-diff self-review: authorization precedence, hook ordering, saved approval persistence, pending-request cleanup, all reply publication paths, and payload privacy. This is **not an independent reviewer approval**; upstream CI and maintainer review remain separate gates.

Files: `before.png`, `after.png`, `comparison.webm`, original `.log` outputs, and `repro.mjs`. `comparison.webm` records switching between the two captured outputs; it does not portray a live product session.
