# 0.2.114 / sequence 116

## 0.2.114 / sequence 116 ordered multi-command reconcile

Read-only recovery now retains the remaining exact uncertain-command specifications after each authoritative reconciliation. It closes one durable command at a time, advances to the next frozen specification without replaying a mutation, and opens continuation only after no uncertain command remains.

Immutable 0.2.113 remains byte-for-byte unchanged.

## 0.2.113 / sequence 115

## 0.2.113 / sequence 115 disabled-source repair activation

Shell activation now keeps registry lifecycle identity separate from runtime availability. An exact active head whose Worker is disabled by a recoverable Surface error can hand off to a newer signed Feature package using version, package digest, and activation generation CAS; the failed source lifecycle cannot strand the repair candidate.

Immutable 0.2.112 remains byte-for-byte unchanged.

## 0.2.112 / sequence 114

## 0.2.112 / sequence 114 durable recovery Surface bound

Verbose per-item diagnostics remain in the durable Run checkpoint and audit trail, while the declarative Surface projects a bounded 500-character summary. A restart can therefore reconstruct and expose reconcile/continue controls even when a catalog incompatibility diagnostic contains a long exact missing-identity inventory.

Immutable 0.2.111 remains byte-for-byte unchanged.

## 0.2.111 / sequence 113

## 0.2.111 / sequence 113 continuation correctness and transport-latency release

Risk-Control association keeps the frozen Risk, Control, classification, scope, and assertion identity exact, while refreshing the action-time Risk `updatedOn` concurrency token from the authoritative catalog. This permits multiple governed Controls to be associated with the same Risk without treating the prior successful association's concurrency advance as identity drift.

The Shell/Connector Next control path observes durable cross-process results in bounded 500 ms intervals rather than depending on a process-local completion event for up to 20 seconds. Explicit Operation failures proven to occur before effect are preserved as `not_started` instead of being promoted to uncertain. Worker interruption recovery reconstructs the declarative Surface from durable Run state without replaying a mutation.

Immutable 0.2.110 remains byte-for-byte unchanged.

## 0.2.110 / sequence 112 live-accepted AD/code-migration and return-throughput candidate

The exact signed mother-workbook governance for DCNO, SAP S/4 HANA, Oracle EBS, AD and the code-migration Tool has now completed real TEST-workspace acceptance in both Higher and Lower modes. Higher Run `27114089-ad78-4b00-87c2-ed58ba18807e` completed 126/126 targets, including 39 Risk-Control relations. Lower Run `dae96896-081f-4ae0-9de1-a0bf328986ab` completed 122/122 targets, including 33 Risk-Control relations. Lower retains exactly DCNO 2, Oracle EBS 7, SAP S/4 HANA 17, code migration 3 (`TOOL.05/.06/.10`) and AD 4 (`OS.02/.06/.05/.10`) Control links. Both AD modes create the recorded generic-server GRA while preserving the one-way rule that AD is a generic server subtype, not that every generic server is AD.

The Lower Return also exposed two transport facts retained in the release record: the Surface remained at an old progress count while durable commands continued, and the Pack/Connector session disconnected once before a read-only refresh resumed the same Run. No verified mutation was blindly replayed. The Feature Worker now resolves the immutable generated Risk/Control catalog once per GRA relation batch rather than re-reading the same complete catalog before every relation. Signed action-time validation, durable mutation receipt and authoritative readback remain mandatory for every target.

Connector Next independently adds bounded durable batch claiming, server-side result waiting, same-job reattachment after transient wait failures, and narrow pre-effect Pack reconnect. Those transport changes contain no Feature ID, AD/Tool/DCNO/HANA/EBS mapping or Risk-Control business rule. The design uses v4's bounded-parallel scheduling only as a reference; it is adapted to Connector Next's persisted server job ledger and is not a copy of v4's in-process call model.

The two completed Runs predate this throughput optimization and prove business correctness, not the optimized elapsed time. Per instruction, no further live Pack transfer is started for this release; optimization coverage is offline until a separately authorized future canary. Immutable 0.2.109 remains byte-for-byte unchanged.

## 0.2.104 / sequence 106 isolated-signing source boundary

The current source uses only `middle/create-associate-python-bridge.cjs` and `python/create-associate-engine.py`, declares exactly the 34 Core Store ports called by its Worker and bridge, and keeps all Feature business outside Connector. Oracle EBS is gated by its exact authority alias `Oracle eBusiness Suite`, recorded key `66176468`, APP category key `66175343`, content type `3`, the 12-row catalog with an 11/7 Higher/Lower split, dual-unlinked `OEBS.04`, and Lower `RAITCOR002`/`RAITCOR011 = ClassificationNA`.

Immutable 0.2.103 remains byte-for-byte unchanged. The 0.2.104 candidate has not been generated or signed; this source boundary requires Shell 0.4.15, is not installed, and does not claim a live Omnia Return canary. Connector and Bridge are unchanged.

## 0.2.103 / sequence 105 exact closure and receipt candidate

Reuse and already-applied read-only closures now freeze the same durable command-spec evidence used by mutation paths, explicitly marked `noMutation=true`. Core rejects non-`create|reuse` GRA dispositions and only projects the exact payload stored in the trusted Operation receipt. Live acceptance independently proves DCNO APP-GRA inheritance and rejects extra dependency relations; Delete acceptance derives its final absence inventory from the exact succeeded plan steps.

Immutable 0.2.102 remains byte-for-byte unchanged. Candidate 0.2.103 requires Shell 0.4.15, is not installed, and does not claim a live Omnia Return canary. Connector and Bridge are unchanged.

## 0.2.102 / sequence 104 evidence-contract documentation candidate

The package documentation and candidate-level testing contract now describe the same exact base-GRA identity boundary shipped by 0.2.101: only the base `kind=object/objectType=GRA` command and projection require `contentName + inkContentId/typeId`; later GRA state, factor, documentation and evaluation projections remain governed by their own immutable intents. Live acceptance also rehashes the frozen command request from its durable spec before accepting a receipt chain.

Immutable 0.2.101 is preserved byte-for-byte and is not overwritten. Candidate 0.2.102 requires Shell 0.4.15, is not installed, and does not claim a live Omnia Return canary. Connector and Bridge are unchanged.

## 0.2.101 / sequence 103 exact GRA content-identity candidate

Each frozen GRA object intent now carries both the normalized user-selected content name and the exact authority-resolved `inkContentId/typeId`. Core rejects a Create GRA command when either identity differs from the immutable intent and refuses its managed projection unless the receipt-backed read-back contains the same content identity. The live acceptance verifier independently requires the workbook subtype, immutable intent, signed command spec and authoritative GRA read-back to agree; it also requires the exact governed dependency relation type (`InfrastructureApplication` or `ItToolApplication`) and treats DCNO as an `Infrastructure` object.

This source change supersedes rather than overwrites immutable 0.2.100. Candidate 0.2.101 requires Shell 0.4.15, is not installed, and does not claim a live Omnia Return canary. Connector and Bridge are unchanged.

## 0.2.100 / sequence 102 generic pending/Return presentation candidate

