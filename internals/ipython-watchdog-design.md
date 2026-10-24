# Python cell watchdog: implementation plan

This is a design and test plan, not an implemented feature. Minimize new code by extending existing host-side timing, targeted interruption, kernel cleanup, and lazy provisioning.

## Goal and contract

A runaway `ipython` cell must not hold an agent turn indefinitely or leave the kernel permanently occupied. Keep the deadline on the host side, where synchronous or CPU-bound Python cannot block its timer. Limit one cell, not its AgentSession or its parent/child sessions. Preserve ordinary user-abort behavior and existing internal-request timeouts.

Use one execution deadline and the existing one-second interrupt grace period. Defer soft warnings, new UI states, extension policy hooks, effective-policy metadata, and an arbitrary maximum such as 60 minutes. A wall-time limit cannot distinguish legitimate long work from a runaway loop. Use a five-minute default for automatic protection, with an explicit longer per-call override for intentional long work. This deliberately bounds previously unlimited calls; ordinary user-abort and internal-request behavior remain unchanged.

Add an optional `timeout` tool argument in seconds so the agent can explicitly request more time. Validate finite positive values within the host timer's representable range; use the selected default when omitted. Persistent global/project settings are optional follow-up work.

Start the budget immediately before dispatch, after startup, restore, bootstrap, queue wait, and busy-kernel checks. Include request-write time so a stalled write or unresponsive runtime cannot evade the deadline. The protocol has no execution-start event; do not add a wire change just to obtain a more exact timestamp.

At the deadline, latch the timeout outcome and send the existing request-ID-targeted interrupt. If `done` arrives during grace, preserve the kernel. Otherwise kill only this session's kernel through the existing `kill()` cleanup before releasing the execution queue slot. The current abort-grace result releases the caller while retaining the active cell until `done`; it is not proof that the cell stopped.

Return `status: "error"` with `error.ename: "TimeoutError"`, captured output, and an explicit indication of whether the kernel was killed. Add only a small typed result field for that distinction if needed, rather than a new `timed_out` status. A `done` observed before the deadline wins; after the deadline fires, even a successful `done` yields a timeout result. Ensure teardown does not replace it with a generic shutdown rejection. Settle once and clear timers/listeners on every exit. For user-abort/deadline races, the first observed terminal cause wins; ordinary user abort retains its existing interrupt-and-preserve-state semantics.

Let the existing provisioner detect the defunct manager on the next call and perform normal startup with best-effort snapshot restoration. Do not restart eagerly or re-execute the timed-out cell automatically. Report that live state was lost and any restored snapshot may predate the call. Hard kill cannot create a fresh snapshot.

Keep user abort distinct from watchdog timeout. Avoid `AgentSession.abort()` for a cell deadline: parent abort cancels its active child runs. A child kernel interruption or kill does not by itself cancel the child's AgentSession, its parent, or siblings. A cell may already have written files or admitted a subagent before timing out; there is no rollback. Hard kill does not produce a fresh snapshot. Host requests already dispatched may finish after the interrupt; do not duplicate them on retry. Runtime teardown must reap journaled `bash()` process groups. CPU and memory quotas are **not** provided by a wall-time watchdog; OS resource control would be a separate feature.

## Model-visible timeout guidance

The final tool error must remind the agent that the call took a long time and prompt it to assess whether that runtime was intended. Include the applied limit and recovery options in model-visible content, not only structured details. For example:

> This ipython tool call was taking a very long time and exceeded its {timeout}-second limit. Was this long runtime intended? If so, after checking what already completed, you can rerun the operation with a larger `timeout`, or launch the long-running process in the background and return from the cell. Do not blindly repeat work that may already have produced side effects.

Append the accurate kernel outcome:

- If `done` arrived during grace: the request finished after the interrupt and the kernel was preserved. Inspect its output and state before deciding whether anything needs rerunning.
- If grace expired: the kernel was killed and live variables, imports, and tasks were lost. The next call starts a replacement and attempts snapshot restoration where available; do not assume recent state survived.

