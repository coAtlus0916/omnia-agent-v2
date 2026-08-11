# Agent 管理内容登记簿

状态：Accepted Direction / Detailed Design Draft  
目的：保存 Agent 创建、修改和删除的业务内容，为后续 Phase 2 及其他 Feature 提供版本化、可追溯的当前数据。

## 1. 定位

Agent Managed Content Registry 位于 Control & Data Plane，是共享后台域服务：

```text
Feature 生成 mutation plan
  → Core 持久化 ManagedContentChange intent
  → Connector 执行 Omnia mutation
  → 写后读回 / reconcile 产生 Evidence
  → Managed Content Service 校验类型 Schema
  → 追加不可变 revision/change
  → 原子推进 Current Projection
  → Phase 2 通过查询合同读取
```

它不是：

- Omnia 的替代数据库；
- 任意 JSON/KV 存储；
- Run/Event/Evidence 的替代品；
- Feature 私有 Store；
- 跳过实时预检的本地缓存；
- Connector 或 Worker 可以直接写入的表。

## 2. 为什么采用“当前投影 + 变更历史”

| 需求 | Current Projection | Immutable Ledger |
|---|---|---|
| Phase 2 快速读取当前 RAIT/Factors 等字段 | 是 | 否 |
| 证明某字段由哪次 Agent 操作产生 | 通过 revision 指针 | 是 |
| 修改前后对比 | 当前值 | 全部 revision |
| 删除后不再作为有效对象返回 | tombstone/默认过滤 | 保存删除原因与 Evidence |
| partial/uncertain 恢复 | 保留最后已验证 current | 保存未解决 change |
| 外部漂移识别 | freshness/drift 状态 | 保存 observation 来源 |

## 3. 数据所有权

| 数据 | Owner | 写入者 | 读取者 |
|---|---|---|---|
| ManagedObject current | Managed Content Service | 仅受控 repository command | 经授权 Feature/后台查询 API |
| ManagedObjectRevision | Managed Content Service | 投影更新器 | 审计、Phase 2、恢复 |
| ManagedRelation/current revision | Managed Content Service | 投影更新器 | 经授权 Feature |
| ManagedContentChange | Managed Content Service | Control Plane 命令编排 | 运维、Feature 状态、审计 |
| 类型 Schema | Domain Schema Registry | 受信发布流程 | Validator/Managed Content Service |
| 原始 Omnia Evidence | Evidence Service | Connector/Command Service | 通过引用访问 |

微内核只提供注册、事务/outbox、权限和查询机制。RAIT、Factors Considered 等域字段由版本化类型 Schema 定义，不能在 Core 通用表中增加按业务场景分支。

## 4. 核心实体

### 4.1 `ManagedObject`

| 字段 | 说明 |
|---|---|
| `managedObjectId` | 本地稳定不透明 ID |
| `entityType/schemaVersion` | 类型和当前业务 Schema |
| `logicalKey` | 当前 authority scope 内跨 Run 稳定逻辑身份 |
| `authorityInstanceId/tenantOrOrgId` | Omnia 权威实例与租户/组织规范 ID；不使用 display name |
| `packId/engagementId/workspaceId` | 规范化业务作用域 ID；不保存 Cookie/Session |
| `externalSystem/entityType/externalId` | 外部系统、实体类型及其不可变 ID |
| `origin` | `agent_created|adopted_on_mutation|external_observed` |
| `lifecycle` | `active|deleted|drifted` |
| `currentRevision` | 最后一次已验证 revision |
| `currentStateDigest` | 最后一次完整验证对象 payload digest；关系独立版本化 |
| `lastVerifiedAt/authorityRevision` | Evidence 读取时间与可选 ETag/revision/watermark |
| `observationCompleteness` | `complete_required_fields|partial_targets|unknown`；对象 current 只允许第一种 |
| `freshnessState` | 查询时依据域 policy 计算的 `verified_current|stale|unknown`，不是永久存储承诺 |
| `createdByRunId/lastChangedByRunId` | 来源链 |
| `deletedAt` | 非删除时为 null |

### 4.2 `ManagedObjectRevision`

不可变保存：

- revision number、schema version 和 normalized payload；
- field-level Patch/diff；
- mutation kind 与 before/after digest；
- Run/Step/Command/Confirmation/Evidence；
- Connector/Operation/version 和读回时间；
- authority instance、租户/Pack/Workspace、外部 revision/watermark 和 observation completeness；
- `source=agent_verified|reconcile_verified|external_observed|adopted_baseline`；
- 业务字段 provenance。

以新建与关联为例，类型 Schema 必须覆盖 Phase 2 需要的 RAIT、Factors Considered、业务唯一 ID、类型/子类型、GRA 身份和关系信息。具体字段名、enum 和保护规则在该 Feature 合同冻结，不在本通用服务中猜测。

### 4.3 `ManagedRelation`