The signed Surface now declares `omnia.declarative-action-pending-presentation/v1` for upload confirmation, Return preparation, confirmation, continuation and read-only reconciliation. Each declaration supplies its real executing title, message and workflow step; the generic Renderer no longer identifies Create & Associate by Feature ID or action-name branches. The three actions rendered inside the Return layer opt in through the generic `presentation=return` contract. Unknown fields, unknown schemas, hidden/background misuse and workflow-step drift fail package validation.

This source change supersedes rather than overwrites immutable 0.2.99. Candidate 0.2.100 requires Shell 0.4.15, is not installed, and is not a live Omnia Return canary. Connector and Bridge are unchanged.

## 0.2.99 / sequence 101 Oracle EBS source candidate

Oracle EBS now requests the exact recorded StandardizedAccount name `Oracle eBusiness Suite` through the common dynamic APP authority resolver. Recorded key `66176468`, APP category key `66175343` and the observed publication UUID remain provenance only. The governed V8 SHA-256 is `CB44EE079D045564454F9A11015E6D2F91CF1C663608C9291CD00F0B1CF76F70`, with 257 fields, 118 relations, 23 evidence rows and 269 traces. Oracle contributes 12 catalog relations: Higher selects 11, Lower selects 7, `OEBS.04` is unlinked in both, and Lower RAITCOR002/RAITCOR011 are `ClassificationNA`. Live Risk/Control UUID/final-relation readback remains explicit non-execution metadata and does not block an otherwise valid Return.

The source/managed V5 copies are byte-identical at SHA-256 `0CD1EB147CADC9BC4F169C7109B60DD5D4BAAD859CC9B48D8A11D3FAEC89D49F`; C23:C24 now has exactly one Oracle-capable validation. Release CPython 3.13.14 self-check passes 34 directed fixtures. This candidate is packaged but not installed and is not a live Return canary. Connector and Bridge are unchanged.

## 0.2.98 / sequence 100 source candidate

Shell-owned `surface.lifecycle.onReopenActionId` now gives the Feature one signed, hidden local-state action that is dispatched only when the same retained Surface instance moves from `closed` back to `open`. First open, focus, dock, detach and minimize do not dispatch it. Create & Associate points this contract at `fresh-start-on-reopen`, which reuses the audited exact-revision fresh-start state machine: immutable Artifacts, revisions, confirmations, intents, commands, receipts, read-backs and verified remote values are preserved; no rollback or mutation replay occurs. Uncertain or reconciling work remains fail-closed and must complete read-only reconciliation.

The lifecycle contract is a Shell change and requires Shell 0.4.15. It is therefore source-ready only: no 0.2.98 package is installed into the current 0.4.14 release, and 0.2.97 remains the active compatible Feature. Connector and Bridge are unchanged.

## 0.2.97 / sequence 99 source candidate

The explicit `结束旧流程并全新开始` action now works across active local processing, stable pre-write, active Return/verification and terminal states. Active work is first closed with exact Core revision CAS, then the Core restart audit is committed at the newly observed revision. Artifacts, revisions, confirmation/intent history, commands, receipts, read-backs and verified Omnia values remain intact; no rollback or mutation replay occurs. Uncertain or reconciling state must complete read-only reconcile first and cannot be discarded.

This is a Feature-only fallback invoked by the user. Current Shell close/reopen does not call Worker, so this candidate does not claim automatic reset when the Feature window is closed and opened. A real automatic lifecycle requires a separately authorized Shell hook. Connector, Bridge, Shell and Core are unchanged.

## 0.2.96 / sequence 98 source candidate

Validated uploads no longer become non-executable because a type lacks a dedicated recording, a `returnSupport=supported` label, or a prior live canary. Python no longer emits `LOCAL.CONTENT_PENDING_RECORDING`, `PLAN.CONTENT_PENDING_RECORDING`, or `PLAN.RISK_CONTROL_RAIT_UNSUPPORTED`; every deterministic intent freezes `blockedPendingRecording=false`. Worker removes the duplicate Review, live-validation and prepare-Return gates and proceeds to the real signed authority resolver.

Oracle EBS uses the exact declared Omnia content name `EBS电子商务套件`; AD and 代码迁移工具 remain literal until an exact alias is declared. Missing historical catalog evidence no longer blocks before the current Risk-Control directory is read: exact current Risk and Control numbers may resolve one identity, while zero or multiple matches fail closed. Authority/safety mismatch, missing/invalid/contradictory RAIT, actual API rejection, remote drift and uncertain prior mutations remain blocking. Connector Core and Bridge are unchanged.

## 0.2.95 / sequence 97 source candidate

Deterministic Return business decisions now have one implementation in release CPython 3.13.14. `plan_ir.py` freezes description, Settings values, relation targets, Risk-Control catalog/required sets, per-Risk Higher/Lower/ClassificationNA decisions, APP scoring items and documentation into a canonical `returnIntents` object with a semantic digest. Middle verifies that digest before preparation and execution, then adds only authoritative remote identities and scheduling facts. The duplicate JavaScript family/scoring/classification selectors and the unused JavaScript OOXML runtime compiler were removed; package-time and runtime workbook compilation now share `workbook_compile.py`.

This does not move the safety lock or remote mutation authority into Python. Core remains the only owner of Run CAS, confirmation, immutable intents, command permits, evidence ledger and uncertain reconciliation; Worker remains the only caller of Core and the signed Feature Operation. Python has a deny-network policy and cannot call Connector. Connector remains the generic Operation/transport host and contains no Create & Associate business logic. Package self-check passes 28 independent fixtures and the targeted S/4 catalog suite passes 6/6 with release CPython 3.13.14; no live Return canary is claimed.

## 0.2.94 / sequence 96 source candidate

The signed user workbook is now the exact managed copy of `Phase1-用户填写模板V5.xlsx` (SHA-256 `31bb93ffb70246ad13e4e3811599d7b45fd81c6ab2cae510c575cbc1659391eb`). Download, upload parsing, compiled output provenance, offline fixtures and package-local backend validation all use the V5 contract. V5 adds `Oracle EBS`, OS `AD`, and `代码迁移工具`. They are recognized values but remain fail-closed with `LOCAL.CONTENT_PENDING_RECORDING` and `PLAN.CONTENT_PENDING_RECORDING` until their own recordings establish exact Omnia content, GRA, RAIT, Risk-Control and relation evidence. `Oracle EBS` records only the future exact display-name expectation `EBS电子商务套件`; no content ID or relationship is inferred. This changes only Create & Associate Feature files and does not add Feature business to Connector.

The user-maintained `link_required_higher/lower` values now deterministically derive all 106 relationships' classification and execution-applicability columns. Higher and Lower share the same catalog inventory. Every generated Risk is classified independently: one or more selected Control links writes Higher/Lower; zero selected links writes and authoritatively verifies `ClassificationNA`. S/4 uses 18/17 links over its 30 signed exact live identities; DCNO uses 3/2 links over one shared exact catalog and no longer blocks Lower merely because it was not separately recorded. The managed V8 SHA-256 is `489348B8AF913ABA17A64AEE1B449CDCC2D6B27E04A2505E4E8C4D6DD1659103`. Targeted S/4/DCNO tests pass, and package self-check passes 30 independent fixtures with release CPython 3.13.14.

