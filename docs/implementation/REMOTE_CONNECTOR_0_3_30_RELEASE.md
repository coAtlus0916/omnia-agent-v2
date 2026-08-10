# Remote Connector 0.3.30

Worker: `0.3.30 / sequence 33`
Supervisor: `0.1.4`

This is the publishable stale-heartbeat recovery release. The locally packaged 0.3.29 candidate was withheld because its isolated branch still exposed the retired recording command. No 0.3.29 manifest was deployed.

## Connector boundary

- No Create & Associate, Recording, or Delete business command exists in Connector Core.
- The Worker exposes only the generic signed Operation host, current-page observation, and managed stream contracts.
- Recording persistence, catalog transformation, and export stay in the Recording Feature and bundled Python runtime.
- Online update checks remain stage-only and never replace a running Worker.

## Stale Worker recovery

- The Supervisor watches the exact owned Worker's local status heartbeat.
- Network or Bridge disconnect alone does not restart a locally healthy Worker.
- Startup receives 15 seconds of grace; local staleness must remain continuous for 30 seconds before recovery.
- Windows sleep/resume or another long Supervisor loop gap resets the stale interval.
- Recovery replaces only the owned stale Worker and leaves the external Edge session intact.
