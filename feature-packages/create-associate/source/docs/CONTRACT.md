# 合同

V8 digest 固定为 `1ED937A50253CEDF431CE02A0CC7A3B3E576597BBD6CAA6C967738D7B2DA4538`；必须是 9/187/68/180/21，SAP Higher/Lower 为 18/17，SAP.03 Higher-only，评分为 15/14/1 N/A。

用户值每条保存 sourceArtifactId/sourceSheet/sourceRow/rowKey/rawFieldKey/canonical field_id/sourceTraceId/valueKind/revision。任一 blocking/error 缺失、冲突、歧义持久化为 `needs_input`。APP/DB/OS/Tool 四种区段都使用真实预检、写入与读回；批外 APP 引用仍明确阻断。

# Contracts

Version 0.2.49 restores the v4 generated-Risk classification stage before Risk-Control association. Every unique governed Risk is a durable field intent with signed preflight, a Risk-owned `updatedOn/updatedAt` concurrency test when Omnia supplies that token, exact `Higher|Lower` PATCH, authoritative reconcile and receipt-backed GRA projection. The parent Assessment timestamp is never substituted for a missing Risk token. Only after all classifications read back exactly does the existing complete relation-multiset gate open. Confirm/continue and every resulting command remain inside one authorized `omnia_mutation` Worker invocation. Core publishes disposable receipt-backed progress projections without changing the authorized Surface or starting a second Worker invocation. Persistent remote identities remain bound to the current Pack's Workspace-scoped business identity. Authority, immutable intent, safety lock, mutation permit, readback and receipt contracts remain fail-closed.

An active APP/DB/OS/Tool identity is recoverable only when Core proves one exact prior committed create under the current Connector/session, Authority, tenant/org, Pack, Engagement and safety-locked Workspace, with exact object ID, external ID and mandatory object type (`Application`, `Infrastructure`, or `ITTool`). DB/OS additionally retain the live exact subtype check. That proof freezes the target as `resume` with its resolved object ID and ownership identity and is repeated before execution; an unowned, ambiguous, recycled, Workspace-drifted, type-drifted or proof-drifted same-name object remains blocking.

Canonical GRA names are `GRA-${elementId}` and participate with element IDs in batch uniqueness checks. DB/OS must reference exactly one in-batch APP in the same normalized Workspace. The InfrastructureApplication relation is written and read from both directions before Infrastructure GRA creation; DB/OS RAIT is then inherited from the exact live APP GRA. Tool has no relationship input in the template, so no Tool relationship is fabricated.

Parser-origin structural/unmapped blockers survive revalidation. Generated issues have explicit producer/code provenance and deterministic IDs scoped by source Run artifact. Every active blocker maps to at least one failed canonical check. APP identity/recycle resolution is a signed read-only Operation and never grants a mutation permit. Only the separate action-time create preflight may grant the one-time object-create permit, and only for a fresh `create` disposition.

Run stages use legal CAS transitions. Field values are classified as `source`, `derived`, `inherited`, `rule_default`, or `user_revision`, with source-specific provenance validation. Mutation permits bind the signed Operation digest, live Connector binding, engagement, exact Workspace scope, target identity, plan digest, and mutation Operation ID.

Signed Operations cover exact IT Element/GRA create and readback, paged/two-sided element relations, GRA state, dynamic Risk Factor spectrum, Application documentation text, Risk-Control validation/write/readback, and Evaluation submit/readback. POST/PATCH commit response loss is uncertain and can only enter read-only reconcile.

Application description is a formally declared V8 derivation (`v8.app-description-from-element-id.v1`) and must equal the canonical element ID. The exact editor JSON is frozen in the intent, sent in create, and compared in signed readback. DB/OS RAIT is written only after its exact APP relation and a receipt-backed live APP RAIT read. Verified current never advances from Worker-authored evidence alone.

Editing an element ID requires one atomic Core commit containing the user revision, signed `GRA-${elementId}` revision and, for APP, description revision. The new TemplateInstance binds all three; omission or forgery rolls the transaction back.

Create/GRA logical identities use a durable authority/tenant/Pack/engagement/Workspace reservation. Only an expired command that is provably still `prepared` with no submit or commit point may be taken over; submitted, committed, completed, or uncertain work is never replayed or automatically released.
