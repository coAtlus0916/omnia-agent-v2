# 技术实现

- Delivery：原生文件选择、问题修订、受权下载。
- Execution：独立 Worker 解析用户 `.xlsx`，从签名包内 V8 编译合同生成运行实例。
- Control/Data：Run/Artifact/Template/field provenance/issue/intent/command/evidence/revision 结构化持久化。
- Integration：Remote-only 签名 Operation，首次远程 action 才延迟注册。
# Technical design

## 0.2.46 authorized Return invocation lifetime

`confirm-return` and `continue-return` await the serial executor before the Worker host emits the action result. Consequently `activeInvocationId` and the Supervisor's `allowMutation` entry remain live for `prepareReturnCommand`, signed mutation Operation calls, evidence, readback and final projection. No capability token is copied into the Worker, and Core does not accept a Feature-authored authorization claim. Mutation timeout or Worker loss still terminates the process tree and invokes the existing durable interruption classifier.

## Shell-owned Factors Considered AI review

The isolated Worker calls only `ai.review` with a bounded `factors_considered_quality/v1` request. PackageManager binds the Run to the active Feature/version and enforces the 1 MiB boundary; ChatService resolves the successfully tested Provider internally and returns a normalized result containing a real review ID, model, usage and capture time. The Worker then validates exact keys, schema, row coverage, assessment enums, limits and concern shapes before persisting the result in the Run checkpoint and projecting warning-only suggestions. Provider configuration, credentials and transport never enter the Worker.

## 0.2.41 live Return progress and catalog settlement history

The Worker reserves a single execution slot before confirm/continue validation can yield. After durable approval it persists `execution.state=running`, obtains the initial Core Return projection, schedules the serial executor, and returns. Receipt-backed completion updates `loadReturnProgress` through the existing evidence port and saves the last verified target/command checkpoint before the next target. Health reads Return progress independently, so Surface refresh is concurrent with Connector waits. The slot prevents duplicate starts in one Worker; after process loss the durable `returning` state, frozen plan, command evidence and verified target map remain the sole recovery authority.

Risk/Control settlement performs an immediate read and then bounded capped-exponential reads with deterministic jitter until the complete required relation multiset resolves, a 120-second deadline is reached, or 40 reads have occurred. Timeout includes exact missing relation IDs and last catalog counts. Associations remain serial and refresh the catalog between relations so mutation-time `updatedOn` concurrency tokens stay authoritative.

## 0.2.40 cross-Run business target identity

Persistent remote target identities are derived from the exact Workspace-bound object/GRA business identity used by preflight and query semantics. GRA-scoped field, documentation, evaluation, risk-factor, Risk-Control and inheritance targets add their stable field or relation identity. Source `rowKey` is retained only for internal Run orchestration.

## 0.2.39 namespace-neutral OOXML input

The bounded XLSX reader accepts optional XML namespace prefixes on supported workbook, relationship, shared-string, worksheet, value, inline-string and formula tags. Unprefixed OOXML remains compatible. Formula rejection and ZIP limits are unchanged. Missing worksheet directories/parts and zero rows/candidates fail with `WORKBOOK.*` or `PARSER.NO_SUPPORTED_ROWS` before `recordFieldRevisions`.

## 0.2.0 durable workflow and provenance notes

- Surface workflow/progress/issues are Worker projections from durable Run/Event/Command/Evidence revision; Renderer does not time or poll progress.
- The source V3 template is a signed `source_template` managed asset. Main resolves only the installed immutable member and rechecks its digest before Save As.
- Picker and drop supply different trusted source refs but enter the same bounded bytes/name/extension/digest/Run/artifact transaction.

