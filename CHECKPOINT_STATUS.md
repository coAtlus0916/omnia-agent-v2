# Development checkpoint

This branch is an intentionally incomplete, sanitized checkpoint. It is not a release and has not been installed in a production workstation.

## Included progress

- Recording, deletion, Create & Associate, workpaper navigation, Shell reconnection, and keepalive source changes.
- Connector 0.3.36 platform work for durable delivery, admission fencing, supervised upgrade transactions, recovery, and process-identity checks.
- Generic Feature navigation and Feature-independence architecture documentation.
- Unit and contract tests available at the checkpoint boundary.

## Still required before release

- Complete the remaining Connector multi-process fault matrix.
- Complete strict Feature store-port isolation and generic Operation upgrade/rollback handling.
- Enforce independent business functions, engines, runtime state, and release lifecycles for Create & Associate, Delete, Recording, and Workpaper Preparation; only platform contracts may be shared.
- Produce and verify immutable release candidates.
- Install through the supported local baseline path and perform a controlled Shell restart.
- Run live Recording, Delete, Create & Associate, workpaper, Pack reconnection, and keepalive canaries.
- Create the full supported Higher/Lower TEST matrix, validate it, then delete it and verify receipt-backed tombstones plus an empty final catalog.

No API keys, tokens, credentials, runtime databases, customer data, local acceptance evidence, or release history are included in this snapshot.

Legacy Connector smoke/canary scripts with raw PID cleanup are intentionally omitted and are not release gates.
