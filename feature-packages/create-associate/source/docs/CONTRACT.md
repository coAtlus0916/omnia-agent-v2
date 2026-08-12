# 合同

## 0.2.104 isolated runtime and exact Oracle contract

The current source boundary is version `0.2.104`, sequence `106`. Its Python sidecar is reachable only through `middle/create-associate-python-bridge.cjs` and `python/create-associate-engine.py`, and its runtime contract declares exactly the 34 Core Store ports actually called by those two modules. Oracle EBS resolves only the exact `Oracle eBusiness Suite` authority identity with recorded key `66176468`, APP category key `66175343`, and content type `3`; its 12 governed relations select 11 Higher and 7 Lower links, keep `OEBS.04` unlinked in both modes, and classify Lower `RAITCOR002`/`RAITCOR011` as `ClassificationNA`.

## 0.2.103 exact closure, receipt and inheritance contract

Every GRA object disposition is exactly `create` or `reuse`; any other value is rejected while freezing the intent and again when preparing its command. Reuse and already-applied read-only closures persist a bounded `noMutation=true` command specification whose `mutationPayload` is the exact prepared read request, so the command request digest remains reproducible. A managed projection must equal the receipt-backed evidence payload and Operation response, not a second Worker-supplied value. DCNO acceptance requires each frozen `inheritance-source` APP GRA readback and rejects missing or additional dependency relations.

## 0.2.102 base-GRA scope and command-spec digest contract

The content-identity requirement applies only to the immutable base GRA object intent (`kind=object`, `objectType=GRA`). GRA state, risk-factor, documentation and evaluation targets retain their own field/documentation/evaluation intent contracts and are not incorrectly required to repeat base content metadata. Live acceptance rehashes the exact frozen mutation/read request from the durable command spec and requires it to match the command request digest before evaluating content identity or read-back evidence.

## 0.2.101 exact GRA content-identity contract

Every Create GRA intent freezes the normalized user-selected content name and the unique authority-resolved `inkContentId/typeId`. The mutation request and reuse read request must match that immutable identity, and a managed GRA projection is accepted only when its receipt-backed authoritative payload returns the same `inkContentId` (or canonical `contentId`). A content-name, identity, command-spec or read-back drift fails before the live acceptance result can pass. Dependency evidence is also type-exact: DB/OS/DCNO use `InfrastructureApplication`, TOOL uses `ItToolApplication`, and DCNO remains an `Infrastructure` object. None of these checks use recording availability as an execution gate.

## 0.2.100 signed action-pending presentation contract

Every action-specific executing title and message is part of the signed `pendingPresentation` declaration, not a Renderer Feature-ID branch. The nested schema is exactly `omnia.declarative-action-pending-presentation/v1` and its `workflowStepId` must resolve to a step in the same signed Surface. Return-layer actions additionally declare `presentation=return`; the generic Renderer uses that value both for Return action filtering and for the durable progress wait boundary. Unknown fields or schema versions, missing workflow targets, and hidden/background pending declarations fail closed during package validation.

## 0.2.98 signed Surface-reopen contract

`surface.lifecycle` contains exactly one `onReopenActionId`. The referenced action must be statically declared, hidden, input/output-free, selection-free, dependency-free, and limited to `read_only` or `local_state_write`; an Omnia mutation lifecycle action is invalid. Shell invokes it only for the same retained Surface instance's `closed → open` transition and uses the current authoritative `stateVersion`. First open, focus and placement changes are not lifecycle events. Create & Associate binds it to `fresh-start-on-reopen`, which shares the explicit fresh-start CAS path and preserves all durable remote/audit evidence. Uncertain/reconciling work is not discarded and remains available for read-only reconciliation. Minimum Shell version is 0.4.15.

## 0.2.97 explicit fresh-start contract

