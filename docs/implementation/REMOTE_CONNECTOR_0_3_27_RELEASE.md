# Remote Connector 0.3.27

## Scope

This is a Connector lifecycle hotfix on top of 0.3.23. It does not add a Feature capability or change the Bridge protocol.

## Fixed failure mode

The Shell keepalive invokes the Connector `refresh` operation every five minutes. In 0.3.23 that operation reloaded the user's active Omnia Pack page. The reload could discard the user's visible page state, temporarily remove the captured Authorization header, and make a healthy Connector look disconnected.

0.3.27 makes refresh a passive read-only probe. It checks the existing CDP target and live Pack hierarchy through `status()` and never starts Edge, creates a tab, reloads, navigates, closes, or focuses a page.

An API command that has not yet observed Authorization now waits briefly and fails closed. It no longer reloads the Pack to manufacture a new request.

Automatic updates may be downloaded and staged while the Bridge is in use, but they are not activated while the Worker is `connecting` or `connected`. A future candidate therefore cannot stop an active Pack session merely because the command queue is empty.

Worker shutdown now waits up to five seconds for the WebSocket close handshake. Transient `status.json` or update-request write failures are isolated from the live Worker. A fatal Supervisor failure leaves its detached Worker alive so the existing owner-loss recovery can take over; explicit stop and version activation still stop the owned Worker.

Repeated Start calls no longer write a stop request against a live owner or spawn a new Supervisor every two seconds. A Bridge `4001 replaced` response fences the losing instance for a long backoff instead of creating a credential reconnect loop.

The Connector-launched Edge process is detached from the Worker lifetime. The local Session lock records a token and process start identity so a stale PID reused by an unrelated process cannot permanently fence the Connector.

## Invariants

- Connector remains transport and browser-interaction infrastructure.
- No Create/Associate, Recording, Delete, GRA, Risk or Control business rule is added.
- Supervisor version is 0.1.2; existing 0.1.0 and 0.1.1 bootstraps admit the verified package and the new Worker performs the bounded bootstrap migration.
- Existing signed package admission, explicit stop and owned update switching remain fail-closed.
- User-controlled Edge pages are never closed by Connector shutdown.
- Build packaging refuses a dirty tracked worktree and records the exact source commit in the package identity.

## Verification gate

- Build and portable package smoke must pass from a clean 0.3.23 worktree.
- Packaged Connector source must contain no `page.reload` call in the session adapter.
- Managed 0.3.23 to 0.3.27 upgrade smoke must preserve binding and reach a healthy worker.
- The final ZIP must be extracted with Windows `tar.exe` and pass the same signed install smoke from the extracted root; development-only Playwright skill markdown is excluded from the runtime inventory.
- Repeated Start smoke must preserve the same Supervisor and Worker PIDs and must not create `stop.request`.
- Graceful Worker stop must complete the WebSocket close handshake before process exit.
- After deployment, the same remote PID/session must survive at least two keepalive intervals while the Pack URL and visible page remain unchanged.