- APP `isRelevant=false` is not a Worker constant: it is `rule_default` from signed rule `v8.app-is-relevant-false.v1`, bound to V8 `字段母版` row 9 / `SRC.IT元素.011` and the exact managed V8 digest.
- Save/revalidate compiles a new TemplateInstance, then one Core transaction commits the user revision, every required signed derived revision, provenance, new instance junctions, issues, Run state and Event. Element-ID edits are rejected unless GRA name and APP description (when applicable) advance in that transaction. Old instance junctions keep old revisions.
- `isDataAvailable` is internal governance state, not a V3 user column. New APP rows receive the signed `rule_default=false` with provenance; an existing APP preserves its authoritative current boolean during preview and execution.

## 0.2.1 corrective Review

Local checks are recomputed from active rows while parser-origin structural/unmapped blockers are preserved. The bounded OOXML reader retains worksheet data-validation row ranges, merged-row ranges and the cells whose `cellXf` references a nonzero border. Inside a recognized section, a nonblank row is a data candidate when it falls in a declared input-validation row, populates an input-border cell, or populates at least two declared columns. A single borderless/merged section, title or description band is therefore skipped without matching its text or row number. Once structurally eligible, an empty identity cell or fewer than two populated declared columns emits a deterministic parser-origin blocking issue, so later local recomputation cannot erase the evidence. Generated issues use explicit producer/code provenance and Run-scoped deterministic IDs. DB/OS requires exactly one in-batch, same-Workspace APP edge. Off-batch APP remains blocking. APP/DB/OS/Tool absent identities enter object-type-aware create-only preflight; recycle-bin and ambiguous identities fail closed. Removing a row performs no Connector call and marks relationship validation pending until explicit revalidation.

Live Review and prepare-return call the signed APP resolver or the generic DB/OS/Tool resolver. The resolver grants no mutation permit. Both gates convert every active same-name match into a blocking identity conflict. They may classify an APP `resume|reuse` as an owned recovery only when `proveOwnedCreatedObject` finds exactly one committed Application create under the current Connector/session, Authority, tenant/org, Pack, Engagement and Workspace and proves the exact object ID and external identity; the durable proof identifiers are retained with the live resolution or frozen preparation. Generic DB/OS/Tool active matches have no equivalent released ownership contract and always block. Each DB/OS relationship and inherited-RAIT projection resolves its unique batch APP row back to that row's signed live result. A planned-new APP is reported as a resolvable Application target without claiming that it already exists; an existing/recovery APP whose identity, type, active state, Workspace, RAIT or owned-recovery proof fails makes both dependent checks fail. A separate object-type-aware create-only preflight repeats the bounded proof immediately before creation. DB/OS uses the recorded Infrastructure subtype (`Database` or `OperatingSystem`), writes and verifies InfrastructureApplication in both directions before GRA creation, then derives RAIT from an authoritative read of the unique APP GRA. Tool uses the recorded `ITTool` + `typeId=Tool` contract and has no fabricated relation. Uncertain reconciliation remains read-only and never replays a mutation.

## 0.2.3 navigation, reset, and authority correctness

Surface field removal uses the Shell 0.4.9 generic `clearFields` contract because JSON serialization cannot preserve `undefined`. `back-to-upload` keeps the current editable Run and clears stale Review/Progress fields. `restart-run` is declared with the generic `restart` presentation, transitions only `needs_input|ready_for_review` to `cancelled` through the Core store, records `run.restart_requested`, preserves all audit data, and projects a fresh upload state. Confirmation, returning, uncertain and terminal Runs reject restart. The authority Workspace query uses the v4-verified Facet Type `d0c7e20c-1451-48d2-9dd5-8a6f2a51bfc0`.

## 0.2.6 Review hot update

Renderer treats `back-to-upload` and `revalidate-all` as draft-safe actions. Revalidate submits the current dirty revision batch and the Worker applies the same field/derived-field CAS path used by `apply-revisions` before compiling and committing the full validation result. Other state-changing Review actions remain disabled while drafts exist. Review Surfaces always project `artifacts: []`; the managed TemplateInstance remains persisted internally.

