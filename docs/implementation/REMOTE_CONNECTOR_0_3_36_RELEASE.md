# Remote Connector 0.3.36 baseline

Status: source candidate only. This document does not authorize publication,
installation, process restart, or a stable-channel change.

## Reachability boundary

0.3.36 (sequence 39, Supervisor 0.1.7, Guardian 0.1.0) is the final local
portable/cold-start baseline. A running 0.3.35 / Supervisor 0.1.6 process can
download and stage a package, but it cannot safely activate new Supervisor
bytes online. The operator must perform the one local portable cold transition
to 0.3.36. Only releases after this baseline may use the A/B online path.

The cold 0.3.36 Worker starts with command admission sealed. It performs a real
read-only workspace-authority/capability probe and remains sealed after managed
promotion. A Core generation that has authenticated Connector 0.3.36 or newer
must complete `omnia.connector-delivery/v1` protocol admission over the existing
Bridge command/result channel before the Worker opens business admission. An
old Core or old Connector therefore fails closed; neither direction receives a
temporary mutation compatibility window.

## Durable online transaction after the baseline

- Managed release state and the update transaction use revision CAS under a
  cross-process bakery mutex. Sequence high-water never moves backwards.
- Worker A closes admission first, drains to known zero, seals, closes its
  socket, rechecks all operation/resource/registration blockers, and releases
  the single global Worker claim.
- Candidate Worker B starts sealed with a transaction epoch. Promotion requires
  fresh PID/execution-generation identity, the exact claim, zero business
  admissions, known-zero blockers, Bridge connectivity, and a real workspace
  authority/capability probe.
- Supervisor bytes live in immutable A/B slots. Guardian acknowledgement binds
  PID, Guardian token, transaction, bootstrap revision, slot, and byte digest.
- Promotion has an explicit irreversible `terminalizing` phase. Worker B must
  first prove it can run; Worker A and the previous Supervisor slot are then
  retired. The first B business dispatch writes a durable rollback barrier
  before the effect is dispatched.
- A Guardian/Supervisor crash cannot create a second claimant. A guardian-managed
  Worker drains and seals, releases its claim, publishes an exact durable
  handoff, and exits only after the replacement Supervisor heartbeat is proven.

## Delivery certainty

Core allocates and persists the request identity before a durable mutation is
sent. Worker persists the canonical full wire response and digest before Bridge
delivery. Core stores authoritative read receipts and the first-phase ack in one
SQLite transaction. A conclusive `readback_verified` or `closed_not_applied`
transaction emits the second-phase effect-resolution ack. The dispatcher sends
these phases in order and retries pending outbox rows after restart.

All mutation error responses remain `effect_uncertain` until exact authoritative
read-back resolves them. A missing old read-only delivery entry may be marked
abandoned and safely replayed with a new request identity; a missing mutation
entry is never replayed.

## Current verification gate

The source gate requires `npm run typecheck`, targeted protocol/state tests,
multi-process crash/fault tests, and an isolated candidate canary. No 0.3.36
candidate or stable artifact may be claimed before all gates complete.
