# 合同

V8 digest 固定为 `1ED937A50253CEDF431CE02A0CC7A3B3E576597BBD6CAA6C967738D7B2DA4538`；必须是 9/187/68/180/21，SAP Higher/Lower 为 18/17，SAP.03 Higher-only，评分为 15/14/1 N/A。

用户值每条保存 sourceArtifactId/sourceSheet/sourceRow/rowKey/rawFieldKey/canonical field_id/sourceTraceId/valueKind/revision。任一 blocking/error 缺失、冲突、歧义持久化为 `needs_input`。APP/DB/OS/Tool 四种区段都使用真实预检、写入与读回；批外 APP 引用仍明确阻断。

# Contracts

Version 0.2.39 makes supported OOXML element matching namespace-prefix neutral. ZIP bounds and user-formula rejection remain fail-closed. Missing worksheet directories/parts and zero supported rows fail with WORKBOOK/PARSER errors before field revisions are recorded. All identity, authority, mutation, readback and receipt contracts remain unchanged.

Canonical GRA names are `GRA-${elementId}` and participate with element IDs in batch uniqueness checks. DB/OS must reference exactly one in-batch APP in the same normalized Workspace. The InfrastructureApplication relation is written and read from both directions before Infrastructure GRA creation; DB/OS RAIT is then inherited from the exact live APP GRA. Tool has no relationship input in the template, so no Tool relationship is fabricated.

Parser-origin structural/unmapped blockers survive revalidation. Generated issues have explicit producer/code provenance and deterministic IDs scoped by source Run artifact. Every active blocker maps to at least one failed canonical check. APP identity/recycle resolution is a signed read-only Operation and never grants a mutation permit. Only the separate action-time create preflight may grant the one-time object-create permit, and only for a fresh `create` disposition.

Run stages use legal CAS transitions. Field values are classified as `source`, `derived`, `inherited`, `rule_default`, or `user_revision`, with source-specific provenance validation. Mutation permits bind the signed Operation digest, live Connector binding, engagement, exact Workspace scope, target identity, plan digest, and mutation Operation ID.

Signed Operations cover exact IT Element/GRA create and readback, paged/two-sided element relations, GRA state, dynamic Risk Factor spectrum, Application documentation text, Risk-Control validation/write/readback, and Evaluation submit/readback. POST/PATCH commit response loss is uncertain and can only enter read-only reconcile.

Application description is a formally declared V8 derivation (`v8.app-description-from-element-id.v1`) and must equal the canonical element ID. The exact editor JSON is frozen in the intent, sent in create, and compared in signed readback. DB/OS RAIT is written only after its exact APP relation and a receipt-backed live APP RAIT read. Verified current never advances from Worker-authored evidence alone.

Editing an element ID requires one atomic Core commit containing the user revision, signed `GRA-${elementId}` revision and, for APP, description revision. The new TemplateInstance binds all three; omission or forgery rolls the transaction back.

Create/GRA logical identities use a durable authority/tenant/Pack/engagement/Workspace reservation. Only an expired command that is provably still `prepared` with no submit or commit point may be taken over; submitted, committed, completed, or uncertain work is never replayed or automatically released.
