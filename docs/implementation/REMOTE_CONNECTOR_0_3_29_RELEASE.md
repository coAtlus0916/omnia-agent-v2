# Remote Connector 0.3.29

Worker: `0.3.29 / sequence 32`
Supervisor: `0.1.4`

This release closes the second Connector-lifecycle fault exposed by the live Pack session, without adding Feature business logic.

## Root cause

The Supervisor restarted a Worker only after the child process exited. A Worker whose process remained alive while its local status heartbeat stopped could therefore remain owned forever. The Bridge eventually rejected the stale remote heartbeat with close code `4008`, but the Supervisor never recovered the wedged Worker.

## Recovery contract

- The Supervisor evaluates the Worker status file only for the exact owned PID.
- A fresh local Worker heartbeat resets the watchdog and never restarts the Worker merely because the network or Bridge is disconnected.
- Startup has a 15-second grace period.
- Local heartbeat staleness must remain continuous for 30 seconds before recovery.
- A long Supervisor loop gap, including Windows sleep/resume, resets the stale interval and grants a fresh recovery window.
- Recovery stops only the owned stale Worker, preserves the external Edge profile/session, and starts the current managed Worker version.
- Online update checks remain stage-only; watchdog recovery cannot activate a pending release.

## Acceptance

- Policy tests cover fresh heartbeat, first stale observation, continuous stale recovery, and sleep/resume grace.
- Existing update lifecycle tests continue to prove no online Worker replacement.
- Packaged live and upgrade smoke must pass before publication.
