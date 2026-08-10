# Remote Connector 0.3.34 candidate

Worker: `0.3.34 / sequence 37`

## Problem

The four connection layers were being conflated after a Shell restart:

1. Shell-to-Bridge WebSocket;
2. active Connector generation online;
3. one bound Omnia Pack target;
4. a currently usable Page Authorization verified by live hierarchy.

`0.3.33` could reuse a previously verified Pack identity indefinitely. A Shell
restart therefore first projected `connected`, while its subsequent live
Workspace authority read could receive HTTP 401 and revoke the old Page
Authorization. The Shell then changed to `waiting_authorization`. An explicit
Connect click did not repair the existing Edge target because the Shell skipped
the Connector `connect` command for all waiting states.

Production evidence on 2026-08-09 recorded the exact sequence: a startup
Workspace authority read failed with `CONNECTOR.AUTH_REQUIRED` at
`16:20:53.669Z`; two manual Connect IPC calls returned at `16:22:01.694Z` and
`16:22:09.726Z` without a successful authority read; the authority read only
succeeded at `16:22:29.615Z` after the browser had been restarted.

## Change

- `status` verifies the exact current Pack with a bounded live hierarchy read
  before projecting `connected`; a 401/403 revokes the stale header and projects
  `waiting_authorization`.
- Explicit Connect always reaches the generic Connector connect path for a
  waiting state. On an existing target it brings that Page to the front and
  waits for a newly captured Authorization header.
- Existing Pack targets are never reloaded, navigated, closed or replaced by
  this recovery path. The Connector does not inspect browser storage or invent
  credentials.
- Shell startup/background reconciliation passively polls the separate
  browser/Pack/Authorization layers every bounded scheduler tick. It does not
  focus or otherwise operate the browser.
- A due keepalive and passive recovery share one status probe rather than
  racing duplicate requests.
- No Feature-specific behavior is present in Shell, Bridge or Connector.

## Acceptance gates

- Shell contract proves a waiting Authorization state dispatches one real
  Connector connect, repeated Connect is idempotent, and background restart
  recovery advances with passive status only.
- Workstation Session contract proves stale cached identity plus 401 cannot
  remain Connected and that explicit recovery recaptures a newer Authorization
  without reload, navigation, new Page or target close.
- Existing Bridge heartbeat/generation tests remain green.
- Source typecheck and directed Shell/Session tests pass before candidate
  packaging.
- `0.3.33 -> 0.3.34` managed upgrade and a real Shell restart with the existing
  company Edge target must pass before the release is called deployed.

Packaging and deployment are separate release steps. This source candidate does
not claim a production update or real restart canary until those gates run.
