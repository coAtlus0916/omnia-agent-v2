# Signed Operation 0.2.37

小型 object/relation/Risk-Control preflight、单次 mutation 与 read-only reconcile。不接受 Excel，不提供任意 URL/method/body。
# Signed Operation inventory

All routes, methods, body shapes, pagination bounds, query parameters, and readback checks are fixed by the signed handler. Runtime input cannot provide transport fields. Mutation Operations are disabled by default and require a one-time permit issued by the matching read-only preflight for the exact target/Workspace/plan/Operation.

The inventory includes exact APP identity/recycle resolution, generic DB/OS/Tool identity resolution, a distinct object-type-aware create-only permit preflight, Application/Infrastructure/ITTool create/readback, GRA, InfrastructureApplication relationship, GRA state/RAIT, Risk Factor spectrum, Application documentation, Risk-Control association, and Evaluation submit/reconcile. Review identity resolution never grants a mutation permit. The create preflight repeats the bounded authoritative query for the requested object type and throws unless the disposition is exactly `create`.

Authority resolution retains the hierarchy read, obtains Workspace membership only from `POST /engagements/v1/facets/byEngagementIds`, and obtains GRA content authority from the Engagement-bound `Standardized Accounts List` reference-list publication. The catalog type and null release-date are frozen handler inputs to declared string route parameters and are encoded only by Operation Host. It validates the exact binding Engagement on the publication, resolved content and selected IT Element category, preserves the real `CustomWorkspaceGroup -> CustomWorkspace.parentId` relationship, rejects missing or ambiguous names, and requires every resolved Workspace ID to remain inside the explicit safety lock.

All Omnia/Core GUID inputs and returned identities use the same acceptance rule as Connector origin parsing: canonical 8-4-4-4-12 hexadecimal text, non-zero, normalized to lowercase, with no RFC UUID version/variant restriction.

Application settings mutation is a fixed signed two-stage route sequence. Bootstrap JSON Patch omits the `value` member for `/concurrencyTabUpdatedOn`; existing settings use the unique latest live 501 token. The Operation GETs after type/relevance, validates exact object/Workspace/type/relevance and a unique latest fresh 501 token, then performs data availability PATCH. Runtime input cannot provide an `updatedOn` value.
