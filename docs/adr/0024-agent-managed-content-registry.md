# ADR-0024：后台保存 Agent 管理内容的当前投影与不可变变更登记

状态：Accepted  
日期：2026-07-30  
决策来源：用户产品决策  
Refines：ADR-0002 的后台唯一事实；ADR-0018 的新建与关联；首批删除元素设计

## Context

v4 没有完整保存“Agent 创建、修改或删除了哪些业务内容，以及这些内容当前是什么状态”。这会造成后续阶段只能重新解析历史文件、扫描日志或再次从 Omnia 猜测上下文。

用户要求 v5 在后台新增此能力。例如 Agent 新建元素时写入了 RAIT 和 Factors Considered，后台必须保存这些经验证的业务字段；后续 Phase 2 可以通过稳定合同读取。Agent 修改或删除元素后，后台记录也必须同步调整。

只保存操作日志不够：Phase 2 需要高效读取当前有效数据。只覆盖一份当前记录也不够：修改、删除、部分成功和 `uncertain` 会失去审计与恢复依据。

## Decision

1. Control & Data Plane 新增 **Agent Managed Content Registry（Agent 管理内容登记簿）**。它是独立后台数据域和服务，不属于任一 Feature 私有 Store，也不把业务字段塞入微内核通用 Run 表。
2. 采用“双层模型”：
   - **Current Projection**：每个受管对象/关系最后一次完整验证快照，供 Phase 2 等后续 Feature 按新鲜度策略查询；“最后验证”不等于无限期实时；
   - **Immutable Change Ledger**：create/update/delete/reconcile/external drift 的不可变变更记录，绑定 Run、Command 和 Evidence。
3. 每个受管对象至少保存：
   - `managedObjectId/entityType/schemaVersion`；
   - Omnia authority instance、租户/组织、Pack、Workspace、实体类型和不可变外部 ID 组成的规范外部身份；
   - 稳定 logical key；
   - `lifecycle/currentRevision/currentStateDigest`；
   - 经类型 Schema 验证的业务字段；
   - `sourceRunId/sourceCommandId/evidenceId`；
   - `lastVerifiedAt/authorityRevision/observationCompleteness`；`freshness` 在查询时依据 maxAge/watermark/失效事件判定。
4. 类型化业务字段必须真实保留。新建与关联场景至少要能保存已批准合同中的 RAIT、Factors Considered、对象类型、业务 ID、Workspace、GRA 身份和关系端点。确切字段名、enum 和必填规则由对应 Feature/域 Schema 冻结；不得用未校验任意 JSON 或日志文本代替。
5. 关系是一等记录，不藏在对象自由文本中。`ManagedRelation` 保存关系类型、方向、两端 `managedObjectId/externalId`、生命周期、revision 和读回 Evidence。
6. 所有 Agent 发起的 mutation 在执行前先创建 `ManagedContentChange` intent，但 **intent 不改变 Current Projection**。只有 Omnia 写后读回或只读 reconcile 证明后才提交当前状态：
   - create verified：建立 active 对象/关系和 revision；
   - update verified：追加 revision，原子推进 current revision；
   - delete verified：追加删除 change，把当前投影改为 tombstone/deleted，不物理抹除身份和历史；
   - explicit failure before effect：关闭 change，不改变 current；
   - partial：只提交已完整读回证明的独立对象或独立关系；默认不做字段级 current 拼接，其余保持旧 snapshot 并记录缺口；
   - uncertain：保留上一份已验证 current，另记 unresolved change 和 `freshness=unknown`，禁止把计划值当成当前值；
   - reconcile：依据新的只读 Evidence 完成、部分完成或关闭未应用 change。