## 0.2.93 / sequence 95 candidate

The complete frozen stream for recordingId `34ea8734-0d21-4ef2-88a5-6455ae94b8bd` contains 1587 continuous events, `complete=true`, `omissionCount=0`, and SHA-256 `65fff6c856998e303189a2a35bd59b51754402673887bd8c574015be17edb9d8`. Final Risk read-backs prove 30 S/4 Higher associations across native `SAPS4.*`, `SAPCUA.*`, `SAPCHARM.*`, and `IMP.*` Controls. The managed mother workbook replaces the old 24 `SAP_*` policy identities with those 30 exact live identities; no ordinal or translated-description mapping is used. The signed catalog registry binds every required relation to its exact native Control number and recording trace. `DCNO.17/.18` were only unassociated RAITCOR010 candidates and remain excluded.

The common 15-item APP scoring capability already matches the recording and is unchanged. `isRelevant=true` is retained, but `linkedAppCount=0` means this recording does not prove an APP-to-APP relation. No Lower S/4 directory or relationship was recorded, so Lower has zero governed relations and fails closed before remote catalog polling or mutation. The managed V8 digest is `5CA1E2365829EFEE547507D7F5E540DA34AE8E9AE6CFAFB3D6340DE0619A8C40` with 239 fields and 106 relations. Targeted S/4 tests pass 5/5 and the package self-check passes 27/27 using release CPython 3.13.14. This changes Create & Associate Feature governance only; Connector, Bridge, Shell, Core and Pack page remain unchanged. It is not a live Return canary.

## 0.2.92 / sequence 94 candidate

This is the current candidate; main-agent verification is still pending. The immutable DCNO recording is Artifact `110eba6d-dd39-4b20-bfd5-83caefd20260`, recordingId `8aa3673e-53b7-4902-bca6-7b86d5cc62be`, with 992 events. It records `Infrastructure`/`Network`, GRA contentId `60241274` (`通用网络设备`), one-or-more same-Workspace APP `InfrastructureApplication` relations with `ConcurrencyTabId=602`, and `any_higher_else_lower` inherited RAIT. Higher's 3-Risk/8-Control read-only directory enables exactly `RAITCOR008→DCNO.05/.21/.22/.23/.24` and `RAITCOR006→DCNO.10`; `RAITCOR001`'s observed `APP.03`/`APP.06` remain disabled. DCNO does not borrow APP-only IT-risk category/Factors, settings, direct RAIT, scoring or AI review, while GRA/Risk-Control/Evaluation remain enabled. Lower has no recording evidence and stays `PLAN.RISK_CONTROL_RAIT_UNSUPPORTED` fail-close; no Lower catalog or relation is inferred.

Only the Feature's signed Operation adds the `Network` parameter and reuses the DB/OS parameterized Infrastructure engine. Connector remains the Operation/transport/session/gate host and has no Feature business logic. The status is based on immutable recording/read-only catalog evidence and targeted offline validation only; it is not a live Return canary and no package installation is claimed.

## 0.2.90 / sequence 92 history

The risk-control catalog identity registry is embedded in the signed `backend/governance.json` instead of being duplicated as an undeclared backend package member. Shell 0.4.14 accepts only its exact declared member inventory and the established `governance`, `runtime_template_base`, and `source_template` managed-asset kinds.

A determinate `returning` Run now projects the existing left-rail previous-step slot as the real `强制取消回传` action and enables `重新开始` at the same time. Force cancel commits one Core `state_revision` CAS from `returning` to `failed`, records `return.force_cancelled`, preserves every verified Omnia effect and durable command/receipt/read-back record, and never rolls back or replays remote mutations. Restart during a safely cancellable Return serially commits that same close before `run.restart_requested`; uncertain writes remain fail-closed behind signed read-only reconciliation. An in-memory cancellation fence also prevents not-yet-submitted mutations from being prepared or submitted after the cancel action wins. This candidate changes only Create & Associate Feature files.

## Post-R7 source correction (not yet a released canary)

R7 proved that a generated 6-Risk/32-Control S/4 catalog can be complete while remaining incompatible with the signed mother-workbook identities. The live catalog exposed families such as `SAPCHARM` and `SAPCUA` plus localized Draft.js names, while the governed plan required `SAP.xx` plus English descriptions. The source now separates policy/display `controlName` from a signed exact `catalogControlNumber`. The managed catalog-identity registry deliberately contains no invented S/4 mappings: its S/4 family is blocked until one complete read-only catalog extraction supplies every required exact relation identity with evidence. Required relations cannot fall back to same-ordinal or translated-description guessing. A non-empty unchanged catalog fails with `RETURN.RISK_CONTROL_GOVERNANCE_INCOMPATIBLE` after the bounded stability window instead of waiting the full 120 seconds. This source correction changes only the Create & Associate Feature package and does not change Connector, Bridge, Shell, Core, another Feature, installed state, or Pack state.

## 0.2.87 / sequence 89 candidate

The signed catalog boundary no longer contains a SAP/SAP ECC/SAP S/4 HANA alias table. It normalizes any structurally provable `family + ordinal` value without changing the family, while the Worker accepts a different live/governed family prefix only when the ordinal and complete governed description both match inside the exact GRA. Numberless and unprovable display values retain the same exact-description path. Every path requires one unique Risk and one unique Control, so duplicate descriptions or duplicate family/ordinal identities remain unresolved and fail closed. Bounded diagnostics omit object IDs and redact GUID/credential-shaped text before projection. The candidate changes only Create & Associate Feature/Operation source, tests, and in-package documentation; it does not modify Connector, Bridge, Shell, Core, installed packages, or Pack state.

## 0.2.85 / sequence 87 candidate

The signed Risk-Control catalog boundary now emits a canonical Control number only when the live value proves a leading prefix and ordinal. SAP ECC/S/4 HANA display spellings normalize to the governed `SAP.<two-digit ordinal>` identity; an unprovable display value no longer blocks the existing exact-description fallback. Exact description matches still require one and only one Control inside the exact GRA, so duplicates remain fail-closed. Catalog diagnostics expose at most eight NFKC-normalized `controlNumber`/`name` samples, each capped at 160 characters and containing no IDs or credentials. No Connector, Bridge, Shell, Core, UI, Python engine, installed package, or Pack state is changed by building the candidate.

## 0.2.84 / sequence 86 candidate

The S/4 HANA Risk-Control catalog resolver now keeps numbered Controls on the strict canonical-number path and uses a separate, parameterized description path only when the live Control has no number. That fallback applies NFKC, removes only a leading canonical Control number plus its separator, normalizes whitespace, and requires the full remaining description to match exactly once inside the already exact GRA. A 32-Control/6-Risk live-shaped fixture proves all 18 Higher and 17 Lower governed links resolve without invented numbers; a duplicate description remains unresolved and fail-closed. The prior 52 verified targets are not resubmitted by this source change. No Connector, Bridge, Shell, Core, UI, Python engine, installed package, or Pack state is changed by building the candidate.

## 0.2.83 / sequence 85 candidate