`restart-run` is exposed as `结束旧流程并全新开始` and runs only after an explicit user action. Stable pre-write and terminal states use Core `restartRun` with the exact current revision. Active local processing is first CAS-closed to `cancelled` or `failed` with `run.fresh_start_force_closed`; active Return uses the existing audited `return.force_cancelled` closure. Artifacts, revisions, confirmations, frozen intents, commands, receipts, read-backs and verified remote values remain durable. The contract sets `remoteRollback=false` and `mutationReplay=false`. Any Run or command in uncertain/reconciling state rejects with `RUN.RESTART_RECONCILE_REQUIRED` until read-only reconcile completes.

This is not a window lifecycle contract. Current Shell close/open events are not delivered to Worker, so closing and reopening the Feature cannot automatically trigger the action in a Feature-only package. No automatic behavior is claimed.

## 0.2.95 deterministic Python Return-intent boundary

Every executable Plan row carries `omnia.create-associate.deterministic-return-intents/v1` and a canonical semantic digest. Python is authoritative for deterministic description, Settings, relation targets, scoring inventory, Risk-Control catalog/required links, per-Risk classification including `ClassificationNA`, and documentation values. Middle must reject an absent or drifted digest and must not recompute these business rules during preparation or execution.

The safety boundary is intentionally not a Python API. Python runs isolated with network denied. Core alone owns confirmation, safety-lock scope, Run CAS, immutable command intent, mutation permits, evidence and uncertain reconciliation. Middle may bind live identities and schedule the frozen graph, and the signed Feature Operation may perform transport-specific reads/writes through Connector; neither Python nor Connector owns Feature business policy.

当前受管 V8 digest 固定为 `CB44EE079D045564454F9A11015E6D2F91CF1C663608C9291CD00F0B1CF76F70`；它包含 257 个字段、118 条关系、269 条源追溯、23 条证据和 15 个评分项（Worker 的字段角色追溯计数为 198）。历史 187/68/180/21 仍是不可缩减的审计基线，字段和关系 ID 必须全局唯一。118 条关系的 Higher/Lower 目录存在性一致；`link_required_higher/lower` 是用户维护的执行真值，Risk 在某一模式下零关联时必须明确写 `ClassificationNA`。

Risk-Control 的政策编号/显示名与 Omnia 运行时目录编号是两个字段。`controlName` 保留母版来源和用户可审计语义；`catalogControlNumber` 只接受完整只读目录采样后写入 `risk-control-catalog-identities.json` 的精确编号，并随 Feature 治理一起签名。要求精确目录证据的 family 必须一次提供全部自动关联关系，或者保持 `blocked_*` 且零映射；部分映射、无 evidenceRef/sourceTraceId、同一 relation 重复映射均拒绝打包。Worker 对 required family 不允许产品别名、同序号或翻译文本 fallback。目录非空且指纹连续稳定仍不匹配时属于治理不兼容，不属于继续结算。

SAP S/4 HANA 的目录合同来自 recordingId `34ea8734-0d21-4ef2-88a5-6455ae94b8bd` 的完整冻结流：1587 个连续事件、`complete=true`、`omissionCount=0`、SHA-256 `65fff6c856998e303189a2a35bd59b51754402673887bd8c574015be17edb9d8`。30 个原生 `SAPS4.*`、`SAPCUA.*`、`SAPCHARM.*`、`IMP.*` 身份作为 Higher/Lower 共用目录签名；执行关系按用户母版分别为 Higher 18、Lower 17，不按 `SAP.xx` 序号或中英文描述猜映射。无关联的 RAITCOR007 在两种模式都写 `ClassificationNA`。`isRelevant=true` 仅证明 APP 相关性设置；现场 `linkedAppCount=0`，不得声称建立了 APP-to-APP 关联。

APP 的 `isRelevant` 是 APP capability 的统一设置合同，不是按 Generic、SAP ECC 或 SAP S/4 HANA 分叉的硬编码。计划必须由 `phase1.app-is-relevant-true.v2` 派生 `true`；Operation 只能接受、写入并权威读回 `true`。未来 APP 内容类型只有在登记到同一 APP registry 且具备自己的受管 GRA/Risk-Control 内容证据后，才自动复用这一设置 function。DB、OS、TOOL、DCNO 不执行 APP settings Operation，不能借用这一字段合同。

