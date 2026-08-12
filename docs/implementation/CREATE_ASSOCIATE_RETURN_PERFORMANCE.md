# Create & Associate return performance follow-up

Status: `CA20260811R2-Lower` completed successfully. The optimization is released after offline validation; no additional live Pack transfer was started.

## Release state (2026-08-11)

- Shell `0.4.15` is active from the immutable `releases/0.4.15` root.
- Create & Associate `0.2.110 / sequence 112` is active at activation generation 87. Package digest: `sha256:715359b802eab59bae2b3b8f5c13b2b132f4a01ba0a0666af7f8b6eee8c82358`.
- The signed Operation handoff from `0.2.109` to `0.2.110` is finalized with no error.
- Connector Next server `0.1.8` is active and healthy. Agent `0.1.21 / sequence 22 / generation 18` is active after online offer `ocn3.offer.623c63f2-3be3-4561-bfb3-7d619357c5d6` succeeded.
- Agent package digest: `sha256:da61b33445e0fb4dc1f23662e4943a80a7d3fa1cbfefa4eb979eb72a9592ce9e`.
- The release performs no new Pack Return. Higher 126/126 and Lower 122/122 remain the business acceptance evidence; throughput/reconnect changes are covered offline and are not mislabeled as a second live performance canary.

## Observed baseline (2026-08-11)

- Run: `dae96896-081f-4ae0-9de1-a0bf328986ab`
- Frozen plan: 122 targets (5 elements, 5 GRA, 3 element relations, 33 Risk-Control relations, 76 settings).
- Sustained throughput during the live TEST return was usually 2–5 completed targets per 45–50 seconds.
- The execution persisted exact command and readback state, so an interrupted driver resumed without replaying verified mutations.
- A long renderer action exceeded the external 30-minute driver lifetime. The Core safely moved the Run to explicit continuation, but the Surface did not immediately render that transition and appeared stuck.
- The Pack/Connector session also disconnected during the live transfer. Reconnection preserved the same Run and verified commands, but added another pause before continuation.
- Progress was visible in `feature_commands` and managed revision tables before the Surface refreshed.

### Connection-loss incident record

- The user explicitly observed the connection dropping while the Return batch was still being transmitted; this is tracked separately from the slow-throughput/UI-stall symptom.
- The affected latest batch was Run `dae96896-081f-4ae0-9de1-a0bf328986ab`. Its durable terminal state is `succeeded`: 122 commands total, 120 `readback_verified` and 2 `closed_not_applied`. No replacement mutation request or blind replay was used to obtain that terminal state.
- The earlier Higher batch, Run `27114089-ad78-4b00-87c2-ed58ba18807e`, is also durably `succeeded` with 126/126 commands `readback_verified`.
- This incident is evidence that reconnect/reattachment latency and Surface refresh must be optimized together; it is not evidence that the reconnect path has passed a dedicated live fault test.
- Live-transfer testing is now frozen by user instruction. After these two completed batches, no additional Return or Pack mutation test may be started until the architecture review below is complete and the user explicitly authorizes a new live run.

## Causes to verify and remove

1. Each target waits for mutation completion and authoritative readback before enough additional work is admitted; effective concurrency remained below the intended queue capacity for much of the run.
2. Settings and Risk-Control targets are scheduled as many small commands, each paying server claim, Connector dispatch, Pack request and readback latency.
3. Surface progress is returned at action completion instead of receiving durable incremental progress updates while the action is running.
4. Renderer/external action lifetime is shorter than a full large-plan execution, forcing a safe but unnecessary continuation round trip.
5. Repeated authority/preflight work inside a frozen, identity-stable batch must be measured and deduplicated without weakening per-mutation readback.
6. Connection-loss detection, reconnect, durable job reattachment and Surface state refresh are not yet one continuous recovery path.

## Architecture assessment and implemented direction

The v4 bounded dependency scheduler is useful only as a scheduling reference. Connector Next has a different durable path (Core request -> server SQLite job -> exact Agent claim -> Operation receipt/readback), so v4's in-process parallel calls are not copied directly.

- Feature scheduling remains dependency-aware and bounded at eight lanes. Same-GRA Risk Factors, generated-Risk classification and Risk-Control writes remain serial where the signed API has no independent concurrency token.
- Connector Next Agent claims one durable batch with a maximum of eight jobs instead of issuing one polling request per lane. The server wakes an idle long-poll immediately when a committed job arrives; the Agent does not add a fixed idle sleep after an empty poll.
- Shell/Core waits for a durable terminal job using a server-side long-poll and reattaches to the same job ID after transient HTTP 502/503/504 or connection errors. It never creates a replacement mutation request merely because a wait connection was lost.
- Pack Operation invocation no longer performs two extra full Pack hierarchy/status reads around every signed Operation. The Operation's exact Connector binding remains the authority boundary. A narrow pre-effect reconnect is permitted only for explicit authorization/target-unavailable errors (or retryable read-only calls); response-lost mutations are never replayed.
- A GRA's generated Risk/Control catalog is resolved once per immutable relation batch. Every mutation still performs signed action-time identity validation and authoritative readback, so eliminating identical full-catalog reads removes latency rather than evidence.

The live incident is part of the release record: the Pack/Connector session disconnected during the Lower return. Durable command state survived and the same Run resumed after a read-only refresh. This is not treated as a successful reconnect acceptance test; the new reconnect path is covered offline until a future live test is explicitly authorized.

## Required acceptance after the canary

- Keep exact idempotency, mutation uncertainty and authoritative readback semantics.
- Use a bounded worker pool that actually sustains the configured concurrency while respecting dependencies per row/target.
- Batch or pipeline only independent Pack operations; never report success before the durable receipt and required readback are committed.
- Stream persisted progress to the Surface so counts advance without waiting for the whole action call.
- Let a return continue in the background independently of a renderer/CDP caller lifetime; reopening must attach to the same Run.
- Measure a representative 122-target TEST plan before and after, and record elapsed time, effective concurrency, retries, uncertain count and final verified counts.
- Review the v4 parallel execution approach as design input, then adapt only the parts that fit Connector Next's current durable job/outbox, dependency and readback architecture. Do not copy v4 concurrency assumptions directly.
- After this canary completes, do not start another live transfer test until the performance/reconnect design has been reviewed and implemented.