The 0.2.82 S/4 HANA Control-number correction now has a directly addressed source regression that executes the real signed Operation catalog path. It presents `SAPECC.01`, `SAPS4HANA.01`, display-form `SAP S/4 HANA.01`, underscore-form `SAP_S4_HANA.01`, and `S4HANA.01` one at a time, requires each live-shaped catalog result to canonicalize to governed `SAP.01`, and proves `TOOL.05` remains unchanged. This closes the gap between the documented correction and the executable source acceptance. Runtime behavior is otherwise unchanged; no Connector, Bridge, Shell, Core, UI, Python engine, installed package, or Pack state is changed by this candidate.

## 0.2.82 / sequence 84 candidate

The signed Operation now canonicalizes only the recorded SAP application Control-number prefixes (`SAPECC`, `SAPS4HANA`, display-form `SAP S/4 HANA`, and `S4HANA`) to the mother-workbook identity `SAP.<ordinal>`. This fixes the observed S/4 HANA catalog false negative where the exact GRA returned six Risks and 32 Controls but all governed `REL.APP.SAP_S4_HANA.*` links remained unresolved. Risk identity, exact Assessment/Workspace scope, classification, Control uniqueness, and read-back requirements remain unchanged. The managed workbook still selects only exact S/4 family rows (18 Higher, 17 Lower); Tool dependency failure remains attempt-scoped and a missing Tool Risk-Control association remains `verified=false` for Core read-only reconciliation. No Connector, Bridge, Shell, Core, UI, Python, or installed package is changed by this candidate.

## 0.2.81 / sequence 83 candidate

Factors Considered AI review now carries the explicit `zh-CN-simplified/v1` display-language contract. The Provider prompt requires `summary`, `concern.message` and every non-empty `concern.suggestion` to be Simplified Chinese while preserving English schema, enum and code values. Worker-side validation rejects obvious English-only display strings with `AI.REVIEW_OUTPUT_LANGUAGE_INVALID`; the real Provider attempt is retained as a retryable `not_evaluable` warning and is never presented or cached as a successful review. The language version participates in the input digest and persisted cache identity, so older English results cannot be reused. The unpublished 0.2.80 candidate is superseded before installation because the language checks were consolidated into the exact runtime output guard exercised by the fixture. No Renderer translation, deterministic validation, Python parsing/Return engine, Core, Shell, Bridge, Connector or installed package is changed.

## 0.2.79 / sequence 81 candidate

The APP Risk Factor category directory resolver now deduplicates repeated `riskFactorGrouping` projections by stable authoritative identity instead of comparing the complete nested JSON graph. A single category ID is accepted only when every projection has the normalized exact category name, any explicit Risk Assessment and Workspace IDs remain in the frozen scope, deletion state is consistently active, and any explicit `applicable` values agree. Per-factor `$id`/`$ref`, timestamps, descriptions, nested collections and other non-identity projection differences no longer create false identity drift. Same-ID explicit identity conflicts, multiple category IDs, cross-GRA/cross-Workspace evidence, deleted state and inconsistent applicability still fail closed. Three real-shape source fixtures and one package-local nested-Operation check cover the correction. No Worker orchestration, Connector Core, Bridge, Shell transport or route is changed.

## 0.2.78 / sequence 80 candidate

The frozen Python plan's complete boolean `capabilities` map is now copied into every prepared Return row and retained unchanged in the persisted Return plan. Preparation and confirmation both compare every projected row against `planIr.rows`; a missing, added or changed capability fails with `RETURN.CAPABILITY_PROJECTION_DRIFT` before the dependency graph or any remote mutation can run. The source regression exercises prepared rows, serialized Return-plan rows and the confirm guard, including a negative omitted-capabilities case. No Connector, Bridge or Shell transport code changes are part of this patch.

## 0.2.77 / sequence 79 candidate

APP `isRelevant` now derives as `true` from the single signed rule `phase1.app-is-relevant-true.v2` for Generic, SAP ECC, SAP S/4 HANA and any future APP content family registered through the same APP capability. The APP settings Operation writes `/isRelevant=true`, verifies the mutation response/read-back and rejects a false payload. DB、OS、TOOL、DCNO do not borrow this APP-only settings contract. DCNO remains upload-recognized, locally validated and Return-blocked until exact Network lifecycle evidence exists. The unpublished 0.2.75 and 0.2.76 candidates are retained as failed evidence: 0.2.75 exposed a source-only Operation test path; 0.2.76 fixed that path but the v1 installer correctly rejected undeclared runner members. 0.2.77 keeps all 17 source fixtures in `--self-check` and declares four real package-local checks that execute entirely from allowed v1 inventory. No candidate status is a live Omnia canary claim.

## Released 0.2.74 behavior

Version 0.2.74 / sequence 76 makes the Python capability plan the sole deterministic execution graph. Global blocking issues are propagated into every active plan row while issues owned only by excluded rows remain isolated. Worker execution consumes frozen `dependencyRowKeys` and `stageNodes`; it no longer reconstructs DB/OS/TOOL dependencies from names. Fourteen independently addressed offline fixtures (eight Python, six Worker) execute the real managed-template parser, revision validator, plan compiler, Worker DAG/stage helpers, registry-selected AI scope, failure-skip and explicit execution policies, plus all three APP scoring and Risk-Control content families. DCNO remains fail-close and no Connector Core, route, Shell or installed-state change is introduced.

# 0.2.73 / sequence 75

Version 0.2.73 / sequence 75 is the Shell 0.4.14 compatibility correction. It removes the undeclared `pythonSidecar.capabilities` property rejected by the installed Feature runtime-contract schema. `python/plan_ir.py` remains a signed package member and the bridge/engine hello handshake still requires all four RPC actions, so no parsing, validation, planning or workbook-compilation capability is removed. No Connector Core or Operation route changes are introduced by this correction.

# 0.2.72 / sequence 74 history

Version 0.2.72 / sequence 74 moves deterministic capability-plan compilation into pure Python `plan_ir.py`. The frozen IR is registry-driven and covers stage nodes, object/content identity, relation type/cardinality/targets, APP dependencies, RAIT strategy/value and local blockers; Worker rejects an absent or digest-drifted plan, then adds only authoritative Remote facts and scheduling. Relation rules and Element-ID description derivations no longer have a second kind switch in Worker.

Local validation now treats Element IDs and canonical GRA names as one namespace, so cross-role collisions block. Registry-driven revision recomputation replaces the inherited RAIT candidate and lineage rather than retaining a stale value. DB/OS retain one-or-more `InfrastructureApplication` sources with any-Higher/all-Lower inheritance; Tool retains exactly one `ItToolApplication`/802 source. `Scoped In?` is executable only when its normalized value equals `Y` exactly.

DCNO remains parsing/local-validation/IR only and `unsupported_pending_official_network_evidence`; it emits no Operation query or intent. This candidate changes no Connector Core route or contract and claims no real Omnia canary.

# 0.2.71 / sequence 73 history

Version 0.2.71 / sequence 73 moves APP/DB/OS/TOOL/DCNO definitions into one signed capability registry and gives Python the authoritative revision-time local-validation operation. DCNO parses into the common IR with type `网络` and governed APP references, but its registry support remains `unsupported_pending_official_network_evidence`; live validation and preparation fail before any Operation query or intent. No OS or other contract is reused.