Version 0.2.74 / sequence 76 requires Python capability-plan IR schema `omnia.create-associate.capability-plan-ir/v1`. It freezes each active row's registry capabilities, stage nodes, relation policy/targets, dependency row keys, RAIT strategy/value, row blocker codes and global blocker codes. Issues scoped only to an excluded row do not become global blockers. Worker must reject an absent or digest-drifted plan before preparing Return; it may add only authoritative Remote identities, permits and scheduling state, and both execution schedulers consume the frozen dependency and stage lists directly. The signed registry is the only source of relation cardinality/type and description derivation rules. The Feature runtime contract remains valid under Shell 0.4.14 and does not add an undeclared `pythonSidecar.capabilities` property.

The current V5 contract signs `Phase1-用户填写模板V5.xlsx` as the sole user source template. Recording coverage, `returnSupport`, and prior canary status are evidence metadata, not execution permissions. Oracle EBS/AD/代码迁移工具 may proceed after ordinary validation; Oracle EBS requests the exact recorded Omnia content name `Oracle eBusiness Suite`, while AD and 代码迁移工具 use their literal input names until an exact alias is declared. The authoritative resolver must return exactly one matching content identity; zero or multiple results fail closed. A content family with no governed Risk-Control links produces no guessed links, while all other validated object/GRA/relation/scoring stages continue normally.

## DCNO 本地合同与 Return 边界

新版 V4 输入中的 DCNO 区段只能由精确表头 `DCNO ID` 识别为独立 `kind=DCNO`，不得按名称猜为 APP、OS 或其他元素。`DCNO ID`、`DCNO 类型`、`Omnia工作区`、`关联系统ID` 均必填；类型当前只允许 `网络`；关系允许一个或多个 APP ID。每个目标必须唯一解析为本批次 APP，或经签名只读 Operation 解析为当前 Pack 中唯一、活动的 Application 及其 GRA/RAIT。跨 Workspace 与批外引用只产生提醒；缺失、重复、歧义、非 APP、未验证或 RAIT 无效仍为 blocking。

DCNO 的当前 signed `kindRegistry.returnSupport=supported`，并沿用参数化 Infrastructure 生命周期：object、relation、GRA、继承 RAIT、Risk-Control 和 Evaluation 可生成计划、intent 与签名 Operation。对象必须是 `Infrastructure`/subtype `Network`，GRA content 是 `60241274`（`通用网络设备`）；关系是一个或多个同 Workspace APP 的 `InfrastructureApplication`，`ConcurrencyTabId=602`。继承 RAIT 固定为 `any_higher_else_all_lower`（任一 Higher 即 Higher，仅全部有效来源 Lower 才 Lower）。DCNO 不执行 APP 专属 `IT风险评估` category/Factors、settings、direct RAIT、APP scoring 或 AI review，但保留 GRA/Risk-Control/Evaluation。

本次 immutable recording 的现场目录为 3 Risk/8 Control。Higher 精确启用 `RAITCOR008 -> DCNO.05/.21` 与 `RAITCOR006 -> DCNO.10` 三条；Lower 启用 `RAITCOR008 -> DCNO.05` 与 `RAITCOR006 -> DCNO.10` 两条。两种模式共享相同精确目录身份；`RAITCOR001` 下 `APP.03`/`APP.06` 仍 disabled，故该 Risk 两种模式都写 `ClassificationNA`。当前证据不宣称真实 Return 已执行或已通过 canary。

Lower 不需要重复录制同一目录；模式差异只由签名母版的 `link_required_lower` 决定。任何零关联 Risk 都不是省略 Operation，而是以 `ClassificationNA` 真实写入并权威回读。

