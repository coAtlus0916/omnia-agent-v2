# Remote Connector 0.3.33 candidate

Worker: `0.3.33 / sequence 36`

## Problem

`WorkstationOmniaSession.status()` repeated the authoritative hierarchy read on every Shell status reconciliation and keepalive. A rotating or temporarily stale Authorization could therefore make a healthy Connector process, Bridge socket, controlled Edge target, and unchanged Pack appear disconnected. This regressed from v4, whose heartbeat and status path never performed a Pack API read.

## Change

- The first successful hierarchy read stores a verified Pack identity in memory, scoped to the exact Playwright `Page`, Engagement ID, API origin, authority origin, and Pack ID.
- Later status and refresh calls reuse that verified identity only while all scope fields still match.
- Target closure, Engagement/origin drift, Authorization identity mismatch, or a different hierarchy identity invalidates the cache and remains fail-closed.
- Workspace authority reads, signed Operation preflights, reads, mutations, read-backs, and safety-lock live validation still use current Authorization and retain strict 401/403 failure behavior.
- Connector shutdown still never closes or terminates the controlled Edge session.
- Shell refresh is independently reduced to `status`, preventing an older or regressed Connector from receiving browser lifecycle authority from the Shell.

## Acceptance gates

- Session lifecycle contract proves two consecutive status/refresh calls perform exactly one hierarchy read.
- The same contract proves process PID, Session generation, target URL, Engagement ID, Pack ID, and browser action counters remain unchanged.
- Shell/Bridge contract proves Shell refresh sends `status` only and never sends the remote `refresh` operation.
- Isolated portable and `0.3.32 -> 0.3.33` managed upgrade smoke must pass before deployment.
- Production observation must preserve the Connector PID/session until the one authorized managed upgrade, then show a single candidate promotion and a stable new Worker with no repeated Pack API probe from status/keepalive.
