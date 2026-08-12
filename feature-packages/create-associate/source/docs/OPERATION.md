# Signed Operation

## 0.2.104 / sequence 106

The current source keeps one package-level handler for all 37 signed Operations. Oracle EBS authority resolution remains parameterized and exact: alias `Oracle eBusiness Suite`, recorded authority key `66176468`, APP category key `66175343`, and content type `3`; zero or multiple matches fail closed. No Connector route or Feature business branch is added.

## 0.2.74 / sequence 81

Sequence 81 corrects APP category identity resolution without changing any route or Worker orchestration. The Risk Factor directory may repeat the same category projection for many factors and may assign different .NET JSON graph `$id`/`$ref` markers or non-identity nested state to each projection. The resolver deduplicates on the unique category GUID and normalized exact name, while requiring any explicit Assessment/Workspace IDs to match the frozen target, consistent active deletion state and consistent explicit `applicable`. A same-ID identity conflict, multiple IDs, cross-scope evidence or state disagreement fails closed before detail read or mutation.

Sequence 76 changes only Feature plan compilation, scheduling and offline contract fixtures; it adds no Connector Core route, Operation route or DCNO Operation. APP/DB/OS/Tool continue to use the existing signed object/GRA/relation/scoring/Risk-Control/read-back contracts. Relation type and concurrency are frozen from the signed Feature registry: DB/OS use `InfrastructureApplication`/602 for one or more exact APP targets; Tool uses `ItToolApplication`/802 for exactly one. DCNO fails before an Operation query or intent.

Sequence 70 adds three APP-only Operations for the exact `IT风险评估（如果测试运行有效性）` Risk Factor category: permit-granting read-only preflight, disabled-by-default PATCH, and read-only reconcile. Their only new allowlisted mutation route is `PATCH /rapr/v0/engagements/{engagementId}/risk-factor-categories/{categoryId}`. Category identity comes only from a unique live `riskFactorGrouping` in the exact Assessment directory; PATCH uses that category's live `updatedOn` test and `/applicable=true`; reconcile must return the same category ID/name, Application GRA/Workspace binding and `applicable=true`. DB/OS/Tool requests fail the signed contract.

Risk Factor Operations bind each request to canonical `APP.RF.DISPLAY_ORDER_nn`, the governed UI label, frozen `contentName`, and RAIT mode. The handler resolves exactly one live factor only when both display order and label match, then derives Higher/Lower from that factor's live spectrum. Product families share this scoring capability; `contentName` remains a frozen GRA identity and does not select a different scoring matrix. Category verification remains a separate prerequisite owned by Worker.

## 0.2.55 history

Sequence 56 keeps the same signed route inventory and mutation gates. Risk-Control read-back recognizes only the v4-recorded nested/root scope representations and still requires exact control, Risk, scope and assertion identity; it performs at most three pure reads and never replays mutation. Application Settings may take a complete first-PATCH response as the fresh-token fast path, otherwise it falls back to the prior authoritative GET. Final reconcile remains mandatory.

小型 object/relation/Risk-Control preflight、单次 mutation 与 read-only reconcile。不接受 Excel，不提供任意 URL/method/body。
# Signed Operation inventory

All routes, methods, body shapes, pagination bounds, query parameters, and readback checks are fixed by the signed handler. Runtime input cannot provide transport fields. Mutation Operations are disabled by default and require a one-time permit issued by the matching read-only preflight for the exact target/Workspace/plan/Operation.

The inventory includes exact APP identity/recycle resolution, generic DB/OS/Tool identity resolution, a distinct object-type-aware create-only permit preflight, Application/Infrastructure/ITTool create/readback, GRA, InfrastructureApplication relationship, GRA state/RAIT, Risk Factor spectrum, Application documentation, Risk-Control association, and Evaluation submit/reconcile. Review identity resolution never grants a mutation permit. The create preflight repeats the bounded authoritative query for the requested object type and throws unless the disposition is exactly `create`.

Documentation mutation contains a signed GET followed by the signed PATCH to the same GRA. The handler proves assessment and Workspace identity, requires exactly one live assessment tab (`entityTabTypeId=2`), serializes the RTE object into the recorded string form, and supplies only concurrency values read in that Operation call. Evaluation submit sends `riskLevelOverride:null`, `isPurgeControlHiddenData:false`, `updateQM:false`, and an empty `accountContents` array.

Risk-Control catalog reads the assessment, slim Risk list, generated Control list, and each exact per-risk planned-response detail. It normalizes only the recorded GRA suffix/SAP ECC number form, and returns separate `riskRiskScopeId`, `riskScopeId`, `assertionType`, `assertion`, and v4-fallback `updatedOn` identities. Mutation rereads those identities before association; reconcile validates the exact selected-Control `currentRiskScopes` entry.

Authority resolution retains the hierarchy read, obtains Workspace membership only from `POST /engagements/v1/facets/byEngagementIds`, and obtains GRA content authority from the Engagement-bound `Standardized Accounts List` reference-list publication. The catalog type and null release-date are frozen handler inputs to declared string route parameters and are encoded only by Operation Host. It validates the exact binding Engagement on the publication, resolved content and selected IT Element category, preserves the real `CustomWorkspaceGroup -> CustomWorkspace.parentId` relationship, rejects missing or ambiguous names, and requires every resolved Workspace ID to remain inside the explicit safety lock.

All Omnia/Core GUID inputs and returned identities use the same acceptance rule as Connector origin parsing: canonical 8-4-4-4-12 hexadecimal text, non-zero, normalized to lowercase, with no RFC UUID version/variant restriction.

Application settings mutation is a fixed signed two-stage route sequence. Bootstrap JSON Patch omits the `value` member for `/concurrencyTabUpdatedOn`; existing settings use the unique latest live 501 token. The Operation GETs after type/relevance, validates exact object/Workspace/type/relevance and a unique latest fresh 501 token, then performs data availability PATCH. Runtime input cannot provide an `updatedOn` value.
