# 0.2.47 / sequence 49

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

Return execution follows the verified v4 dependency order: object/GRA/element association and EvaluationStarted/RAIT; SAP ECC Risk Factor writes/readbacks and documentation; Evaluation submit followed by bounded signed polling to EvaluationComplete for every GRA; generated Risk/Control catalog settlement; then each Risk/Control association and readback. Review defers Risk/Control identity resolution whenever an existing GRA has not reached EvaluationComplete. Existing verified target receipts are skipped during continuation.

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
