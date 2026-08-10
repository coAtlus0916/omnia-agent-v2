# Remote Connector 0.3.31

Worker: `0.3.31 / sequence 34`
Supervisor: `0.1.5`

This release repairs Connector lifecycle failures without moving any Feature business logic into Connector Core.

## Connector boundary

- Connector remains a transport, session, gate, generic Operation host, and current-page observation layer.
- Create & Associate, Recording, and Delete business logic remains outside Connector Core.
- The Connector never closes or owns the external enterprise Edge session.

## Liveness recovery

- A live but stale Worker is replaced only after continuous local heartbeat failure.
- A live but stale Supervisor is fenced through a strict Worker handoff and fresh replacement heartbeat acknowledgement.
- A Worker exits only after the replacement Supervisor lock and matching heartbeat are verified.
- Active operations remain fail-closed during ownership recovery and are never fabricated as successful.
- Automatic update staging runs outside the watchdog loop; archive extraction has a hard timeout.
- Implausible future heartbeat timestamps fail closed.
- WebSocket ping/pong detects half-open Bridge connections and reconnects without waiting for server-side expiry.

## Diagnostics

- Worker heartbeat recovery events are returned through the existing diagnostics channel.
- Credential-like diagnostic content is redacted before persistence or transport.