Live validation fails closed before Connector invocation when the binding or explicit Workspace safety scope is absent. All three live checks carry the exact missing-prerequisite reason. When an older durable checkpoint contains pending identity/relationship checks beside a failed Workspace live check, presentation upgrades those pending states to failed with the persisted Workspace reason; it does not invent execution evidence. Once both prerequisites exist, authority, APP identity/recycle and non-APP object preflight continue through the existing signed Operations; no direct passed state and no safety-lock bypass were introduced.

## 0.2.7 staged upload

`stage-source-workbook` verifies the Core-owned descriptor and persists it with an `acquiring` Run without parsing. `confirm-upload` performs the single CAS transition to `processing` and returns a 0/11 running projection immediately. `validate-staged-upload` is a declared `background`/`local_state_write` action; the generic Renderer invokes it once per exact Feature/version/Surface/stateVersion only after rendering, while package validation rejects mutation background actions. `acquiring` is recoverable; later processing stages remain fail-closed and are never replayed.

## 0.2.9 authoritative Workspace directory

`authority.resolve` keeps the mandatory Pack hierarchy and GRA content directory reads, but replaces the legacy menu-section and by-Facet-Type Workspace routes with `POST /engagements/v1/facets/byEngagementIds`. The handler validates the exact binding Engagement on the returned directory and every Facet, admits only the two recorded Custom Workspace Facet types, requires a real live group parent for each live Workspace, and resolves names only against that Workspace collection. Requested names must resolve uniquely and every resolved ID must be present in the explicit safety lock; Workspace names never create or infer Section membership.

## 0.2.10 Omnia/Core GUID contract

Worker response identity extraction and the signed Operation handler now share the Connector origin rule: normalize string input, require the canonical 8-4-4-4-12 hexadecimal shape, reject the all-zero value, and do not constrain RFC UUID version or variant positions. This preserves exact identity comparison while accepting valid Omnia/Core GUIDs that are not RFC-generated UUIDs.

## 0.2.11 authoritative GRA content catalog

`authority.resolve` reads the Engagement-bound `Standardized Accounts List` reference-list publication instead of treating already-created `commonAccounts` as a content catalog. Worker requests and Operation responses carry `elementKind` and object subtype explicitly. The handler resolves the unique top-level content identity and then the exact category child: Application, Infrastructure_Database, Infrastructure_Operating system, or Tool. `inkContentId` and `itElementTypeId` are live keys; GRA `typeId` follows the recorded protocol enum 3/4/5. Alias normalization covers the governed Generic, SAP ECC, SQL/SQL Database, UNIX/Unix, WIN/Windows, Ticketing Tool, and Identity & Access Management Tool values without hardcoding content identities.

## 0.2.12 signed route parameter encoding

The reference-list route template contains only declared placeholders. The handler freezes `catalogType=Standardized Accounts List` and `releaseDate=null` as string step parameters; Operation Host applies `encodeURIComponent` when constructing the request URL. No literal `+` or runtime-supplied transport field remains in the signed template.

## 0.2.14 optional tenant/org binding identity

Return preparation freezes `tenantOrOrgId` with exact string semantics and keeps it in authority equality and credential digests. The shared binding protocol permits an empty value, so only authority instance, Pack, and Engagement identities are non-empty prerequisites; the Worker never invents a tenant/org identity.

## 0.2.15 authoritative IT Element Workspace read-back

Omnia IT Element detail may expose the all-zero `workspaceId`; this is not Workspace authority. Object and Application-settings read paths now extract one non-zero Work Item identity from the exact IT Element detail and resolve its Workspace through the signed read-only `WorkItemFacetMapping/workitem/{workItemId}` route. The mapping must contain exactly one Workspace and it must equal the frozen target. The Operation returns the original detail with the authoritative `workItemId` and `workspaceId`, while retaining strict object ID, type, subtype, external identity, deletion-state, and Application editor-description checks.

## 0.2.16 authoritative APP identity Workspace

APP identity resolution and the APP branch of the action-time create preflight use the same signed Work Item Facet Mapping authority before classifying an active Application as `resume` or `reuse`. Search and detail Workspace fields are not authority. The pruned item and resolved identity carry the exact object Work Item ID and frozen Workspace after a unique mapping is proven.

