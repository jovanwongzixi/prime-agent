# Internal changelog

## 2026-10-24 — IPython cell watchdog

- Added a host-side default timeout of 300 seconds (5 minutes), with an optional per-call `timeout` argument in seconds.
- Added targeted interruption followed by a one-second grace period and a session-scoped kernel kill if the cell remains active.
- Preserved captured output and returned `TimeoutError` with the kernel outcome, without automatically re-executing timed-out code.
- Reused lazy kernel provisioning and best-effort snapshot restoration after a hard kill; retained existing user-abort and internal-request behavior.
- Added model-visible recovery guidance asking whether the long runtime was intended and suggesting a longer timeout or an explicit background process after checking side effects.
- Updated the guidance to state both the applied limit and the default timeout of 300 seconds (5 minutes), including when the caller supplies an override.
- Fixed expanded Python cells hiding timeout guidance behind a shortened error summary; retained compact summaries.
- Verified live interruption, hard-kill recovery, longer overrides, model receipt of the guidance, and rendering at multiple terminal widths; added regression coverage with mutation checks.
- Kept implementation changes in Prime Agent's TypeScript core; left the `prime-agent-runtime` Python library unchanged.

Design: [IPython watchdog implementation plan](ipython-watchdog-design.md).

## 2026-10-25 — Configurable default timeout

- Added `ipythonTimeoutSeconds` to global and project `settings.json`, with project settings taking precedence and 300 seconds retained when omitted or invalid.
- Kept explicit per-call `timeout` values authoritative; the setting changes the default rather than imposing a maximum.
- Updated the tool schema and recovery guidance to report the configured default.
- Added coverage for settings precedence, validation, reload, and configured defaults with per-call overrides.

### Explicit timeout display

- Added `timeout Ns` to collapsed and expanded Python cell headers only when the tool-call arguments explicitly supply a finite positive timeout.
- Kept calls using the configured default unlabeled and refreshed the label when streamed arguments change or saved calls are replayed.
