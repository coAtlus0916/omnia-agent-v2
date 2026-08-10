# Remote Connector 0.3.28

Worker: `0.3.28 / sequence 31`
Supervisor: `0.1.3`

This release fixes the remaining live-update lifecycle fault without adding any Feature business logic to the Connector.

## Root cause

The previous update policy treated a fresh `disconnected` Worker with no active command as an activation window. A transient WebSocket close could therefore race with reconnect, promote a staged candidate, terminate the recovered Worker, and create a new Connector session generation. The browser remained open in 0.3.27, but the Connector binding and safety-lock generation still changed.

## Lifecycle contract

- Online update checks only download, verify, extract and stage a candidate.
- A running Worker is never stopped or replaced by an update check, regardless of Bridge state.
- A staged candidate may activate only after the Supervisor has obtained the singleton lock and before the first Worker of a cold start is launched.
- One-shot checks do not launch a resident Worker.
- Candidate probation failure restores the previous managed version before starting its Worker.
- Feature installation, Feature execution, Pack refresh and Bridge reconnect cannot activate a Connector candidate.

This follows the v4 principle that update discovery must not restart the active Connector. The v5 implementation keeps automatic delivery while making the only activation window a true cold start with no owned Worker.

## Acceptance

- The update-policy contract proves that a started Worker always blocks activation.
- The live update-check function contains no Worker start, stop or activation call.
- The one-shot path exits without starting a Worker.
- The cold-start path activates pending before the first ordinary Worker start.
- Upgrade smoke covers `0.3.27 -> 0.3.28`, active-operation blocking for manual replacement, binding preservation, packaged health identity and managed sequence `31`.