## Three-phase workflow projection

The workflow projection has three status phases: `upload`, `validate`, and `return`. `waiting_confirmation` stays inside the Return Surface and exposes the real frozen confirmation action there; it does not emit a Comments message card or request host-tab navigation. Return state and progress remain sourced from persisted Return intents, commands, receipts, and read-back evidence.

An exact APP `resume` disposition represents an authority-proven object whose GRA/settings sequence is incomplete. When and only when that object's authoritative settings read returns an unset `isDataAvailable`, the frozen disposition is `resume_unset_default_false`; confirmation-time execution must read it as still unset before PATCHing the governed false value and verifying read-back. `reuse` continues to require an authoritative boolean and fails closed on null.

## In-feature confirmation and grouped progress

The full plan, preflights, target keys, Operation IDs, and evidence arrays remain in the immutable Core plan and intent/command/evidence tables and are not projected to Comments. The Return Surface owns confirmation and groups persisted `returnProgress` rows into Element, GRA, Relationship, Risk-Control, and Settings categories. Each capsule's completed count, total and fill percentage are derived from the underlying intent and command states.

Core command binding handles exact non-GRA object `resume` through the same resolved-object read-query branch as `reuse`. It still requires the frozen resolved object ID, external identity, object type, Application editor description, mutation Operation, evidence Operation array, target identity, approved plan digest, and exact authority scope.

## 0.2.19 v4-compatible Application settings protocol

The frozen settings intent carries exactly one mode. `create_bootstrap` is permitted only for an APP whose object identity disposition was `create` and whose live detail has no 501 token; the first PATCH writes type/relevance and concurrency tab 501 with a JSON Patch `/concurrencyTabUpdatedOn` operation that intentionally has no `value`. `existing_with_token` is limited to `resume|reuse` and requires a unique latest live 501 token for that first PATCH. Both modes then GET the exact object, revalidate identity, authoritative Work Item Facet Mapping, Application type, desired type/relevance, and a unique latest fresh 501 token before the second PATCH writes `isDataAvailable` with that token. No object-level timestamp is accepted. Final reconcile performs another GET and verifies number, type, relevance, data availability, and Workspace.

Core command binding requires the command/query `mode` to equal the immutable settings intent. Ordinary external `resume|reuse` with no live 501 token remains blocked. The only no-token recovery is `recover_owned_create_bootstrap`: Core must find exactly one prior committed object-create command under the current Connector/session, authority, Pack, engagement and Workspace, with an exact evidence engagement/object/external identity match, while the current signed read must still show all Application settings and concurrency tabs empty. Worker never serializes an `updatedOn` token into the plan or command.

## 0.2.20 exact GRA intent identity

The GRA object intent freezes its canonical derived `graName` in `externalId`; it no longer overloads the parent IT Element ID. The parent identity remains an exact target-key reference resolved from receipt-backed projection. Preview displays the same `graName`, create and reuse commands send/read that name, and Core validates both dispositions against the immutable GRA intent before any command can be prepared.

## 0.2.21 authoritative GRA detail shape

The signed readback accepts the recorded Omnia detail contract in which the IT Element identity may be present only in an active `riskScopes[].entityId`. All valid top-level and active-scope candidates are deduplicated and exactly one is required; missing or conflicting identities fail closed. `query.itElementType` must select one unambiguous governed GRA type ID from `GRA_KIND_CONTRACT`: Application/3, Infrastructure/4 (DB and OS), or ITTool/5. The response must return the exact canonical type string, GRA ID, canonical name, Workspace, and `inkContentId`; it need not echo the catalog type ID because Omnia does not return that field.

## 0.2.22 risk-scope envelopes and incomplete RAIT resume