实现只在 Feature 自己的签名 Operation 增加 `Network` 参数，并复用 DB/OS 的参数化 Infrastructure 引擎；Connector Core 仍只承载 Operation、传输、session/gate 和证据边界，未写入 Feature 业务分支。当前状态仅依据上述 immutable recording、只读目录证据和定向离线验证，待主代理完成 candidate 验证后再讨论 live Return canary。

DB/OS 的 `inheritanceDecision` 使用固定策略 `any_higher_else_all_lower`：任一有效来源为 Higher 即为 Higher，只有全部有效来源为 Lower 才为 Lower。Higher/Lower 混合是确定性通过状态并显示“DB/OS 将按 Higher 优先设置为 Higher”；缺失、无效或未通过实时身份/类型/Workspace/RAIT 校验的来源仍阻断。

用户值每条保存 sourceArtifactId/sourceSheet/sourceRow/rowKey/rawFieldKey/canonical field_id/sourceTraceId/valueKind/revision。任一 blocking/error 缺失、冲突、歧义持久化为 `needs_input`。APP/DB/OS/DCNO/Tool 五种区段都使用各自签名 Operation 的真实预检、写入与读回。批外 APP 必须先完成当前 Pack 的精确身份、Application 类型、GRA 与 RAIT 只读验证；通过后仅提醒，不阻断。

# Contracts

## 0.2.68 Application IT Risk Factor category

Every Application row freezes one independent `risk-factor-category|{rowKey}` field intent for the exact category name `IT风险评估（如果测试运行有效性）` and desired `applicable=true`. DB, OS, and Tool rows do not create this intent and never call the category endpoint. The intent is ordered after the exact GRA identity plus status/RAIT read-back and before Risk Factor scoring, documentation, and Evaluation submission.

The signed preflight resolves exactly one category ID only from each current GRA Risk Factor's `riskFactorGrouping`, then validates the Application GRA and Workspace binding and reads `GET /rapr/v0/engagements/{engagementId}/risk-factor-categories/{categoryId}`. Repeated projections of that ID are one identity only when the normalized name matches and any explicit Assessment/Workspace IDs, deletion state and explicit `applicable` state agree; .NET JSON graph markers, timestamps, descriptions and nested collections are non-identity. Mutation uses the same fixed route, a live `updatedOn` concurrency `test`, and `/applicable=true`; reconcile repeats the authoritative GRA/directory/category reads. Missing, ambiguous, cross-GRA, cross-Workspace, stale, unverifiable, deleted, state-conflicting, or non-Application evidence fails closed. A category target cannot be recorded successful until signed read-back returns the exact category with `applicable=true`.

Risk Factor scoring has no SAP ECC or S/4 HANA name branch. The signed mother workbook declares exactly 15 APP-generic `APP.RF.DISPLAY_ORDER_nn` rows under `Application / all APP / GRA / IT风险评估`. Every APP freezes that same inventory and evaluates the signed Higher/Lower applicability rule. Operation resolves each live item by exact display order plus exact governed UI label and derives the requested value from its live spectrum. Missing, malformed, duplicated, label-drifted, or unsupported governance fails before mutation. APP product type affects authoritative GRA content and the exact `REL.APP.<family>.*` Risk-Control selection only.

APP Risk-Control selection uses the same canonical content-family rule against governed `REL.APP.<family>.*` identities. It applies to current and future APP types without a product-name branch, but only when their exact signed mother-workbook rows exist. DB/OS/Tool retain their existing subtype families and are N/A for the APP-only category/scoring stage.

The canonical family comparison is punctuation- and spacing-insensitive only: the Omnia display `SAP S/4 HANA` (including an optional trailing `Application`) and mother-workbook identity `SAP_S4_HANA` resolve to the same family. It never maps one product family to another and never introduces a remote content ID.

## 0.2.67 paused legacy recovery entry

`recover-interrupted-run` remains a declared backend action only to preserve immutable package/recovery compatibility, but its static Surface sets `visible:false` and its Worker projection keeps `enabled:false`. Normal upload must not be gated by recovery eligibility while the entry is paused. Existing recovery records and evidence are not deleted or rewritten.