| 字段 | 说明 |
|---|---|
| `managedRelationId/relationType` | 稳定身份与类型 |
| `fromManagedObjectId/toManagedObjectId` | 本地两端 |
| `fromExternalId/toExternalId` | 经读回的外部两端 |
| `direction/schemaVersion` | 明确方向和合同 |
| `lifecycle/currentRevision` | active/deleted/drifted 与 revision |
| `lastVerifiedAt/evidenceId` | 最新验证证据 |

### 4.4 `ManagedContentChange`

| 字段 | 说明 |
|---|---|
| `changeId/idempotencyKey` | 稳定 change 和幂等身份 |
| `kind` | `create|update|delete|reconcile|external_observation` |
| `targetIds` | 带 `kind=object|relation` 的 canonical authority/logical/managed/external identity；首版不接受 field path |
| `expectedBaseRevision` | 防陈旧更新 |
| `plannedPatchDigest/planDigest` | 绑定确认，不存未校验自由文本 |
| `state` | `planned|submitted|verifying|verified|failed|partial|uncertain|closed_not_applied` |
| `effectOutcome` | 与公共 Run/Command 一致 |
| `runId/commandId/evidenceIds` | 完整来源 |
| `projectionAppliedAt` | null 表示尚未推进 current |

## 5. 状态更新规则

### 5.1 创建

1. preflight 后写 `planned` change，不创建 active 对象；
2. Connector 创建并读回；
3. 校验外部 ID、类型、业务字段、RAIT/Factors 和关系；
4. 在一个本地事务中追加 revision、推进 current、关闭 change、写 outbox Event；
5. Phase 2 只能在该事务完成后看到新对象。

### 5.2 修改

1. 查询 current revision，并以 `expectedBaseRevision` 绑定计划；
2. 实时预检 Omnia，发现漂移则旧计划失效；
3. 写后读回成功才保存 after payload；
4. 追加新 revision，旧 revision 永不覆盖；
5. current 原子指向新 revision。

### 5.3 删除

1. 先记录 delete intent 和目标 current revision；
2. Omnia 删除/soft-delete 经读回证明；
3. 追加删除 revision/change；
4. `ManagedObject.lifecycle=deleted`，保存 tombstone、外部 ID、删除时间和 Evidence；
5. 默认 active 查询不返回该对象，但历史、审计和显式 `includeDeleted` 查询可解释原引用。

删除关系先更新对应 `ManagedRelation`；不能只删除对象投影而留下 active 本地关系。

### 5.4 partial、完整快照与 uncertain

- 默认只有完整读取某一实体类型全部 required fields 后，才为该对象生成新的 whole-object current revision；
- partial 可以推进已完整证明的独立对象或独立关系；未证明 target 保留旧 snapshot，并在 change 中列出 unresolved target；
- 首版不支持字段级 current。Patch/diff 仅用于描述两个完整 revision 的差异，不能把本次一个字段与旧 revision 其他字段拼成新 current；
- 若未来确需字段级 current，必须升级 major contract，为每字段保存独立 authority revision/provenance/freshness，并证明未读字段未变化；
- uncertain 永不把计划 payload 写入 current；
- `target` 粒度固定为 whole object 或 whole relation，digest 和 Evidence 均包含该粒度；
- 需要新鲜数据的 Phase 2 查询遇到过期、`freshness=unknown` 或 unresolved change 时失败关闭；
- 新的只读 reconcile 可以幂等推进 current 或关闭 `not_applied`，不得重放 mutation。

## 6. 非 Agent 创建对象的首次管理

修改或删除一个尚未登记的 Omnia 对象时：

1. 实时读取完整受支持字段；
2. 以 `source=adopted_baseline` 建立 baseline revision；
3. 保存 `origin=adopted_on_mutation`；
4. 再执行并记录本次 update/delete；
5. 如果无法取得足够 baseline，不允许生成会使 Phase 2 误解的完整当前投影。

## 7. Phase 2 读取合同

Phase 2 不读数据库文件，只能调用版本化查询：

- 按 scope/entity type/logical key/external ID 查询；
- 默认只返回 active、已验证、schema compatible 的 current；
- 可显式请求 revision、关系或 tombstone；
- 返回 `schemaVersion/currentRevision/currentStateDigest/lastVerifiedAt/freshness/provenance`；
- 调用方声明 `minimumFreshness`、`maxAgeSeconds/asOf` 和所需字段；域 owner 负责给出默认 maxAge，Core 不硬编码业务时长；
- 若 Omnia 支持，返回并比较 authority revision/ETag/watermark；不支持时明确标为 time-based observation；
- 不满足 schema、新鲜度、权限或存在 unresolved change 时返回明确 blocker；
- 需要当前 Omnia 事实的步骤仍通过 Connector 发起实时读取，再由 Managed Content Service 对账。