The parsed `dcnoContract` records the partial live identity (Infrastructure / Network / `通用 DCNO` / `60241274`) and the non-executable Risk-Control evidence boundary. Only mother-workbook rows with `Scoped In? === Y` are retained: Higher `17/05/21/10`, Lower `05/10`; `Y-with judgement` and `N` are excluded. These rows do not create intents while the observed 3 Risk/8 Control directory lacks reconciled Control detail.

DB/OS multi-APP inheritance exposes a structured `inheritanceDecision`. Missing or invalid sources remain blocking. Valid mixed Higher/Lower sources pass `infrastructure_rait` and deterministically produce Higher with the visible explanation `DB/OS 将按 Higher 优先设置为 Higher`.

# 0.2.68 / sequence 70 history

Adds the missing APP-only `IT风险评估（如果测试运行有效性）` category target. It is frozen after GRA identity/state and before Risk Factor scoring, documentation and Evaluation. Signed preflight resolves one exact live category ID from `riskFactorGrouping`; PATCH uses the fixed category route with a live `updatedOn` concurrency test and `/applicable=true`; reconcile repeats the exact Assessment, Workspace, directory and category read-back and must observe `applicable=true`.

DB/OS/Tool are explicit N/A and issue no category Operation. The target uses the existing immutable intent, permit, receipt, progress, uncertain/reconcile, and per-item isolation machinery. The 0.2.67 recovery action remains hidden and disabled; normal upload and existing bounded concurrency are unchanged.

Risk Factor scoring and APP Risk-Control selection now use one governed content-family path for all APP types. Scoring item identities and declared content scopes must agree with the current authoritative APP content and frozen RAIT mode; factor Operations bind and revalidate that content family. Missing or invalid governance fails closed, and no SAP ECC/S/4 name switch or cross-type value fallback remains. The V8 parser retains the complete SAP ECC audit baseline while admitting unique appended governance rows, so exact S/4 HANA values can be supplied by the separately audited v4 recording without another runtime branch.

The Python parser and revision validator project the APP type selector from the signed `P1.APP.GRA.GRA_CONTENT` declaration. `SAP S/4 HANA` shares the 15 APP scoring identities and selects only matching `REL.APP.SAP_S4_HANA.*` relationship rows. Missing relationship governance is blocking and never borrows SAP ECC, SAP HANA, Generic, or a hard-coded remote ID.

# 0.2.67 / sequence 69 history

Pauses legacy recovery at the product Surface so normal uploads remain the only available entry. The declared recovery action is hidden and authoritatively disabled by the Worker; its old Run data, signed receipts, and close audit remain intact. No upload, validation, AI review, Return Operation, safety-lock, or Connector contract changes in this version.

The Shell declarative action contract now supports an optional static `visible:false` flag. Hidden actions and their inputs are omitted from every renderer placement and background scheduler, while backend enablement remains independently enforced.

# 0.2.66 / sequence 68 history

Adds one fail-closed `recover-interrupted-run` action for the narrowly declared 0.2.60 partial-Return recovery contract. Startup asks Core for the unique eligible legacy Run and leaves the action disabled while that real inspection is unavailable, ambiguous, or ineligible. The action repeats inspection, requires explicit user confirmation and current authority, and never replays a mutation.

For the sole Core-authorized submitted/no-receipt GRA create, the Worker performs only the signed GRA preflight and, when present, exact GRA read-back. A non-unique response, Operation error, missing signed recovery receipt, or any uncertain result preserves the old Run. Only a recorded `applied` or `not_applied` outcome permits Core's CAS partial close. The user must then upload a file with changed element names and complete normal validation, preflight, and confirmation; no click, upload, confirmation, or Return is automatic.

There is no cross-generation ownership reuse. Every same-name object remains blocking under the existing current-generation ownership rules. Upload, validation, AI review, progress UI, normal Return command paths, signed Operations, and mutation gates are unchanged.

# 0.2.60 / sequence 62

Hot recovery correction: the Return recovery Surface now stays inside the declared Shell Surface schema, and Connector-reported `REMOTE.MUTATION_UNCERTAIN` is classified as uncertain so it can only continue through signed read-only reconciliation. No new mutation operation or field mapping is introduced.

Risk-Control reconciliation is now a deterministic single signed read. Its v4 settling window is owned by the Feature Worker as at most three read-only calls with one-second bounded delays; no mutation is replayed. All Worker settling delays use an explicit `node:timers/promises` capability instead of an ambient global. Independent GRA lanes use the already-declared hard ceiling of four, while same-GRA, same-APP, dependency, safety-lock and authoritative read-back ordering remain unchanged.

# 0.2.58 / sequence 60 history

Return preparation now carries the immutable APP `rowKey` into its planned-identity index before matching DB/OS inheritance sources. This makes the Return preflight consume the same exact in-batch APP identity that validation already approved, while preserving workspace and element-ID drift checks. No Connector route, mutation Operation, safety-lock rule, or confirmation boundary changed.

# 0.2.57 / sequence 59 history

Python review recomputation now rebuilds the real APP identity index before validating Tool relations, so a workbook containing Tool rows no longer fails with an internal `NameError`. Repeated-label section bands outside governed data-entry ranges are treated as workbook structure instead of fabricated APP/OS rows; incomplete genuine data rows remain visible and blocking.

# 0.2.56 / sequence 58 history

The Tool-APP user column is now bound directly to the existing V8 declaration `P1.TOOL.IT.APPLICATION_RELATION` (`SRC.IT元素.060`, source row 48). No duplicate governance field is added. Worker startup requires that exact V8 identity before reporting ready.

# 0.2.55 / sequence 57 history

The Worker startup inventory now distinguishes the immutable 187-field V8 source from the one signed Feature extension, and requires the exact Tool-APP extension identity before reporting ready. This keeps the V8 source counts unchanged while allowing the versioned V4 input contract to load.

# 0.2.54 / sequence 56 history

Tool now has a versioned required `关联APP系统ID` input backed by the real `ItToolApplication`/802 signed relation contract. The downloadable V4 source template exposes that field. It resolves exactly one same-Workspace in-batch APP and never guesses a target.

DB/OS may reference any positive number of exact in-batch APP IDs. Python freezes every source APP in the inheritance IR and derives `Higher` when any source is Higher; only an all-Lower source set derives `Lower`. Missing, duplicate, cross-Workspace, non-APP or undetermined sources block Return. Worker revalidates and consumes only that frozen IR, emits one InfrastructureApplication relation per APP, and waits for all source APP dependencies.

Return confirmation now freezes `continueOnIsolatedFailure`. When enabled, one failed/uncertain row and its dependent branches are isolated while independent rows continue. Isolated work is never counted as success, uncertain mutation is never replayed, and the final partial result retains item-level evidence and reconcile specifications. Settings can use the first PATCH response's fresh 501 token as a verified fast path, with the prior GET fallback and final reconcile preserved. Risk-Control read-back accepts the v4-recorded scope locations and performs at most three one-second-spaced pure reads without replaying mutation.

# 0.2.53 / sequence 55 history

