# Signed Operation 0.2.1

小型 object/relation/Risk-Control preflight、单次 mutation 与 read-only reconcile。不接受 Excel，不提供任意 URL/method/body。
# Signed Operation inventory

All routes, methods, body shapes, pagination bounds, query parameters, and readback checks are fixed by the signed handler. Runtime input cannot provide transport fields. Mutation Operations are disabled by default and require a one-time permit issued by the matching read-only preflight for the exact target/Workspace/plan/Operation.

The inventory includes exact APP identity/recycle resolution, generic DB/OS/Tool identity resolution, a distinct object-type-aware create-only permit preflight, Application/Infrastructure/ITTool create/readback, GRA, InfrastructureApplication relationship, GRA state/RAIT, Risk Factor spectrum, Application documentation, Risk-Control association, and Evaluation submit/reconcile. Review identity resolution never grants a mutation permit. The create preflight repeats the bounded authoritative query for the requested object type and throws unless the disposition is exactly `create`.