Phase 2 不得把历史 revision、deleted tombstone 或 `external_observed` 未批准字段自动当作当前 Agent 结论。

`verified_current` 是查询结果：只有 snapshot 完整、未过 `maxAge`、authority/schema/capability 与访问身份仍有效、没有 unresolved change 时才可返回。Session、权限、Pack/Workspace identity 或 authority instance 变化时必须失效；没有实时变更通知时，到期自动降为 stale。

## 8. 身份、唯一性与重生

canonical identity 的唯一索引为：

```text
authorityInstanceId
  + tenantOrOrgId
  + packId
  + workspaceId
  + entityType
  + externalId
```

- `authorityInstanceId` 来自受信环境注册，不能取自用户可编辑名称；
- 允许缺省的 scope 维度由实体类型 Schema 明确，缺少必需维度时拒绝登记；
- Evidence、Session binding、Connector Command 和 Managed identity 必须携带同一 authority identity；
- display name、Connector ID、Session ID、浏览器 profile 和本地路径不得参与唯一性；
- 跨 Workspace 移动、alias/merge、外部 ID 复用与删除后重生不能静默更新旧记录；必须产生 identity transition Evidence，新 incarnation 获得新的 `managedObjectId`；
- v4 importer 在无法证明 authority identity 时只导入只读 legacy Evidence，不合并到 active ledger。

## 9. 一致性与恢复

- mutation intent 在外部 effect 前持久化；
- 外部写入与本地 Store 不存在分布式事务，使用 Command/Evidence + outbox；
- 读回已成功但 projection 写失败时，禁止重放 mutation，后台从 Evidence 幂等重建；
- 此时父 Run 不得为 `succeeded`；使用 `failed + effectOutcome=complete|partial + resolutionRequired=true + MANAGED_CONTENT.PROJECTION_PENDING`，直到 repair 生成独立恢复 Evidence；
- repair queue 使用持久 lease/fencing、唯一 `projectionKey=authorityIdentity+changeId+evidenceDigest`、dead-letter 和人工修复 owner；
- `projectionAppliedAt` 和 current revision 使用 compare-and-swap；
- 重复 Event/change/Evidence digest 不能产生重复 revision；并发 repair 由唯一键和 fencing 拒绝；
- 一致性扫描必须能发现 Evidence 已验证但 projection 缺失、current 指向不存在 revision、悬空 relation 和跨 authority identity 冲突；
- 备份必须同时包含 Managed Content Store、Schema 版本和 Evidence 引用；
- 恢复后先做引用/digest 校验，再允许 Phase 2 查询。

## 10. 安全、隐私与保留

- 只保存后续能力真正需要且类型 Schema 允许的字段；
- 不保存 Cookie、Authorization、任意原始 Omnia response、客户上传全文或 Connector Session；
- 字段按数据分类执行脱敏、导出和权限；
- tombstone 与 ledger 的保留期不能短于其 Run/Evidence 和下游引用；
- “删除 Omnia 元素”不会自动物理删除本地审计历史；
- 物理清理必须检查 Phase 2/其他 Feature 引用，并生成 Evidence。

## 11. 验收矩阵

- [ ] 创建后 current 和 ledger 同时可查，字段与 Omnia 读回一致；
- [ ] RAIT、Factors Considered 和其 schema/provenance 可被 Phase 2 精确读取；
- [ ] 修改产生新 revision，旧 revision 和来源仍可查；
- [ ] 删除更新对象与关系为 tombstone，默认 active 查询不可见；
- [ ] adopted object 建立真实 baseline，不伪造创建历史；
- [ ] failure/partial/uncertain/reconcile 遵守 whole-object/whole-relation Evidence，不能拼接未整体观察的 current；
- [ ] projection 提交失败不触发 Omnia 重放，不显示整体成功，并可从 repair queue 幂等补写；
- [ ] 不同 authority/tenant/Pack/Workspace/type 的相同 external ID 不合并，ID 重生生成新 identity；
- [ ] maxAge/watermark、权限与 Session 失效会使查询失败关闭；
- [ ] 外部漂移被区分为 observation/drift，不冒充 Agent update；
- [ ] Feature A 崩溃/升级不损坏登记簿或阻断无关 Feature；
- [ ] Phase 2 只能走合同 API，无法直连 Store；
- [ ] 备份、恢复、迁移、保留、删除和导出通过真实数据规模演练。

本设计由 [ADR-0024](../adr/0024-agent-managed-content-registry.md) 约束；具体公共对象见[统一合同](../contracts/CONTRACTS.md)。
# Create-and-associate verified-current rule

An intended object, relation, field, score, documentation value, or Risk-Control link is first an immutable intent. Current managed state advances only after the matching signed command has authoritative readback for the exact authority, engagement, Workspace, object identity, and value/multiset. An `uncertain` command creates a read-only reconcile obligation and never an automatic replay.