`riskScopes` is parsed only as a bare array or an object containing exactly one array under `$values`, `results`, `items`, or `value`. The parser does not recurse and does not infer arbitrary fields. Deleted or explicitly inactive scopes are ignored; all remaining valid entity GUIDs plus supported top-level candidates are deduplicated and exactly one must remain. APP identity follows v4 resume semantics: an exact GRA with no submitted RAIT is reusable but explicitly incomplete, the returned `resolved.rait` stays bound to the planned value, and the independent GRA-state intent remains responsible for a real PATCH and authoritative readback. Risk-derived inference is not used to pretend RAIT is already submitted.

## 0.2.23 current live-directory fallback

Entity candidate extraction now distinguishes zero, one and conflicting candidates. One candidate is authoritative and must equal the exact IT Element; conflicts fail immediately. Zero candidates may use `applicationGraDirectory`, but only a complete, active and non-conflicting merged row matching assessment ID, object ID, exact GRA name, Workspace and canonical type is accepted. Merge disagreement on those identity fields marks the row ambiguous. GRA reconcile obtains fresh work-item and common-account directory responses through its own signed allowlist and applies the same full match before independently validating the detail response. It never falls back on name alone or historical evidence, and it never takes RAIT from the directory.

## 0.2.24 semantic primary risk scopes

Risk-assessment detail can contain multiple `riskScopes` belonging to different entity kinds. Candidate extraction accepts only active scopes whose normalized `riskScopeType`, `entityType`, or `type` equals the expected canonical object type. If a scope carries `inkContentId` or `contentId`, it must also equal the detail/query content identity. Scopes without type are ignored rather than guessed. Top-level `entityId`/`itElementId`/`applicationId` remain candidates; the combined semantic set is deduplicated and must contain the exact planned object or be empty for the existing directory fallback. Application identity passes Application plus the current object ID and detail content; reconcile passes its signed type/content/entity query. Infrastructure covers both DB and OS, and ITTool covers Tool.

## 0.2.38 recorded Documentation and Evaluation contracts

The v4 recording proves that GRA Documentation is not a nested editor object on the wire. `/documentation` contains a `documentation` JSON string with exactly `editorData`, `suggestionsData`, `trackChangesEnableFlagInEditor`, and `plainText`, plus `workItems:[]`. The same PATCH also replaces root `updatedOn` with the live assessment-tab timestamp and tests both the named assessment tab and root assessment timestamp. The signed mutation Operation therefore rereads the GRA immediately before PATCH, validates assessment/Workspace identity, requires one canonical type-2 tab, and builds all paths and timestamps from that response. Reconcile parses the returned string before exact field comparison.

The recorded Evaluation submit body uses a null override. The Operation now sends that exact value while preserving the recorded false purge/update flags and empty account contents.

The Risk-Control audit covers all recorded 32 generated Control rows and the governed relation targets. Slim catalog numbers include per-GRA suffixes (`RAITCOR001-GRA-*`, `SAPECC.01 - GRA-*`) and slim Risk rows omit `updatedOn`; exact full-string comparison therefore could never resolve a governed relation. Numbers now reduce only those recorded forms, with `SAPECC.nn` mapped to governed `SAP.nn`. The per-risk detail route proves the distinct RiskRiskScope GUID, account Risk Scope GUID, `assertionType` and assertion. Association and readback no longer confuse RiskRiskScope with account Risk Scope or force assertion type to equal assertion. When the slim Risk row omits `updatedOn`, the live root assessment supplies the same fallback used by v4.

## 0.2.37 frozen target mapping audit

The audited target families are object, GRA, APP settings, GRA status, GRA RAIT, Infrastructure/Application relation, inheritance source, SAP ECC Risk Factor, documentation, evaluation and Risk-Control relation. Their target keys, mutation operation identities, evidence operation allowlists, resume checks and normal projections are aligned. Two mismatches were found: inheritance-source lacked a durable done guard, and uncertain Risk-Control reconcile selected the generic GRA object projection.

Inheritance recovery now separates authority from mutation closure. It always reads the source APP GRA and validates the inherited mode, but only calls `closeVerified` and projects when the source target is not already verified. Risk-Control reconcile now uses its frozen preflight risk/control IDs to emit the same managed relation identity as normal execution.

