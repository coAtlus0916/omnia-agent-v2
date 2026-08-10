# Remote Connector 0.3.32 candidate

Worker: `0.3.32 / sequence 35`

Supervisor: `0.1.5`

Status: signed portable candidate built and verified locally; not deployed, remotely installed, published to the download host, or activated.

## Scope

- `refresh` is now a strictly passive projection of the existing Session status.
- Keepalive never reloads, navigates, focuses, creates, or explicitly connects a Pack page.
- A missing existing target is returned as the real `target_closed` state. Only the explicit user `connect` action may start or foreground the controlled browser.
- Connector remains limited to transport, session, gate, and generic Operation hosting. No Feature business logic was added.
- Connected update activation remains stage-only; this change does not alter Supervisor activation policy.

## Regression gates

- The lifecycle test proves refresh leaves the process PID, Session generation, target URL, Engagement ID, and Pack ID unchanged.
- The missing-target test proves refresh returns `target_closed` without calling `connect` or `ensureBrowser`.
- Source and package gates reject a refresh method containing `reload`, `goto`, `bringToFront`, `newPage`, `connect`, `ensureBrowser`, or `currentPage`.
- The packaging gate inspects the bundled `worker.cjs`, so a source-only fix cannot produce a regressed portable runtime.

## Verification boundary

Automated source/build tests may establish passive lifecycle behavior. A company-machine canary across at least two Shell keepalive intervals is still required after an explicitly authorized installation. That canary must show an unchanged Worker PID, Session generation, Pack target/identity, and no new disconnect event. Candidate smoke installation was isolated to a temporary directory; the current remote Connector was not installed, published, restarted, or closed.

## Candidate evidence

- Source commit: `8c7efb39c59d6e0df262c348c4188cc78ce389c9`
- Archive: `remote-connector/releases/0.3.32/Omnia-Agent-v5-Remote-Connector-v0.3.32-Portable.zip`
- SHA-256: `1daa7ddd6980ed6357db9253a0023b5815fa43e5af4484bb193b302b6e07aaaa`
- Size: `37268047` bytes
- Signed update manifest: `0.3.32 / sequence 35`, supervisor `0.1.5`, `automatic_safe_window`
- Connector lifecycle/update tests: 26/26 passed
- Package verification, isolated portable smoke, and `0.3.31 -> 0.3.32` upgrade smoke passed
- The upgrade smoke preserved data and rejected upgrade while an Operation was active.
