# Remote Connector 0.3.35 release

Worker identity: `0.3.35 / sequence 38`  
Supervisor baseline and minimum admitted version: `0.1.6`  
Status: immutable candidate frozen, locally promoted, and published to the official stable endpoint. The public archive has been read back byte-for-byte and the signed three-version Windows upgrade canary has passed in isolated roots. The company workstation has **not** activated 0.3.35 and no live Pack canary is claimed; its last observed state remains 0.3.33 with stale pending 0.3.34 and requires one local 0.3.35 portable start.

## Scope

The 0.3.35 Worker changes only the generic signed Operation resource lifecycle used by Page Observation and Managed Stream, while its bootstrap raises the release Supervisor to 0.1.6 for crash-safe activation. It does not contain Feature workflow, recording state, catalog interpretation, export, or any other business rule.

- a signed Operation manifest may declare a generic `resourceOwner` with a stable owner id, compatibility epoch, capability ids, and an exact sorted list of legacy source package digests;
- invocation remains pinned to exact Feature version and exact Operation package digest;
- cross-digest frozen evidence access additionally requires the same capability fingerprint and a strictly increasing publisher sequence;
- the fingerprint is derived from publisher key id, Feature/package identity, canonical Operation descriptors, handler SHA-256, and policy SHA-256;
- active observations remain bound to their creating digest and Connector session generation and fail closed during replacement;
- only stopped, complete, zero-omission observations with a finalized transferable stream can be read by a compatible successor;
- stream bytes and metadata persist in the Connector data root for seven days, with atomic metadata replacement, size/digest verification, and audited TTL cleanup;
- cold restart freezes an interrupted active writer as incomplete evidence and never resumes it;
- corrupt or drifting evidence fails closed without immediate deletion;
- managed evidence is bounded by count and total-byte quotas; quota exhaustion rejects new creation/appends and never evicts unexpired frozen evidence;
- old `.bin` streams without authenticated metadata move to `legacy-orphans` with exact stream id, regular-file size, SHA-256, and quarantine timestamp. They are not automatically claimed. The generic preservation pass runs inside Supervisor 0.1.6 after it owns the startup lock and before it starts any Worker; `ManagedStreamHost` independently rejects construction if that pass reports a failure or a remaining orphan;
- Supervisor 0.1.6 repeats that offline preservation pass before starting any current or pending Worker and aborts startup if quarantine reports a failure or any remaining orphan;
- a pending candidate remains pending while its signed portable manifest, signed `package-identity.json`, health probe, and continuous probation are checked against exact version, sequence, and Supervisor 0.1.6 identity. Only completed probation atomically advances `current`, clears `pending`, and records the sequence high-water; a crash before or during probation leaves the old current plus pending candidate durable for a fresh probation attempt;
- recovery handoff accepts only a live Worker whose status is the exact managed current or pending version/sequence. The handed-off process is quiesced and must exit before startup continues, so an uncommitted pending Worker is never adopted as authoritative; unknown identity fails closed;
- registration uses the existing `operation_register` transport in three signed phases: prepare keeps the new digest non-invocable, commit makes old and new digests co-exist, and explicit finalize retires the old registration only after the Core activation-head CAS. Every phase is token-bound and idempotent;
- committed/finalized registration transactions are persisted in an atomic, integrity-validated, quota-bounded ledger. A Connector cold restart returns the original committed token and exact replaced digests, so Core can replay finalize rather than inventing a new lineage;
- compatible frozen resources receive a durable owner-adoption record with exact `current` and optional exact `pending` owner identities. Commit admits only those two identities; finalize atomically advances the high-water mark to the target and revokes every lower sequence/digest, including after cold restart;
- before the Core activation CAS, an exact token-bound `abort` command can durably clear pending ownership and revoke the target registration while preserving the source. Finalized transactions reject abort, and repeated abort is idempotent;
- observation ownership is finalized only in the final phase; any partial metadata/sidecar transition is replayable and corrupt adoption or registration metadata fails closed without deleting evidence.

Legacy orphan boundary: a `.bin` without authenticated creator metadata has unknown provenance. It is quarantined and preserved, but is never adopted by normal signed `resourceOwner` handoff and is not exposed as a readable managed stream. A future forensic recovery path, if approved, must require an explicit Core-recorded user confirmation, label provenance as unknown, preserve the original quarantine bytes, create only a bounded short-lived derived copy, and audit the confirmation plus evidence digest. This source candidate intentionally does not implement or execute that optional path.

## Upgrade boundary from 0.3.33

The supported source test vector is a direct `0.3.33 / sequence 36 -> 0.3.35 / sequence 38` upgrade; 0.3.34 is not a prerequisite.

An already staged 0.3.34 cannot be superseded remotely by the running 0.3.33 worker: the installed Supervisor intentionally skips ordinary update checks while `managed-state.pending` is non-null, and Bridge exposes only the bounded `update_check` signal. Do not cold-start that stale pending state under the old Supervisor 0.1.5 bootstrap; use the verified 0.3.35 portable start so Supervisor 0.1.6 is installed before takeover.