## 0.2.36 execution-local verified progress

`loadReturnProgress` initializes a target-state map once per confirm/continue action. All four successful closure paths now update that map immediately after recording durable verified evidence: mutation race closure, normal mutation readback, existing-identity readback and read-only authoritative close. The update is deliberately after evidence persistence so memory can never claim completion that Core rejected.

This preserves phase-local `done(targetKey)` semantics across the full action. An Infrastructure relationship completed during the early v4 ordering pass is skipped by the later global relation pass, avoiding a second reservation for the same frozen intent. Core remains unchanged and continues to reject any genuine duplicate preparation.

## 0.2.35 partial GRA directory projections

The merged Work Item/common-account directory is an identity index, not final authority. An exact GRA name or explicit entity may select one active canonical assessment GUID even when that row omits object ID, Workspace or object type. Provided values remain constraints: disagreement with the requested entity/name/Workspace/type blocks immediately, as do missing related assessment IDs, multiple assessment GUIDs, ambiguity and recycle state.

The unique assessment detail then independently supplies all final proof. Entity candidates, detail-only Workspace identities, canonical object type, exact name, assessment GUID and deleted state must all agree. No directory fallback can fill a missing detail identity.

## 0.2.34 authoritative GRA preflight recovery

The GRA preflight signs three fixed reads: RiskFactorEvaluation Work Items, common accounts, and the unique assessment detail. Directory representations are merged by assessment GUID through the same canonical GRA directory used by Application identity and reconcile. Exact name or entity relevance prevents an incomplete related row from being mistaken for absence. One complete active candidate must bind assessment ID, entity, name, Workspace and canonical type before detail is read.

Detail validation reuses the strict risk-scope entity candidate parser, Workspace identity aggregation, canonical type normalization and deleted-entity rules. The response returns the authoritative detail only after all identities agree. A true directory miss returns `found=false`; any related ambiguity, recycle state or missing binding throws and cannot grant a GRA create permit.

## 0.2.33 v4 Return dependency phases

Execution is split into dependency phases rather than completing every row independently. Phase one preserves object, GRA, element relationship, EvaluationStarted and RAIT work. Phase two applies and reads back SAP ECC Risk Factors and documentation. Phase three submits every unfinished evaluation and polls its frozen signed read for up to 120 seconds until EvaluationComplete. Phase four waits for generated Risk/Control catalog completeness and performs exact frozen/post-evaluation identity association and readback.

Preparation never requires a generated Risk/Control catalog from a GRA whose evaluation is incomplete. Such targets freeze governed semantic identities under `post_evaluation_catalog`; after EvaluationComplete they resolve against the authoritative generated catalog. Resumption skips verified target receipts. Evaluation timeout retains a serialized read-only reconcile specification and does not replay the committed submit.

## 0.2.31 partial list evidence and authoritative detail

The object kind is frozen by the signed endpoint mapping (`Application`, `Infrastructure`, or `ITTool`). Search rows may omit type, Workspace, and subtype; absence is recorded in bounded field-presence evidence and is deferred to detail. Explicit supported fields are normalized and any disagreement with the frozen query marks the GUID conflicting. Infrastructure subtype evidence follows the v4 field order vocabulary across `typeId`, `itElementTypeId`, `subtype`, `infrastructureType`, `databaseType`, and `category`, normalized to Database or OperatingSystem.

Only a canonical GUID may become a candidate. The sole active candidate is re-read and must prove exact GUID, exact name/number identity, canonical type and governed subtype. Its Work Item Facet mapping must contain exactly the frozen Workspace. Thus partial list projections can recover an existing object without weakening final authority.

## 0.2.30 canonical identity representation merge