## 0.2.66 legacy partial-Return recovery contract history

`recover-interrupted-run` is declared as `local_state_write` with exactly `remote_connector` and `safety_lock` dependencies. Its static Surface is disabled. Startup enables it only after Core returns one eligible 0.2.60 legacy Run and the current 0.2.66 Feature has no Run. Invocation repeats the Core inspection before accepting the explicit confirmation toggle.

Core owns eligibility, immutable confirmation, exact old/current Connector and safety bindings, state revision, source Artifact, command ledger, and recovery authorization. The old and current bindings must preserve Connector ID, Authority, tenant/org, Pack, Engagement, and Workspace scope while using different session generations. The Feature accepts at most one required command, and only an exact frozen GRA-create reconcile specification whose signed evidence Operations are the existing GRA preflight and GRA read. `found:false` is `not_applied`; one exact preflight identity plus one exact read-back is `applied`. Any missing, multiple, drifting, unsigned, errored, or uncertain evidence fails closed and cannot close the old Run.

Core must durably record the signed read-only response before its CAS partial close may succeed. Closing preserves verified effects and audit evidence and cancels only remaining frozen intents. It does not create a successor Run or issue cross-generation ownership reuse. The user must upload a file with changed element names and repeat the ordinary validation, preflight, and confirmation flow. Every same-name conflict remains subject to the existing current-generation proof and stays blocking when that proof is absent.

## Tool → APP input contract

`关联APP系统ID` is the versioned Tool input field and maps only to the governed `P1.TOOL.IT.APPLICATION_RELATION` declaration. A Tool row must provide one or more explicit APP IDs. Each ID must resolve uniquely either to an APP row in this upload or to one exact active Application already present in the current Pack. Cross-Workspace and off-batch targets produce warnings after live verification; empty, duplicate, missing, ambiguous, inactive or non-Application targets block. The Worker freezes every `ItToolApplication` source/target identity and its own Workspace, writes each relation with concurrency tab `802`, then performs authoritative two-sided relation read-back. No APP is guessed or inferred.

Version 0.2.54 adds no arbitrary route and weakens no mutation gate. Tool freezes exactly one same-Workspace in-batch APP relation. DB/OS freeze every same-Workspace APP source and the Python-derived any-Higher/all-Lower RAIT result. `continueOnIsolatedFailure` is confirmed and frozen with the Return plan: failure/uncertainty isolates only that row and dependency descendants while independent rows continue; skipped or uncertain targets never count as verified and uncertain mutation is never replayed. The concurrency ceiling remains four. Settings fresh-token fast path and Risk-Control settling are read-back optimizations, not relaxed evidence.

Version 0.2.52 requires every post-state/post-evaluation Risk-Control target's mutation payload `riskName`, `controlName` and classification to equal the exact frozen intent values. A fresh authoritative catalog may resolve only the mutable remote identifiers and current concurrency evidence. The Worker must not reconstruct frozen governed text from a later governance traversal, and Core continues to reject any command whose immutable payload differs.

Version 0.2.51 adds no new mutation route. The Worker may dispatch at most three independent row branches by default, never more than four. DB/OS rows require their exact same-Workspace in-batch APP dependency, and a row retains the complete signed preflight, mutation, receipt and read-back sequence. Evaluation establishes a global completion barrier before post-evaluation work. First failure or uncertainty stops new dispatch; in-flight commands finish their current evidence chain, and Core receives exactly one terminal settlement with `uncertain > failed > succeeded`.