Generated-Risk identity parsing now recognizes both governed number families: `RAITCOR...` and `RAITTOOL...`. This corrects the real Tool Return failure in which `RAITTOOL001｜...` was compared as an unsplit display name even after Omnia had generated the exact `RAITTOOL001` catalog identity.

Return post-settings work now follows a row-level pipeline. Once one row has completed its signed state/settings work, that row may perform factors/documentation, reach authoritative `EvaluationComplete`, and begin its own generated-Risk classification and Risk-Control association while unrelated rows continue their settings work. The default concurrency remains three with a hard limit of four; every same-row mutation/read-back chain remains serial, and DB/OS still wait for their exact in-batch APP core dependency.

# 0.2.52 / sequence 54 history

Risk-Control command construction now takes the governed risk name, control name and classification from the exact approved immutable target. The live post-evaluation catalog continues to supply only current Risk/Control IDs, scope/assertion identity and concurrency evidence. Core's existing payload-to-intent comparison remains strict and rejects drift before Connector mutation; no route, signed Operation, safety-lock rule or read-back gate changed.

# 0.2.51 / sequence 53 history

The Return executor now uses the v4-proven row dependency shape with a fixed default concurrency of three and a hard ceiling of four. APP object/settings/GRA and state nodes release only their exact same-Workspace dependent DB/OS rows; each row retains the complete serial preflight, mutation, receipt and authoritative read-back chain. Evaluation runs by row and forms a global completion barrier. Post-evaluation work is concurrent only across GRAs; one GRA's generated-Risk classification and Risk-Control associations remain serial.

Concurrent checkpoint writes are queued, resource identities are sorted and reserved, and the first failed or uncertain branch stops new dispatch while already-running branches complete their current receipt chain. Final settlement occurs once with `uncertain > failed > succeeded`. No Surface, Core, Connector, signed Operation, safety-lock, idempotency or reconciliation contract changed.

Same-GRA item/risk lanes are deliberately not enabled. v4 writes Risk Factors and classifications serially; the current factor contract has no independently verifiable concurrency token, classification can legitimately omit its Risk token, and Risk-Control catalog resolution can fall back from a Risk token to the Assessment `updatedOn`. Those shapes cannot prove independent lanes without changing and canary-validating the signed Operation contract. Build, packaging and installation do not claim a real Pack concurrency canary; that status requires the requested live regression.

# 0.2.50 / sequence 52

Added fixed left-rail “重新开始” and “返回上一步” actions backed by real Worker/Core transitions. Validate can return to Upload without replacing the current Run, Artifact or field revisions. An unconsumed waiting confirmation can return to Review only through an atomic Core transaction that invalidates the confirmation and cancels the frozen intents before clearing the plan digest. Restart cancels stable pre-write Runs, preserves terminal command/receipt/evidence audit, and always leaves the next upload to create a new Run. Validation, mutation, verification, reconciliation and uncertain states reject rollback/restart based on durable Run/intent/command/receipt state. No Connector or signed Operation route changed.

# 0.2.49 / sequence 51 history

Corrected the generated-Risk concurrency contract after the real 0.2.48 canary proved that a slim Risk row can omit `updatedOn`. The classification Operation now uses only a Risk-owned `updatedOn/updatedAt` token and follows v4 by omitting the JSON Patch test when that token is absent; it never substitutes the parent Assessment timestamp. Exact Risk identity, signed preflight, user confirmation, `Higher|Lower` mutation and authoritative reconcile remain mandatory. The 0.2.48 receipt-backed live progress and strict APP/DB/OS/Tool managed-create recovery remain unchanged.

# 0.2.47 / sequence 49 history

Return confirmation and continuation no longer detach the serial executor with `setImmediate` after returning the action result. The entire executor is awaited inside the originating `omnia_mutation` invocation, so Worker Store and Connector port calls retain the exact action authorization that passed safety, confirmation and effect gates. Core command validation remains unchanged and fail-closed. The 15-minute mutation deadline, process-interruption classification, durable per-target checkpoints, readback, uncertain handling and continuation semantics remain intact.

# 0.2.41 / sequence 43 history

Return confirmation and continuation now reserve one in-memory execution slot per Worker and return the initial persisted Surface without awaiting the full Return. The background task remains strictly serial, records authoritative Core evidence, and saves the checkpoint after every verified target; concurrent Surface refreshes load current Core Return progress. A Worker restart loses only the in-memory slot: the durable `returning` Run, frozen plan, command evidence, and target progress remain resumable through the existing continuation path without replaying verified targets.

Generated Risk/Control settlement now shares the same explicit 120-second safety horizon as evaluation settlement, with a 40-read ceiling, capped exponential backoff, deterministic jitter, and terminal diagnostics containing elapsed/passive wait, catalog counts, and exact missing relation IDs. Every settling read validates the complete governed relation multiset. Subsequent associations retain a fresh catalog read so updated Risk concurrency tokens remain serially authoritative.

# 0.2.40 / sequence 42 history

Remote Operation target identities now use the current Pack business identity instead of workbook row position. GRA and GRA-scoped targets bind Workspace, element kind, external element ID, derived GRA name, and the applicable field or relation ID, so the same template row in different Runs cannot create a false persistent reservation conflict. Internal Run target keys remain row-scoped.

# 0.2.39 / sequence 41 history

The XLSX reader accepts optional XML namespace prefixes emitted by artifact-tool while retaining unprefixed compatibility. Formula rejection and ZIP safety limits are unchanged. Missing worksheet directories/parts and empty supported parses fail with precise WORKBOOK/PARSER errors before Core field-revision persistence. The unchanged signed Operation inventory is repackaged for the release.

# 0.2.38 / sequence 40 history

Application Documentation now follows the recorded v4 request contract. The mutation Operation performs a fresh authoritative GRA detail read, proves the exact assessment and frozen Workspace, resolves the unique `entityTabTypeId=2` concurrency tab, serializes the RTE value as `{editorData,suggestionsData:[],trackChangesEnableFlagInEditor:false,plainText}`, and sends the recorded four-operation JSON Patch with live `updatedOn` values. Reconcile parses the returned RTE JSON string and verifies editor data, plain text and empty work items. Evaluation submit now sends the recorded `riskLevelOverride:null`.

The complete Risk-Control audit also fixes proven live-shape mismatches. Catalog numbers strip the recorded per-GRA suffix and normalize `SAPECC.nn` to the governed `SAP.nn` identity. Each planned Risk is resolved through its recorded per-risk detail route, which supplies distinct RiskRiskScope, account Risk Scope, assertion type and assertion identities. Association sends the account `riskScopeId`, keeps `assertionType` distinct from `assertions[0].assertion`, and readback verifies the selected Control's exact `currentRiskScopes` entry. As in v4, the authoritative assessment supplies `updatedOn` when the slim Risk row omits it.

# 0.2.37 / sequence 39 history

DB/OS inheritance-source execution now performs its live APP GRA preflight on every continuation to preserve authoritative RAIT derivation, then checks `done(sourceKey)` before any command preparation. A previously verified source intent therefore supplies the live mode without being claimed, read back or projected again. The full target mapping audit also found and corrected one recovery-only projection mismatch: an uncertain Risk-Control command was being projected as a GRA object after successful reconcile; it now projects the exact risk/control IDs as a `risk_control` relation. All other object, GRA, settings, state, element relation, factor, documentation, evaluation and Risk-Control target keys, operation identities, evidence operations, done checks and normal projections are aligned.