Generic object searches can return more than one representation of the same real Omnia object. The Connector Operation groups exact-name candidates by canonical object GUID and merges only representations with one consistent lifecycle state, canonical object type, frozen Workspace, and governed subtype. Identical duplicates do not increase the incomplete count. A missing GUID or key field, multiple GUIDs, active/recycle disagreement, or field disagreement remains ambiguous. The sole active candidate is then re-read from IT Element detail and its Work Item Facet mapping must resolve to exactly the frozen Workspace.

GRA work-item and common-account representations are grouped by assessment GUID. Matching representations form one directory row; lifecycle or identity disagreement marks that GUID ambiguous, and different GUIDs remain multiple candidates.

## 0.2.29 relationship Workspace authority

The Risk-Control catalog and the mutation-time live catalog re-read use the v4 planned-response query route and the control route with `includeContentDeleted=false`. Operation Host substitutes and URL-encodes the GUID placeholder inside the complete query-bearing route template. The remaining v4 endpoints were checked without changing business semantics: hidden-data validation is POST `controls/validateHiddenDataForRiskAssociation` with `riskId`, `operation=AddAssociation`, and `riskClassification`; association is POST `controls/controlrisks/associate`; readback is GET `plannedresponse/GetPlanResponseDetailByRiskRiskScopeId` with `riskriskScopeId`, `reviewMode=false`, `controlExpanded=false`, and `procedureExpanded=false`.

The Worker derives the exact governed relation family from the submitted subtype and the V8 relation ID. Generic, SAP ECC, Oracle, SQL, UNIX, WIN, ticketing and identity-management families are mutually exclusive. The Operation reads only the recorded top-level planned-response/control collections rather than recursively flattening nested scopes. It carries `riskNumber`/`inkRiskNumber`, `controlNumber`, `classificationType`, `updatedOn`, assertion and the v4-priority RiskRiskScope lookup ID into the Worker. Number plus classification is the primary risk identity; control number is the primary control identity. Exact display names are a fallback only for live rows that omit their number.

For an existing GRA whose status or RAIT has not reached the frozen target, prepare does not demand generated catalog identities prematurely. It freezes governed `relationId`, scoring `itemId`, documentation text and evaluation target with `post_state_catalog` resolution mode. Execution completes and reads back status/RAIT first, then reads the full required Risk-Control set up to four times with delays of one, two and two seconds. Catalog completeness is checked against every V8-required relation; timeout is deterministic and names every unresolved relation. A complete existing GRA still resolves and verifies live IDs during prepare. If those frozen IDs change at action time, execution stops before mutation. The live catalog is refreshed between relation commands because one association can advance the risk concurrency token used by the next association; the signed mutation Operation still rereads and verifies that fresh token immediately before each write.

The canonical serializer intentionally rejects JavaScript `undefined`. A live incomplete GRA can omit both RAIT fields, so the preview now maps that authoritative absence to JSON `null`. Deferred previews no longer choose an optional scalar through a fallback chain: Risk-Control freezes relation/risk/control/classification, Risk Factor freezes item/selection mode, documentation freezes plain text, and evaluation freezes its target value. Each typed object is validated as complete before it is included in the preflight digest.

Association search responses do not consistently repeat `workspaceId`. Relation preflight and reconcile therefore read both endpoint details, validate their exact IDs and canonical object types, obtain each Work Item ID, and require each authoritative Work Item Facet mapping to contain exactly the frozen Workspace. Only after both endpoints pass that independent Workspace proof are association results matched by exact counterpart object ID. Infrastructure/Application relationships still require both directional searches to agree; Tool relationships retain their exact signed target type filter. This preserves cross-Workspace rejection without inventing fields on association rows.

The package contains a process-isolated CommonJS Worker, declarative Surface, private migration, managed V8-derived governance IR, signed runtime-template base XLSX, and a signed Operation package. Core passes base64 bytes (64 MiB maximum), never filesystem paths. Runtime output patches only declared OOXML worksheet/core parts and verifies every undeclared part digest.

The governance IR contains 187 fields, 68 relation rules, and 15 scoring items. TemplateVersion semantic identity is stable across Runs; instance semantic/patch/output/governance digests are per Run.