7. Agent 修改或删除原本不是由 Agent 创建的 Omnia 对象时，后台仍建立受管身份和基线 revision，`origin=adopted_on_mutation`，再记录本次变化；不能因为本地没有旧记录就跳过。
8. Omnia 仍是远端对象的外部权威来源。登记簿是 Agent 已验证管理事实和可消费投影，不替代危险操作的实时预检。发现 Omnia 外部修改时记录 `external_observed` revision 或 `drifted`，不能伪装成 Agent 修改。
9. Phase 2 和其他 Feature 只能通过版本化 `ManagedContentQuery`/Artifact 合同读取，不得直连 Store。查询必须声明 `maxAge/asOf`（或由域 policy 给出），并返回 schema version、freshness、last verified time、authority revision/watermark、observation completeness 和 tombstone 状态；要求实时性或将产生危险 effect 的步骤仍需 Connector 读回。
10. 写入权限只属于 Managed Content Service。Feature Worker、Shell 和 Connector 不能直接修改登记簿；Control Plane 根据持久 Command/Event/Evidence 调用受控 repository command。
11. 外部 mutation 已验证但本地投影提交失败时，不重放 Omnia mutation。Run 不得显示 `succeeded`；它进入 `failed + effectOutcome=complete|partial + resolutionRequired=true`（或未来合同明确的等价非成功恢复状态），错误为 `MANAGED_CONTENT.PROJECTION_PENDING`。持久 repair outbox 从不可变 Evidence 幂等补写登记簿，完成后生成独立恢复 Evidence。
12. 远端删除不等于本地物理删除。tombstone、revision 和变更历史至少随其 Run/Evidence 与下游引用保留；最终保留期限、导出和物理清理由数据治理 ADR 决定。
13. 外部身份唯一键至少包含 `authorityInstanceId/tenantOrOrgId/packId/workspaceId/entityType/externalId`。缺省维度、跨 Workspace 移动、alias/merge、外部 ID 复用和删除后重生必须由域合同明确；display name、Session ID 或 Connector ID 不参与身份。
14. `verified_current` 只能表示“对本次查询的 freshness policy 仍满足”，不是持久不失效标签。Session、authority/schema/capability、访问权或 Pack/Workspace identity 变化时，相关 snapshot 至少降为 `unknown`，直至重新授权和读取。

## Consequences

- Phase 2 可以直接读取规范、可追溯的当前对象数据，例如经验证的 RAIT 与 Factors Considered，而不必重放 Phase 1 或解析日志。
- 创建、修改、删除和部分成功的本地状态保持一致，且每次变化都有来源、authority identity、完整度和 Evidence。
- 后台新增 Managed Content Service/Store、类型 Schema Registry、投影更新器、漂移/reconcile 和保留职责。
- 首批“新建与关联”和“删除元素”的验收范围扩大：Omnia 读回成功还不够，登记簿 current/ledger 也必须提交并能重启恢复。
- 数据重复存储增加容量和治理成本，但换来后续阶段稳定查询、审计与增量处理。

## Alternatives

### 只保存 Run/Event/Evidence

可以审计操作，但 Phase 2 每次都要重建当前状态，查询慢且容易产生语义差异。

### 只保存当前对象 JSON

无法证明字段来自哪次写入，也无法可靠处理修改、删除、partial、uncertain 和外部漂移。

### 每个 Feature 保存自己的对象副本

新建、修改、删除和 Phase 2 会形成多个 owner 与漂移，违反共享业务数据只有一个 owner 的原则。

## Verification

- [ ] create 写后读回成功后，对象/关系、RAIT 和 Factors Considered 可按精确 revision 查询；
- [ ] update 追加 revision，旧 revision 不变，current 指向新已验证版本；
- [ ] delete 产生 tombstone，默认查询不返回 active，历史 Run/Phase 2 引用仍可解释；
- [ ] 对非 Agent 创建对象的首次修改/删除建立 adopted baseline；
- [ ] explicit failure 不改变 current；partial 只按完整对象/完整关系推进，不合成从未整体观察的对象；
- [ ] uncertain 不写计划值，保留旧 current 并阻断要求新鲜数据的 Phase 2 步骤；
- [ ] reconcile 幂等关闭或提交 change，不重放原 mutation；
- [ ] Omnia 外部漂移不会被记成 Agent 修改；
- [ ] Feature Worker/Connector/Delivery 无法直写 Store，Phase 2 无法直连数据库；
- [ ] Core 重启、Feature 升级和 Store 恢复后 current/ledger/Evidence 引用一致；
- [ ] 同 external ID 在不同 authority/tenant/Pack/Workspace/type 下不会合并；ID 重生和 alias/merge 按合同处理；
- [ ] 查询 maxAge/watermark 超限或访问身份变化时失败关闭，旧 snapshot 不继续声称 verified current；
- [ ] 外部 effect 已验证但 projection pending 时 UI 不显示整体成功，repair 重放不产生重复 revision；
- [ ] 受管内容 schema、保留、导出和敏感信息门禁通过。