When an operator is available, keep 0.3.33 running and invoke the verified 0.3.35 portable `StartRemoteConnector.cmd` exactly once. That guarded command verifies sequence 38, prepares the immutable version and Supervisor 0.1.6 bootstrap, and atomically replaces the stale pending 0.3.34 identity with pending 0.3.35 while 0.3.33 remains authoritative. It then checks active/uncertain operations, stops 0.3.33, and launches Supervisor 0.1.6. After acquiring the startup lock, Supervisor 0.1.6 quarantines every legacy no-metadata stream before any current or pending Worker can start, verifies the signed 0.3.35 package identity before executing its health probe, and keeps `current=0.3.33,pending=0.3.35` throughout probation. Success alone atomically promotes 0.3.35 and records sequence 38; rejection blocks 0.3.35 and restores 0.3.33, while a Supervisor crash leaves pending durable and safely retries after the handed-off candidate exits. If a stale 0.3.34 pending reaches Supervisor 0.1.6, its older Supervisor identity is rejected before its health probe or normal Worker can execute. A staging/copy failure leaves 0.3.33 running and preserves the prior state. Do not run a separate managed Stop and do not start the old managed installation. After the one portable Start completes, verify the exact worker version/sequence, binding, Pack authorization, Page Observation, frozen restart-read, and keepalive canary.

Publishing this release does not perform that company-workstation activation.

## Candidate freeze, promotion, and publication

`scripts/package-remote-connector.mjs` is an offline candidate producer only. It performs a Connector-only esbuild into a unique operating-system temporary directory, fixes the identity to `0.3.35 / sequence 38 / Supervisor 0.1.6`, and can create only `remote-connector/candidates/0.3.35`. ZIP creation is pinned to the release-managed CPython 3.13.14 embeddable runtime after an isolated executable/version check; PATH Python and environment overrides are rejected. The packager has no mode that writes `remote-connector/releases`, `remote-connector/public/releases`, or `remote-connector/public/stable.json`; a recursive before/after snapshot guards the public tree as an additional fail-closed assertion. The resulting immutable portable ZIP is 36,075,018 bytes with SHA-256 `784588e51694ba993e4f8365ce683ba61d047cf8ba7d270b5e42144899631f70`.

`scripts/promote-remote-connector-candidate.mjs` is a separate local-only step. It accepts only that fixed candidate identity, verifies the signed update manifest, signed portable inventory, exact ZIP digest/size, exact package identity, SBOM identity, and byte equality between the candidate portable tree and its ZIP. It then copies the already frozen ZIP and manifest bytes without rebuilding, re-signing, downloading, uploading, installing, or starting anything. Local release, public archive, and stable-pointer publication are separate durable phases. A checksummed atomic journal captures the candidate tree digest and the complete previous stable bytes before the first mutation; retries detect already completed phase effects and resume idempotently. Existing immutable targets with different bytes fail closed, and `stable.json` is replaced only by an fsynced same-directory atomic rename of the original candidate manifest bytes.

The local promotion script remains deliberately separate from `deploy:remote-connector`. Both steps have now been run intentionally: local promotion completed with a resumable journal, deployment preserved the v4 manifest, and the official stable manifest reports `0.3.35 / sequence 38 / minimumSupervisorVersion 0.1.6`. A subsequent full public-archive download matched the frozen candidate size and SHA-256 above.

## Automated evidence

- `npx tsx --test tests/operation-host.test.ts tests/page-observation-durability.test.ts`
  - signed route/mutation permit regression;
  - process reopen and exact frozen bytes;
  - exact legacy digest handoff;
  - stable owner/fingerprint/sequence gates;
  - wrong owner/Pack/authority rejection;
  - active upgrade fail-close;
  - tamper fail-close;
  - audited TTL cleanup;
  - quota saturation without premature eviction;
  - legacy orphan quarantine without automatic claim or deletion;
  - provisional invocation denial, commit response-loss retry across Connector restart, old/new coexistence, exact abort, and explicit idempotent finalize;
  - monotonic sequence downgrade/equal-sequence rejection, three-generation durable owner high-water, and post-finalize old-digest direct-read rejection.
- `npm run typecheck`
- `npx tsx --test tests/remote-update-policy.test.ts`
  - strict managed pending/blocked state validation;
  - quarantine fail-closed injection;
  - stale 0.3.34 rejection before candidate execution;
  - crash-safe pending probation ordering and exact recovery-handoff identity.
- `npm run test:remote-connector-release-pipeline`
  - Connector-only build leaves the shared `dist` tree byte-identical and excludes Feature, Bridge, Main, and Renderer inputs;
  - packager identity and candidate-only/public-tree isolation guards;
  - frozen candidate ZIP/manifest byte preservation and previous-stable journal evidence;
  - idempotent resume across release-stage, release-rename, public-rename, stable-replace, and post-stable journal interruption points;
  - immutable conflicting target fail-close.

Additional release evidence:

- the focused Connector/Shell/Recording platform gate passed 82/82;
- the signed 0.3.33/0.3.34/0.3.35 isolated Windows canary proved that 0.3.34 never executed, legacy stream bytes were quarantined unchanged before any new Worker, and 0.3.35 was promoted only after Supervisor 0.1.6 probation;
- the legacy stream canary preserved 4,130 bytes at SHA-256 `4bcf463e433784cf8e63fead40e375ed29375247ed1923bf50d4cf70ad7c4462`;
- Feature-business token scans of the Connector release scope were clean.

Still pending: company-workstation activation, exact binding/authorization read-back, frozen-stream inspection, and a live Pack canary. These cannot be replaced by the isolated release evidence above.
