# Signed Operation 0.2.44

Sequence 46 republishes the unchanged signed Operation inventory. Retaining Return execution inside the originating authorized Worker invocation is a Feature Worker orchestration change; no Operation route, permit, readback, or safety contract changed.

小型 object/relation/Risk-Control preflight、单次 mutation 与 read-only reconcile。不接受 Excel，不提供任意 URL/method/body。
# Signed Operation inventory

All routes, methods, body shapes, pagination bounds, query parameters, and readback checks are fixed by the signed handler. Runtime input cannot provide transport fields. Mutation Operations are disabled by default and require a one-time permit issued by the matching read-only preflight for the exact target/Workspace/plan/Operation.

The inventory includes exact APP identity/recycle resolution, generic DB/OS/Tool identity resolution, a distinct object-type-aware create-only permit preflight, Application/Infrastructure/ITTool create/readback, GRA, InfrastructureApplication relationship, GRA state/RAIT, Risk Factor spectrum, Application documentation, Risk-Control association, and Evaluation submit/reconcile. Review identity resolution never grants a mutation permit. The create preflight repeats the bounded authoritative query for the requested object type and throws unless the disposition is exactly `create`.

Documentation mutation contains a signed GET followed by the signed PATCH to the same GRA. The handler proves assessment and Workspace identity, requires exactly one live assessment tab (`entityTabTypeId=2`), serializes the RTE object into the recorded string form, and supplies only concurrency values read in that Operation call. Evaluation submit sends `riskLevelOverride:null`, `isPurgeControlHiddenData:false`, `updateQM:false`, and an empty `accountContents` array.

Risk-Control catalog reads the assessment, slim Risk list, generated Control list, and each exact per-risk planned-response detail. It normalizes only the recorded GRA suffix/SAP ECC number form, and returns separate `riskRiskScopeId`, `riskScopeId`, `assertionType`, `assertion`, and v4-fallback `updatedOn` identities. Mutation rereads those identities before association; reconcile validates the exact selected-Control `currentRiskScopes` entry.

Authority resolution retains the hierarchy read, obtains Workspace membership only from `POST /engagements/v1/facets/byEngagementIds`, and obtains GRA content authority from the Engagement-bound `Standardized Accounts List` reference-list publication. The catalog type and null release-date are frozen handler inputs to declared string route parameters and are encoded only by Operation Host. It validates the exact binding Engagement on the publication, resolved content and selected IT Element category, preserves the real `CustomWorkspaceGroup -> CustomWorkspace.parentId` relationship, rejects missing or ambiguous names, and requires every resolved Workspace ID to remain inside the explicit safety lock.

All Omnia/Core GUID inputs and returned identities use the same acceptance rule as Connector origin parsing: canonical 8-4-4-4-12 hexadecimal text, non-zero, normalized to lowercase, with no RFC UUID version/variant restriction.

Application settings mutation is a fixed signed two-stage route sequence. Bootstrap JSON Patch omits the `value` member for `/concurrencyTabUpdatedOn`; existing settings use the unique latest live 501 token. The Operation GETs after type/relevance, validates exact object/Workspace/type/relevance and a unique latest fresh 501 token, then performs data availability PATCH. Runtime input cannot provide an `updatedOn` value.