Background execution is an explicit agent choice for suitable work, never an automatic timeout action. Use existing background process support, such as retaining a `bash()` handle and ending the cell so the agent can inspect or await the process later. Detaching the still-running tool promise leaves the serial kernel occupied. Wrapping synchronous Python in an asyncio task does not make it nonblocking; arbitrary Python must not be automatically detached.

## Files to modify for the recommended implementation

| File | Change |
| --- | --- |
| `packages/coding-agent/src/core/kernel/shared.ts` | Add an optional execution timeout to `ExecuteOptions` and, only if needed, a small result field for timeout kernel loss. Reuse the existing error shape. |
| `packages/coding-agent/src/core/kernel/repl-manager.ts` | Extend existing host-side timing for user cells; interrupt, await `done`, and kill after grace while holding the queue slot. Preserve ordinary user-abort and internal-request behavior. |
| `packages/coding-agent/src/core/tools/ipython.ts` | Add/validate the optional `timeout` argument, pass it only for user cells, and format the guidance and kernel outcome. Reuse lazy replacement; never feed timed-out code into the busy-kernel retry path. |
| `packages/coding-agent/docs/rlm-runtime.md` | Document the default, per-call override, dispatch clock, timeout recovery, background-process alternative, and state/side-effect limitations. |
| `packages/coding-agent/.changes/<watchdog-slug>.md` | Add a one-line user-visible changelog fragment when implementation ships. |

No session lifecycle changes should be necessary. If persistent configuration is included, add only the corresponding settings definition/validation, session-to-tool wiring, settings documentation, and focused settings coverage. Do not expand the initial fix into a general watchdog policy framework.

**Runtime/protocol boundary:** Reuse the existing targeted `interrupt` and `done` protocol; no wire change is required. Runtime source belongs to the separate `prime-agent-runtime` repository, also available as a local checkout at `prime-agent-runtime/` in this workspace. Do not edit the installed kernel venv as the source of truth.

Startup is excluded from the cell deadline. The initial runtime bootstrap currently calls `m.execute()` without an execution timeout, so this plan does not claim to solve every startup stall. Bounding that stage is a separate focused change; retain existing snapshot, restore, and repair limits.

## Test files and required scenarios

| File | Coverage to add or extend |
| --- | --- |
| `packages/coding-agent/test/repl-kernel-abort.test.ts` | Fake-clock deadline, targeted interrupt, `done` during grace, ignored interrupt/hard kill, single settlement, queue exclusion through cleanup, timer cleanup, and unchanged user-abort behavior including races. |
| `packages/coding-agent/test/repl-kernel-execute.test.ts` | Process-boundary timeout of unresponsive execution, captured output, next-cell behavior, and no deadline leakage. Reuse self-contained deterministic runtime fixtures. |
| `packages/coding-agent/test/ipython-provisioner.test.ts` | Argument validation/longer override, model-visible guidance and accurate kernel outcome, lazy replacement/snapshot handling, and no automatic re-execution. |

Verify owned subprocess cleanup using existing fixtures/suites where appropriate. The owner-death watchdog in `repl-kernel-parent-watchdog.test.ts` is separate from the cell deadline. Add a focused faux-provider session regression for child timeout delivery and parent/sibling/previously admitted child survival if manager and provisioner coverage cannot demonstrate that boundary. Never use live providers or credentials.

Additional cases: completion before the deadline, successful completion after it, stalled request writes, disposal, cancellation races, and exclusion of startup/queue wait from the budget. Preserve output attribution and avoid reporting stale snapshots as current. Use fake clocks and concrete events, not sleeps or polling as readiness. Prove regression tests fail with production behavior temporarily reverted or stubbed, and keep added test lines within the repository's source-line budget. Run every modified test file directly; for concurrency/process/timer/ordering changes, repeat the focused suite with multiple shuffle seeds and stop on the first failure. Run `npm run check` and `npm run check:test-policy` when implementation changes code or tests. This documentation-only revision does not require those runs.