# 0.2.36 / sequence 38 history

The Return action's progress map becomes monotonic during one execution. Verified mutation readback, race closure, existing-identity readback and authoritative close update the exact target key only after durable `readback_verified` evidence succeeds.

# 0.2.35 / sequence 37 history

GRA create preflight treats Work Item/common-account directory rows as partial projections. Exact GRA name or explicit entity selects one canonical active assessment GUID; missing directory entity, Workspace and type fields are allowed, while explicit conflicts, missing related assessment GUIDs, multiple assessment GUIDs, ambiguity or recycle state block. The selected detail independently proves all final identity fields.

# 0.2.34 / sequence 36 history

GRA create preflight combines `getWorkitemDetails` and `commonAccounts` by canonical assessment GUID, then reads assessment detail and validates assessment ID, active state, entity candidates, name, Workspace and canonical type.

# 0.2.33 / sequence 35 history

Return execution follows the verified v4 dependency order: object/GRA/element association and EvaluationStarted/RAIT; APP-generic Risk Factor writes/readbacks and documentation; Evaluation submit followed by bounded signed polling to EvaluationComplete for every GRA; generated Risk/Control catalog settlement; then each Risk/Control association and readback. Review defers Risk/Control identity resolution whenever an existing GRA has not reached EvaluationComplete. Existing verified target receipts are skipped during continuation.

The user workflow is now exactly Upload, Validate and Return. Preparing Return no longer creates a Comments card, so the shell cannot switch to Comments; the frozen confirmation remains inside the Return Surface and is bound to the current durable Run and confirmation record. Return hides upload/review actions and generated workbook downloads. Its five category capsules use strictly validated persisted completed/total counts and green fill percentages; internal target IDs and raw backend errors remain in durable logs instead of the user surface.

# 0.2.31 / sequence 33 history

Generic Infrastructure and IT Tool list rows are partial endpoint-scoped projections. A row with an exact identifier and canonical GUID is no longer rejected merely because it omits object type, Workspace, or subtype fields. Explicit list evidence still must agree with the frozen target. Infrastructure subtype evidence recognizes the v4 fields `typeId`, `itElementTypeId`, `subtype`, `infrastructureType`, `databaseType`, and `category` and normalizes DB/OS families. The unique candidate must then pass exact detail GUID, name/number, type/subtype and authoritative Work Item-to-frozen-Workspace proof.

# 0.2.30 / sequence 32 history

Generic DB/OS/Tool identity search now merges duplicate list representations by canonical object GUID. Identical representations no longer manufacture `identifier_ambiguous`; multiple GUIDs, missing canonical GUIDs, field disagreement, and same-GUID active/recycle conflicts still fail closed. A unique active GUID is accepted only after the exact object detail and its unique Work Item-to-frozen-Workspace mapping pass. GRA directory rows are likewise deduplicated by assessment GUID while preserving representation and lifecycle conflicts. Existing exact objects and relationships are reused rather than renamed or recreated.

# 0.2.29 / sequence 31 history

Fixed relationship readback after Omnia successfully committed an association whose search-result row did not contain `workspaceId`. The previous predicate called strict `rowWorkspace` on every association row and failed before it could recognize the exact counterpart ID. Preflight and reconcile now prove source and target Workspace membership independently through signed object-detail plus Work Item Facet mapping routes, validate endpoint types, and then evaluate search rows by exact object ID. Bidirectional Infrastructure/Application consistency remains mandatory. An already committed relationship is recovered read-only and is never replayed.

# 0.2.28 / sequence 30 history

Fixed the local prepare failure `Cannot convert undefined or null to object` for incomplete existing GRAs. The signed state response can omit both RAIT properties; the 0.2.27 preview copied that JavaScript `undefined` into `rowPreview.changes.current`, and strict canonicalization then reached `Object.keys(undefined)`. Missing status/RAIT is now explicit JSON `null`. Deferred previews freeze validated typed desired objects, so optional fallback values cannot introduce another undefined. The post-state catalog wait, completeness rules and execution order remain unchanged.

# 0.2.27 / sequence 29 history

Existing but incomplete GRAs no longer fail prepare because generated Risk/Control or Risk Factor catalogs have not settled. Prepare freezes stable V8 relation IDs, scoring item IDs, documentation and evaluation intent, marks their live identity resolution as post-state, and previews the required state repair. Execution patches and verifies GRA status/RAIT first, then performs four strict catalog reads within the v4 five-second wait budget. All required relations must resolve exactly; no target is skipped. Complete existing GRAs retain prepare-time catalog/readback validation, and frozen live IDs must still match the action-time catalog.

# 0.2.26 / sequence 28 history

V8 relation selection is now subtype-exclusive across APP, DB, OS and Tool; SAP ECC no longer receives Generic APP relations. Risk-Control catalog parsing follows the v4 top-level payload contract and preserves `riskNumber`/`inkRiskNumber`, `controlNumber`, classification, assertion, `updatedOn` and RiskRiskScope identity. Review, execution and mutation-time revalidation resolve by number first and use an exact display-name fallback only when a live row has no number. Structured catalog counts and normalized identity inventories are retained in the Operation response for bounded audit diagnostics. Missing or ambiguous identities continue to fail closed.

# 0.2.25 / sequence 27 history

Risk-Control catalog routes now exactly match the v4 live API: planned responses use `plannedresponse/byRiskAssessmentId?riskAssessmentId={riskAssessmentId}&reviewMode=false`, and controls use `controls/byRiskAssessmentId/{riskAssessmentId}?includeContentDeleted=false`. Both the read-only catalog Operation and the mutation Operation's action-time re-read use these routes. Hidden-data validation, association POST, and exact risk-scope detail readback URLs were rechecked against v4 and remain unchanged.

# 0.2.24 / sequence 26 history

GRA entity proof now selects semantic primary scopes by expected canonical object type and optional content identity before deduplicating GUIDs. Other-type scopes no longer create false conflicts after content generation. Untyped scopes are not guessed; top-level direct IDs still participate and must equal the planned object. Zero candidates retain the strict signed live-directory fallback. APP/DB/OS/TOOL mappings are Application/Infrastructure/Infrastructure/ITTool with governed type IDs 3/4/4/5.

# 0.2.23 / sequence 25 history

GRA identity and reconcile now use a strict current live-directory fallback only when detail exposes zero entity candidates. The fallback row must uniquely and completely match assessment ID, object ID, canonical GRA name, Workspace and canonical object type and must be active/non-ambiguous. Conflicting detail candidates never fall back. Reconcile signs the work-item and common-account directory routes and still verifies detail ID/name/Workspace/type/ink-content. Empty detail RAIT remains incomplete and is not inferred from directory data.

# 0.2.22 / sequence 24 history

