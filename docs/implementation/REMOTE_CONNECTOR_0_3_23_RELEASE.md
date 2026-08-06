# Remote Connector 0.3.23 release

Date: 2026-08-06
Worker: `0.3.23 / sequence 26`
Supervisor: `0.1.1`
Status: packaged, locally verified, and published to the v5 stable channel; company-workstation canary is pending because the previously deployed Connector was already offline before publication.

## Incident evidence

- Deployed `0.3.22` last reported diagnostics at `2026-08-06T07:43:39Z`.
- Its Bridge connection then closed abnormally with WebSocket code `1006` at `2026-08-06T07:43:44Z`.
- An earlier Supervisor diagnostic recorded `worker_exited` with Windows exit code `1073807364`.
- These observations establish an abrupt process/transport loss, but do not by themselves prove its originating OS fault. A real workstation canary remains required.

## Stability changes

- Supervisor ownership now uses a tokenized lock plus a separately refreshed heartbeat. Start only reports success after the Supervisor PID/token, Worker PID/version, and both fresh heartbeats agree.
- Stale legacy locks no longer treat an arbitrary live reused PID as the old Supervisor. Unreadable or operationally uncertain state remains fail-closed.
- Supervisor log writes are best-effort, so an `EPERM`, sharing violation, or full disk cannot terminate supervision.
- Worker spawn errors clear the child reference and enter bounded exponential restart backoff instead of leaving a permanently non-null failed child.
- Supervisor `0.1.1` passes its PID/token lease to the Worker. A Worker whose owning Supervisor identity remains absent past the lease exits only when `activeOperations === 0`, allowing safe recovery without truncating a long mutation; active commands continue to converge through their existing deadline/Gate.
- After the lost-owner lease and safe operation drain, the Worker closes its Connector session, publishes a short-lived owner-token/PID recovery handoff, and starts the persistent bootstrap Supervisor hidden and detached. The new Supervisor holds the recovery gate and takes ownership only after the specifically identified Worker has exited; an unverifiable or timed-out orphan remains fail-closed.
- The managed login launcher no longer runs `start /min` against `supervisor.cjs`. It starts the current verified version's `cli.cjs start` through hidden `Start-Process`, so ordinary startup uses the same runtime health verification and detached Supervisor launch as manual Start.
- CLI Start tolerates up to 10 seconds of scheduling/file-write jitter in otherwise identity-matched live heartbeats and waits up to 75 seconds for verified recovery, covering the 35-second owner lease without declaring a healthy instance dead after a single five-second delay.
- Bootstrap replacement is atomic and marker-backed. A verified `0.3.23` Worker performs a one-time, best-effort migration of `bootstrap/supervisor.cjs` to `0.1.1` without stopping its currently loaded `0.1.0` parent or current session. The next managed or old portable Start uses the upgraded persistent bootstrap.
- Bootstrap migration success/failure is written to `logs/bootstrap-migration.jsonl` and exposed in runtime status. Migration failure never terminates the active Connector and is retried by the next Worker start.

## Transition manifest rule

The signed `0.3.23` update manifest must keep `minimumSupervisorVersion: 0.1.0`. This is deliberate: deployed Supervisor `0.1.0` must be allowed to verify, download, and activate Worker `0.3.23`; that verified Worker then migrates the persistent bootstrap to `0.1.1`.

Setting the transition manifest minimum to `0.1.1` would deadlock the rollout because deployed `0.1.0` would reject the release before downloading the code that performs the migration. Later releases may raise the minimum only after `0.1.1` migration coverage is established.

The package identity records Supervisor `0.1.1`. The transition manifest remains compatible with deployed Supervisor `0.1.0` while the versioned Worker performs the one-time bootstrap migration.

## Verification completed

- Scoped `cli` / `supervisor` / `worker` esbuild and release-script syntax checks passed.
- The signed `0.3.23 / sequence 26` portable archive passed manifest, identity, size, digest, and isolated-install verification.
- A real temp-root process run force-terminated the Worker; the same Supervisor restarted a different Worker PID.
- The same run then force-terminated only the Supervisor; the detached Worker remained alive, waited out the owner lease, published the verified handoff, and produced a different Supervisor and Worker PID without concurrent takeover.
- A separate transition run started the signed `0.3.23` Worker under the packaged `0.3.22` Supervisor `0.1.0`, observed the bootstrap migrate to `0.1.1` without stopping that active session, stopped it cleanly, and then restarted successfully under Supervisor `0.1.1`.
- Smoke paths now carry an explicit isolated startup-entry override. Packaging no longer writes a temporary test launcher into the real Windows Startup folder.

No unit-test suite was run. These checks execute the packaged Windows processes and their real lifecycle paths.

## Remaining online boundary

A company-workstation canary is still required to prove Bridge reconnection and long-running Pack/browser behavior under that machine's corporate policies. No administrator-only Windows service or scheduled task was added. During the one-time transition, a `0.3.23` Worker initially launched by old Supervisor `0.1.0` intentionally keeps that current parent/session alive; parent-token Worker fencing becomes active after the next restart under Supervisor `0.1.1`.

Published stable identity: `0.3.23 / sequence 26`, archive digest `f112e76f977f41e9fcfc21f01a017e63048753632f244b3c2a065536e82878eb`. Deployment verification confirmed that the isolated v4 stable manifest was unchanged.