Version 0.2.50 adds two fail-closed navigation contracts. `returnRunToReview` accepts only the exact current `waiting_confirmation` revision with one pending confirmation, frozen intents and no command or receipt; the same transaction invalidates that confirmation, cancels the intents and returns the Run to Review. `restartRun` accepts only stable pre-write or terminal states, rejects active validation/mutation/reconciliation/uncertain states, cancels only pre-write work and never rewrites terminal command/receipt evidence. The existing generated-Risk classification stage remains before Risk-Control association. Every unique governed Risk is a durable field intent with signed preflight, a Risk-owned `updatedOn/updatedAt` concurrency test when Omnia supplies that token, exact `Higher|Lower` PATCH, authoritative reconcile and receipt-backed GRA projection. The parent Assessment timestamp is never substituted for a missing Risk token. Only after all classifications read back exactly does the existing complete relation-multiset gate open. Confirm/continue and every resulting command remain inside one authorized `omnia_mutation` Worker invocation. Core publishes disposable receipt-backed progress projections without changing the authorized Surface or starting a second Worker invocation. Persistent remote identities remain bound to the current Pack's Workspace-scoped business identity. Authority, immutable intent, safety lock, mutation permit, readback and receipt contracts remain fail-closed.

An active APP/DB/OS/Tool identity is recoverable only when Core proves one exact prior committed create under the current Connector/session, Authority, tenant/org, Pack, Engagement and safety-locked Workspace, with exact object ID, external ID and mandatory object type (`Application`, `Infrastructure`, or `ITTool`). DB/OS additionally retain the live exact subtype check. That proof freezes the target as `resume` with its resolved object ID and ownership identity and is repeated before execution; an unowned, ambiguous, recycled, Workspace-drifted, type-drifted or proof-drifted same-name object remains blocking.

Canonical GRA names are `GRA-${elementId}` and share one batch namespace with element IDs: Element↔Element, GRA↔GRA and Element↔another row's GRA collisions all block. DB/OS/DCNO must reference one or more explicit APP IDs; Tool also supports one or more explicit APP IDs. Each target is frozen as either an exact in-batch APP dependency or an exact active current-Pack Application identity. One signed relation per target is written and read from both directions before the source GRA continues. DB/OS/DCNO RAIT is Higher when any verified source is Higher and Lower only when every verified source is Lower; mixed valid RAIT is therefore a warning, not an error. Cross-Workspace and off-batch scope are warnings only after exact verification. Missing, ambiguous, inactive, non-APP or unverified targets still block.

Parser-origin structural/unmapped blockers survive revalidation. Generated issues have explicit producer/code provenance and deterministic IDs scoped by source Run artifact. Every active blocker maps to at least one failed canonical check. APP identity/recycle resolution is a signed read-only Operation and never grants a mutation permit. Only the separate action-time create preflight may grant the one-time object-create permit, and only for a fresh `create` disposition.

Run stages use legal CAS transitions. Field values are classified as `source`, `derived`, `inherited`, `rule_default`, or `user_revision`, with source-specific provenance validation. Mutation permits bind the signed Operation digest, live Connector binding, engagement, exact Workspace scope, target identity, plan digest, and mutation Operation ID.

Signed Operations cover exact IT Element/GRA create and readback, paged/two-sided element relations, GRA state, dynamic Risk Factor spectrum, Application documentation text, Risk-Control validation/write/readback, and Evaluation submit/readback. POST/PATCH commit response loss is uncertain and can only enter read-only reconcile.

Application description is a formally declared V8 derivation (`v8.app-description-from-element-id.v1`) and must equal the canonical element ID. The exact editor JSON is frozen in the intent, sent in create, and compared in signed readback. DB/OS RAIT is written only after its exact APP relation and a receipt-backed live APP RAIT read. Verified current never advances from Worker-authored evidence alone.

Editing an element ID requires one atomic Core commit containing the user revision, signed `GRA-${elementId}` revision and, for APP, description revision. The new TemplateInstance binds all three; omission or forgery rolls the transaction back.

Create/GRA logical identities use a durable authority/tenant/Pack/engagement/Workspace reservation. Only an expired command that is provably still `prepared` with no submit or commit point may be taken over; submitted, committed, completed, or uncertain work is never replayed or automatically released.