Application GRA identity now reads `riskScopes` from a bare array or exactly one allowlisted Newtonsoft/list envelope (`$values`, `results`, `items`, `value`) without recursion. Active entity IDs are deduplicated and absence/conflict fails closed. An otherwise exact existing GRA with empty RAIT returns `exact_existing_incomplete_gra` while freezing the planned RAIT; its existing GRA-state intent must still execute signed PATCH and receipt-backed readback. Non-empty conflicting RAIT remains incompatible.

# 0.2.21 / sequence 23 history

GRA reconcile now matches Omnia's real risk-assessment detail shape. It resolves exactly one active IT Element GUID from supported top-level fields plus `riskScopes`, rejects conflicting identities, requires exact GRA ID/name/Workspace/canonical type/ink-content, and validates the signed query's type ID through `GRA_KIND_CONTRACT` (APP 3, DB/OS 4, TOOL 5) without demanding a non-existent server type-ID echo.

# 0.2.20 / sequence 22 history

GRA intent identity now freezes the real canonical GRA name (`GRA-${elementId}`) instead of the parent IT Element external ID. Preview, create/reuse command binding, signed preflight and final readback therefore compare one exact GRA identity; the parent object remains linked separately by its frozen target key.

# 0.2.19 / sequence 21 history

Application settings now follow the recorded v4 two-stage protocol inside the signed mutation Operation. New-object bootstrap may omit the initial 501 token only for frozen `create_bootstrap`; existing `resume`/`reuse` requires `existing_with_token`. A product-owned incomplete create can use `recover_owned_create_bootstrap` only after Core proves one exact prior create commit under the current Connector/session and authority/Pack/engagement/Workspace, including exact evidence engagement/object/external identity, and a signed live read proves settings/concurrency are still empty. Type/relevance PATCH is followed by an authoritative GET, strict identity/Workspace/type/relevance and unique-latest-token validation, then data-availability PATCH using only that fresh 501 token; outer reconcile retains final field and Workspace verification.

# 0.2.18 / sequence 20 history

Comments now receives a compact user-facing frozen-plan summary instead of internal target, Operation, evidence, and preflight details; the full immutable plan remains durable in Core. Return progress groups real intent states into Element, GRA, Relationship, Risk-Control, and Settings categories. Core command binding treats an exact `resume` object like `reuse` for resolved-object read validation while retaining every target, description, Operation, evidence, and authority constraint.

# 0.2.17 / sequence 19 history

The workflow rail now exposes four real phases: Upload, Validate, Comments review, and Return. Comments review is a status-only host phase because the current declarative workflow contract has no trusted host-tab navigation action; it reports only durable unsubmitted, frozen-awaiting-confirmation, or confirmed state. Return becomes current only after confirmation and continues to reflect real progress, completion, failure, or uncertain read-only reconciliation.

# 0.2.16 / sequence 18 history

Corrective release applying the authoritative Work Item Facet Mapping to APP identity resolution and its action-time create preflight. An active Application is compatible only when its detail supplies one non-zero Work Item GUID whose unique mapping equals the frozen Workspace; the resolved object identity now carries that exact Work Item ID.

# 0.2.15 / sequence 17 history

Corrective release replacing the invalid IT Element detail `workspaceId` read-back with the authoritative Work Item Facet Mapping used by deletion. Object and Application-settings reads require one non-zero Work Item GUID and exactly one mapping to the frozen Workspace; detail identity, type, subtype, external identity, and Application description remain strict.

# 0.2.14 / sequence 16 history

Corrective release aligning Return preparation with the shared Connector binding protocol: `tenantOrOrgId` remains an exact frozen string and participates in scope equality/digests, but may be empty. Non-empty authority instance, Pack, and Engagement identities remain mandatory.

# 0.2.13 / sequence 15 history

Corrective release aligning Review live validation with the signed non-APP object preflight exact schema. DB, OS, and Tool queries now carry the same governed `subtypeId` already used by Return preparation.

# 0.2.12 / sequence 14 history

Immutable successor to 0.2.11 after package-manager startup rejected a literal `+` in the signed route template. The Standardized Accounts List and null release-date query values are now declared string parameters; the Operation handler supplies the frozen values and Operation Host performs the required percent encoding.

# 0.2.11 / sequence 13 history

Corrective release replacing the non-authoritative created-GRA `commonAccounts` lookup in `authority.resolve` with the live `Standardized Accounts List` reference-list publication. Each request and resolved identity carries `elementKind` and object subtype; APP/DB/OS/TOOL select their own exact live category child, so DB and OS cannot cross-resolve through the shared Infrastructure protocol type. Content IDs and IT Element type IDs come only from the live directory; GRA protocol type IDs are Application 3, Infrastructure 4, and ITTool 5. Governance aliases cover Generic, SAP ECC, SQL, UNIX, WIN, Ticketing Tool, and Identity & Access Management Tool values.

# 0.2.10 / sequence 12 history

Source release correcting Omnia/Core GUID validation in the Worker and signed Operation handler. Canonical non-zero 8-4-4-4-12 hexadecimal identities are accepted regardless of RFC UUID version or variant bits; input trimming and lowercase normalization remain in force. This source version has not been packaged, installed, or canary-tested.

# 0.2.9 / sequence 11 history

Immutable successor to the already activated 0.2.8 digest. Unrelated Facets in the Engagement directory are now ignored after object-shape and Engagement validation; strict GUID, uniqueness, name, safety-scope and live-parent checks apply only to the recorded CustomWorkspaceGroup and CustomWorkspace Facet types.

# 0.2.8 / sequence 10 history

Authority resolution moved to the verified `POST /engagements/v1/facets/byEngagementIds` directory used by the safety lock and delete flow. Its activated digest is immutable and is superseded by 0.2.9 because it could reject unrelated Facets before filtering to the two Workspace Facet types.

# 0.2.7 / sequence 9 history

Shell 0.4.12 hot-update builtin release. File selection/drag now stages a real source Artifact and recoverable `acquiring` Run without navigating or parsing. Explicit 确认上传 advances to `processing` and immediately renders a 0/11 running Validate projection; a generic declared background action starts the existing validation only after render and can never be an Omnia mutation. Upload shows only 下载模板 and 确认上传, source/Internal TemplateInstance downloads remain hidden, and step 1 detail is “上传系统信息”. Minimum Shell remains 0.4.9. Real Omnia mutation/readback canary is pending.

# 0.2.6 / sequence 8 history

# 0.2.1 history / sequence 3

Corrective source update with minimum Shell 0.4.6. It preserves the 11-check Review and atomic CAS flow, restores APP/DB/OS/Tool object and GRA Return, uses an object-type-aware create-only permit preflight, enforces relation-before-GRA for DB/OS, reads inherited RAIT from the live APP GRA, and keeps Tool relationship absent because the template has no Tool relation field. External APP, multi-APP and cross-Workspace paths remain fail closed. No real Omnia canary has been performed.

兼容性可见升级：三步工作流、签名 V3 用户模板、真实校验/回传进度、首次真实回传 bootstrap evidence、扁平导航与原位数据升级。状态仍为待首次实机验证。
# 0.2.0 history

Sequence 2 candidate. Automated evidence is distinct from the first live Return and from a subsequently verified scope. A live passed claim exists only after the restricted Core port records a complete receipt-backed Return for the exact scope.
