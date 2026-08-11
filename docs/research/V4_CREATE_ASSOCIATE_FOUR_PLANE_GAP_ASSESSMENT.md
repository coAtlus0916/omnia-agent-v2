# v4 “新建并关联”四 Plane 审计与 v5 可迁移边界

> 审计范围：v4 `omnia-agent-v4` 的新建/关联执行链、v5 当前架构/契约/Recording 0.1.0、Sol master workbook 的只读 inspect artifact。本文是研究与落地顺序，不是产品实现承诺；未读取旧 Luna workbook。本文只评估，不修改产品代码或母 workbook。

> 当前状态（2026-08-03，取代下方历史开篇评估）：`omnia.create-associate@0.1.0` 是 Remote-only 签名自动化候选。Local/Remote parity 已废弃，没有 Local fallback。生产 Return 仍受实时 canonical authority identity 完整性和真实 Omnia mutation/readback canary 门槛阻断。下方旧缺口表仅作迁移历史保留。

## 0. 先给结论

v4 已经证明了不少“业务细节”：四类 IT Element 的解析、DB/OS 从 Application 继承 RAIT、精确 Workspace/Engagement/对象匹配、Infrastructure→Application 与可选 Tool 关系、GRA 风险/控制的查询与读回、部分失败/不确定状态，以及有限并发批量执行。这些可以作为 v5 的证据种子（不是可直接复制的运行时）。

v5 的正确升级路径是把 v4 的业务规则拆进四 Plane：Delivery 只负责上传、交付与人工确认；Execution 负责解析后的规范化、默认/继承/校验、plan/patch；Control & Data 负责版本化的 Template/Run/Managed Content current+revision+change+tombstone+relation；Integration/Connector 只负责真实 Omnia 的签名 Operation、gate、session/transport、幂等、读回与 reconcile。v4 的 Excel 运行时、硬编码 API/Tab/类型常量、Creator 内部多步 orchestration、以及“能查到 catalog 就可关联”的隐含规则均不能直接迁移。

当前真正的阻塞不是再写一个假入口，而是：发布并批准官方 `TemplateVersion`、锁定同一非生产 Engagement/Pack/Section/Workspace、录制并确认 APP/DB/GRA 的真实 create/readback 契约、决定第一 canary 是否包含 Risk/Control 后处理，并让 Local/Remote 具备同一命令/plan/evidence 语义。Recording 0.1.0 只能读当前 GRA/Risk/Control catalog，`linkRequired` 仍为 `null`；Remote 0.3.4 已上线 discovery、status/light-read、recording 与签名 Operation register/invoke 传输，但尚未通过真实 Omnia 业务 mutation canary，因此仍不能宣称 create/associate 可用。

## 1. 证据状态与方法

| 标记 | 含义 |
|---|---|
| `[V4-verified]` | 在 v4 源码/测试中有可定位实现或断言。 |
| `[V5-implemented]` | 在 v5 当前源码/正式文档中已有实现，仍需真实 Omnia canary 才能闭环。 |
| `[Design]` | v5 架构/ADR/数据契约已定义，但实现或业务批准未完成。 |
| `[Pending]` | 当前明确未具备、需产品/用户/外部 Omnia 决策。 |
| `[Canary]` | 只允许在真实、非生产 Omnia 上验证；fixture/mock 不计入通过。 |

检查方式：读取 v5 `docs/architecture/*`、`docs/adr/*`、`docs/data/*`、Feature/Connector/Remote/DB 源码、Recording 0.1.0 包文档与 worker；读取 Sol master workbook 的 `omnia-agent-phase1-master-v4-based.xlsx.inspect.ndjson`（7 个 sheet、范围和摘要），并对照 v4 `toolkit/tools/gra-creator/src/*`、`src/omnia-phase1*`、`connector/src/*`、`src/server.js` 与测试。未改变以上输入。

## A. v4 业务链、数据所有权与四 Plane 归属

### A.1 v4 实际链路

1. **Delivery/旧前端**：`src/omnia-phase1.js` 接收 Excel 上传，允许用户修订 draft 行，兼容 legacy 五列与 V2 分 Sheet；`src/server.js` 负责上传隔离、解析、预览、移除/编辑、审核、保存 verified rows。
2. **Execution/旧中间层**：`readPlanFromExcel` 和 V2 parser 把行映射为 APP/DB/OS/Tool/GRA/relationship；默认、必填、枚举、公式和 DB/OS RAIT 继承在解析时发生；`validatePhase1ScopedPlans`、`validateV2Rows`、`normalizeV2Relationships`、Factors 检查决定是否可 dispatch。
3. **Control & Data/旧持久化**：workflow revision/digest、draft/verified rows、evidence、run 状态分散在 server/SQLite；没有 v5 语义完整的 Managed Content current/revision/ledger/tombstone projection。
4. **Integration/旧 Connector + Creator**：`omnia-gateway.js` 处理 session、pack、精确 workspace/对象发现、allowlist、预读/POST/PATCH、两面关联与读回；`gra-creator/src/app.js` 又持有类型常量、risk/control mapping、业务编排、重试/批量并发和终态组合，形成跨 Plane 耦合。
5. **执行顺序**：先按依赖图创建/复用/恢复 IT Element，再 patch settings，建 GRA、生成/发现 Risk/Control、关联 Infrastructure→APP，最后可选 Tool；延迟关联与风险/控制后处理可能产生 warning、`created_with_errors` 或 `uncertain`。

### A.2 v5 四 Plane 的所有权边界

| Plane | 必须拥有 | 必须禁止 | 与 v4 的对应 |
|---|---|---|---|
| Delivery | 导航、上传/quarantine、交付状态、字段缺口展示、review/confirm、下载证据 | 解析、AI、数据库写入、Omnia HTTP/业务编排 | `server.js` 上传/预览可拆；不得保留运行时 Excel 编辑作为母 workbook 真值 |
| Execution | NormalizedInput、默认/枚举/required/derived/inherited/fallback、规则与依赖图、plan/patch、digest、验证报告 | 直接访问 Core DB/Managed Store、secret、任意 Omnia、重试外部 mutation | `readPlanFromExcel`、`validateV2Rows` 等规则可迁移为纯 worker/domain library |
| Control & Data | Template/Scenario/Run/Event、Artifact/Evidence、Managed Content current/revision/change/tombstone/relation、审计与 projection outbox/CAS | 业务算法、直接调用 Omnia、把缓存当 truth | v4 workflow/evidence 可作迁移输入；现有 v5 DB 仍需补全 registry 语义 |
| Integration | ConnectorTransport、Session、Gate、签名 Operation、binding、lease、idempotency、uncertain/reconcile、精确 readback | 业务多步 `executePhase1`、Excel 解析/规则、任意 URL/自创 tab 常量 | v4 gateway 的 allowlist/精确匹配/双面读回可抽象；Creator 编排必须上移 Execution |

统一入口应是 `upload → parse/normalize → validate → plan → review → confirm → command/gate → signed Operation(s) → readback/reconcile → Managed Content commit → evidence/export`。外部读回未证明前，Managed Content current 不得前进；不确定不能自动重放。

## B. v4 可复用项、错误层次与不可直接迁移项

### B.1 可复用的业务证据

- V2 支持 `APP/DB/OS/Tool` subtype、workspace、GRA/RAIT/Factors 和 relationship；未知 subtype、缺 APP、跨类型关系会 fail closed。[V4-verified]
- DB/OS 的有效 RAIT 必须从一个或多个 APP 继承，所有 APP 必须存在且同值；冲突、缺失、external APP 无 live exact proof 即阻止。[V4-verified]
- Infrastructure→Application 是核心关系：先查两边、POST 后双向读回；Tool 关系是可选，目标不可用时核心对象仍可完成并给出 warning。[V4-verified]
- 目标识别按 Engagement/Pack/Section/Workspace/对象 ID 或精确名称与 active/recycle 状态，拒绝跨 engagement、关闭对象、歧义；禁止“差不多名称”推断。[V4-verified]
- GRA 创建采用依赖图、有限重试、读回、幂等检查、部分/不确定终态；生成 Risk/Control 需等待并严格匹配编号/标题。[V4-verified]
- V4 测试覆盖 parser、external APP/Tool、scoped plans、pre-dispatch retry、eventual consistency、exact target 和双向关系读回，适合作为 v5 contract/regression seed。[V4-verified]

### B.2 必须换层的实现

| v4 做法 | 问题 | v5 安置 |
|---|---|---|
| `gra-creator/src/app.js` 中 `GRA_TYPE_CONFIGS`、risk/control IDs、tabs 601/602/802/803、API path/body 常量 | 业务契约与 transport、页面细节、并发编排混在一文件，升级只能改 Creator | 业务 subtype/字段/关系 schema 属 Template/Execution；route/tab/body 属签名 Operation manifest；Gate 只复核安全条件 |
| ExcelJS `readPlanFromExcel` 直接构造运行 plan，且 `src/omnia-phase1.js` 允许修改上传行 | 把交付格式当 runtime truth；人工编辑绕过版本/审批/来源 | Delivery 只交付文件；Quarantine parser 产出 NormalizedInput + provenance；母 workbook 只发布不可变 TemplateVersion |
| Creator 内部 `runBatch` 先建后延迟关联、自动重试和终态拼接 | 事务边界、幂等、读回、uncertain 不能被统一审计；跨步骤 replay 风险 | Execution 产出可审计 step plan/PatchSet；每步由 Connector command+Operation 执行，Control 写 intent/evidence，读回后 commit |
| `catalog` 缺失/发现即按默认风险控制继续 | `catalog_present_*` 只是“可见性”，不是是否需 link 的业务 gate | workbook/normalized schema 同时保留 `catalog_present_higher/lower` 与 `link_required_higher/lower`；`link_required` 缺失/冲突 fail closed |
| 失败后局部清理、重新 POST 或根据异常猜测已应用 | 会重复创建/关系或把未知状态当失败 | Gate 用 commandId/idempotencyKey/planDigest/concurrency；unknown 只进入 read-only reconcile，不 replay |

### B.3 不能直接迁移的内容

1. v4 的母 Excel、运行时手填值、draft 编辑、固定五列 legacy 解析不能成为 v5 runtime 或默认文档。
2. `GRA_TYPE_CONFIGS`、硬编码 risk/control reference、tabs、DOM/selector、ConcurrencyTabId、path/body/headers 不能复制到前端或通用 Core；必须由批准的 TemplateVersion + signed Operation manifest 提供并版本化。
3. `executePhase1(plan)`/`executeCreateAndAssociate(workbook)` 这种跨 Plane 大函数、任意 `fetch`、Creator 内隐式重试/多步业务不能进入 Connector Core。
4. v4 `linkRequired`/默认 RAIT/Factors 的缺省值若没有当前 Recording/产品批准，不能“沿用 v4 经验”自动填入。
5. v4 的本地 session、旧 endpoint allowlist、页面 tab 选择、DOM fallback 不等于 v5 Remote/Local parity 或生产契约；真实 Omnia 登录、非生产 canary、读回证据必须重新验证。

## C. v5 四模块就绪度与缺口

### C.1 模块/Plane 就绪矩阵

| 模块 | 当前已具备 | 关键缺口 | 可验收条件 |
|---|---|---|---|
| Delivery（上传/交付） | Recording worker 有 start/stop/export/cancel/catalog；Template pipeline 有 quarantine/sandbox、digest、provenance；Create/Associate Feature DoR 明确 upload-only | 官方 default document/TemplateVersion 未发布；缺少四类型 create/associate upload contract、UI 字段缺口与 review/confirmation 交付闭环 | 对同一 TemplateVersion 解析一次得到固定 inputRevision；缺值显示 `missing/conflicting/not_evaluable`，不暗填运行值；确认绑定 planDigest |
| Execution（解析/标准化/计划） | v5 架构已规定 parse→normalize→validate→plan；workbook inspect 有 183 normalized fields、68 relation rows、枚举和 source trace | 仍无 create/associate worker/package；未将 v4 规则拆纯函数；未形成 deterministic default/derived/inherited/fallback、patch 集与 plan schema | APP/DB canary 输入能编译同一 plan/digest；DB/OS RAIT inheritance、Factors/required/enums、relation graph、Higher/Lower 都有单测和阻断报告 |
| Control & Data（后端/Managed Content） | SQLite 有 `managed_content_records`/`managed_content_changes`；Feature runtime 可存 plan/evidence；ADR/数据文档定义 current projection + immutable ledger | 现表无 currentRevision/stateDigest/authorityRevision、revision/provenance、relation/tombstone、CAS/outbox、freshness/observationCompleteness；`upsertManagedContent` 不能区分 intent/verified/uncertain | intent 写入不改 current；仅 readback/reconcile 按 CAS 提交完整 object/relation；delete 产 tombstone；Phase2 只读带 freshness/provenance 的 query |
| Integration/Connector（真实 Omnia） | Connector contract 有 health/connect/refresh/status/workspace_light_read/operation_register/invoke；Operation host 有签名包/manifest/GET/POST/PATCH 路由校验；Local 有 exact workspace light-read 和 signed invoke | 业务 create/associate Operation manifest/handler 未实现；generic body 仅 `parameter_array`；Local POST unknown 未归类 uncertain；Remote uncertain 固定 0、无持久 reconcile；Remote 业务 mutation/canary 未批准 | 同一 command envelope 在 Local/Remote 可执行；gate 复核 binding/engagement/pack/workspace/lease/plan/concurrency；每个 mutation 有独立 readback/reconcile 与真实非生产证据 |

### C.2 建议的机器契约（字段、默认、状态）

**NormalizedInput / FieldValue**（由 Execution 产生，来源不可丢）：

```text
fieldId, phase, entityType(APP|DB|OS|Tool|GRA|Risk|Control), subtype,
value, valueStatus(explicit_value|explicit_default|contract_default|derived|inherited|
missing|conflicting|not_evaluable), source(upload|template|derived|parent|catalog|AI),
required, allowedValues, higherLowerApplicability, evidenceRefs[], confidence,
validationErrors[], userOverrideAllowed
```

规则：`missing` 不等于默认；`contract_default` 必须来自已发布 TemplateVersion；`derived`/`inherited` 必须带输入字段和规则版本；AI 只能给建议/置信度，不能绕过 required 或外部 readback；所有字段必须有 `source_trace_id`，证据不完整即 `not_evaluable`/阻断。

**CreateAssociatePlan / Step**：

```text
planId, planVersion, scenarioVersion, templateId/templateVersion/schemaVersion,
inputRevision, scope{authorityId, tenantId, engagementId, packId, parentSectionId, workspaceId},
objects[{clientObjectId, entityType, subtype, identity, patchSet, rait, factors}],
relations[{clientRelationId, fromObjectId, toObjectId, relationType, required, direction}],
steps[{stepId, operationId, binding, dependsOn[], idempotencyKey, concurrencyToken,
       preflightDigest, retryPolicy=no_replay_after_dispatch}],
planDigest, confirmationDigest, safetyClass, createdAt
```

推荐状态：`Draft → Parsing → NeedsInput → ValidatingTarget → ReadyForReview → WaitingConfirmation → Creating → Associating → CompletingCore → Verifying → Succeeded`，另有 `Failed | Uncertain | Reconcile`；该状态机与 Feature 文档一致，不能用单一 `success` 覆盖部分/不确定。

**Managed Content**：

```text
managedObjectId/entityType/schemaVersion, authority/tenant/pack/workspace,
businessId, currentRevision, stateDigest, lifecycle(active|deleted|drifted),
lastVerifiedAt, authorityRevision, observationCompleteness, freshness,
currentPayload, revisions[], relations[], changeLedger[], tombstone,
provenance{runId, featureVersion, planDigest, operationId, evidenceRefs[]}
```

Mutation 前写 intent/event；外部 mutation 后只接受 exact readback/reconcile 的完整对象或关系；成功按 expectedRevision/CAS 提交 current+revision+ledger；partial 只提交已验证完成项；uncertain 不改变旧 current；delete 是 tombstone，不是物理抹除；projection/outbox 可重放但外部 command 不可自动重放。

### C.3 四类对象与关系规则

| 对象 | subtype/字段 | 默认/继承/阻断 | 关系与 evidence |
|---|---|---|---|
| APP | `Generic` 首批；`SAP ECC` 暂阻断；ID/Name/Workspace；GRA RAIT、Factors | Name 可由 ID 派生；RAIT Higher/Lower 必填；Factors Considered 必填且 AI 仅建议 | 可有 DB/OS/Tool；APP 自身不能有 APP relation；读回须证实 type/subtype/workspace/GRA |
| DB | 首批 `Generic`；`Oracle/SQL` 需正式契约 | RAIT 从关联 APP 继承；多个 APP 必须同值；缺/冲突/外部 APP 未 live exact 即阻断，禁止本地 fallback | 必须有到 APP 的 Infrastructure→Application 核心关系；关系前后双向读回 |
| OS | `Generic/UNIX/WIN` | 与 DB 同样继承/冲突规则；无 APP 不执行 | 必须有 APP 依赖（按批准 contract）；先验证父对象再关联 |
| Tool | 目前 workbook 只有“工单工具/身份和访问管理工具”；无已批准 Recording/create contract 则隐藏 | Tool 关联是可选：目标缺失/不可用不阻断 APP/Infra 核心，但必须留 warning 与证据；不把可选误标 required | 禁止 Tool→Tool；支持目标为 APP/Infrastructure 的具体 signed Operation；不能直接复制 v4 tab |
| GRA/Risk/Control | GRA name 可由对象 ID 派生；Risk/Control 需 exact catalog identity | `catalog_present_higher/lower` 只表示目录存在；`link_required_higher/lower` 才是执行 gate；二者分开存、分开校验，缺 linkRequired fail closed | Recording 当前 catalog 只读且 `linkRequired:null`，不能用于首个关联 canary 的自动 link 决策；Risk/Control post-processing 暂排除 |

### C.4 Workspace、批量、并发与可靠性

- **Workspace**：先 `workspace_light_read` 获取 authoritative Section/Workspace/parentSectionId，再用 exact `workspaceId` 做 bounded heavy read；任何“按名称猜 ID”、跨 Engagement/Pack、未绑定 `parentSectionId` 的输入都拒绝。大批量必须分页、deadline、cancel、checkpoint，不能用一次无限重读。
- **Pack Section Workspace**：plan scope 固定 `authorityId + engagementId + packId + parentSectionId + workspaceId`；每步 binding 复核同一 scope。light read 是候选发现，不是 mutation 授权；heavy read 只读选定对象/类型，附 freshness/completeness。
- **幂等**：每步有稳定 `commandId/idempotencyKey/clientObjectId/clientRelationId`；planDigest、inputRevision、confirmationDigest 冻结。重复 submit 先读回现有 identity/关系，不能再次 POST；不同 digest 视为 drift，需要重新 preflight/confirm。
- **并发**：command envelope 带 concurrency token/authority revision；Gate 先校验 lease/session/engagement/pack/operation/deadline，Operation 再校验对象版本；CAS 失败转 drift/review，不覆盖新 current。并发度由 Operation contract 给出，不能沿用 v4 固定批量值。
- **不确定/读回/reconcile**：dispatch 后网络断、超时或 5xx 不代表未执行；标记 `Uncertain`，独立 read-only reconcile 查 exact identity、关系双方、GRA/Risk/Control，结论只能 `applied_verified` 或 `not_applied/closed_not_applied`；不允许自动重试原 POST。现 v5 Local 只对 PATCH 明确 `RESPONSE_LOST`，POST create/associate 需补齐；Remote `uncertainOperations:0` 是占位，必须持久化。
- **Local/Remote**：同一 Feature/plan/command/confirmation/idempotency/evidence 和 operationId；差异只能是 transport/session/secret。Remote 不得降级为本地伪执行；Operation Module 侧向安装/回滚，Core 只负责安全边界和基础 Omnia 兼容。升级期间 block active mutation/uncertain/artifact/status unknown。

## D. 机器字段、关系、版本与首个 canary

### D.1 已有 machine source

Sol inspect artifact 的 `字段母版`（A1:V187）已有 183 个规范字段，机器列为：`field_id, Phase, 场景/对象类型, 对象子类型/区段, Higher适用, Lower适用, Omnia UI标准字段名, 字段用途, 填写责任/方式, 必填规则, 无资料时默认/回退, 允许值, evidence_type, v4 JSON key/path, v4 endpoint+method / connector, 请求/响应位置, v4 DOM/selector, v4证据路径+行号, 证据状态/置信度, 校验规则, source_trace_id, 备注`。`Risk-Control关系`（A1:V72）有 68 条关系，列出双层 `catalog_present_*`、`link_required_*`、分类、执行适用层级、evidence 与确认状态。

首要规范化约束：`field_id/relation_id/source_trace_id` 稳定且不可复用；每个 field/relation 带 `schemaVersion/templateVersion`；machine name、Omnia object ID、business ID 分开；relation 有 direction/type/required；plan/confirmation/evidence/Managed Content 互相引用 digest，而不是复制自由文本。

**Recording 输出如何接入**：Recording 0.1.0 的 `captureCurrentGraCatalog` 输出应作为不可变 `Artifact/Evidence`（含 catalog identity、scope、capturedRait、endpoint manifest、completeness、observed relations）挂到 `inputRevision`/`planId`，由 Execution 仅读取并标注来源/置信度。它可以证明“当前页看到了哪些 Risk/Control/GRA”，不能把 `catalog_present_*` 改写成 `link_required_*`，不能凭 catalog 自动生成 mutation payload；待真实 create/associate Operation readback 后，再把关联事实写入 Managed Content relation/revision。缺少 required body/detail/identity 或 `linkRequired:null` 时，状态必须是 NeedsInput/blocked，而不是默认通过。

### D.2 最小“添加新类型”步骤

1. 发布带 owner、schemaVersion、validator/digest、allowed subtype/required/default/derivation/inheritance 的 TemplateVersion，并拿到一次性用户授权；不能把新行塞进母 workbook 作为 runtime 值。
2. 在 Execution 增加纯 parser/normalizer/validator/compiler 与 schema/contract tests；声明 `catalog_present` 与 `link_required`，未确定即 blocked。
3. 写 signed Operation Module：精确 routes/body/headers/concurrency/readback/reconcile、scope binding、allowed mutation；不得改 Connector Core 业务逻辑。
4. 为 Local/Remote 注册同一 operationId，加入 feature package/worker/backend migration/evidence schema；验证 idempotency、CAS、uncertain/tombstone/relation projection。
5. 在同一非生产 Engagement/Pack/Section/Workspace 先跑一条真实 create/readback，再跑关联和失败/不确定/重启矩阵；保存 trace/evidence/Managed Content current/revision/ledger。
6. 通过签名/安全 gate、cleanup/owner、rollback/reconcile 后，才解除 UI subtype 隐藏和 canary flag；SAP ECC、外部/多 APP 等不得因“parser 已支持”提前开放。

### D.3 首个 canary 最小切片

建议严格采用现有 ADR/Feature 口径：Generic Application + Generic Database，同一个非生产 Engagement/Workspace，1 个 APP、1 个 DB、2 个 GRA core，恰好一条 DB→Application 唯一核心关系；先 create/readback APP/DB/GRA 与关系，再提交 Managed Content。Risk/Control 后处理、OS、Tool、SAP ECC、external/bulk/multi-APP、disassociate/replace 不在第一 canary。当前 Recording 只提供 catalog 读证据，不能把 Risk/Control link 作为已批准能力。

## E. 可执行 P0/P1/P2

### P0：阻断假闭环（必须先做）

1. **官方输入契约**：产品/业务 owner 发布 Generic APP/DB TemplateVersion（字段、required/default/allowed、Higher/Lower、Factors、workspace/ID/naming），签名、schema/validator/provenance digest；冻结一次性 publish authorization。
2. **真实环境选择**：确认非生产 Engagement、Pack、parent Section、Workspace、APP/DB/GRA 测试数据、命名与 cleanup owner；通过 light-read + exact heavy-read 记录 authority IDs。
3. **Execution worker**：实现 upload-only parse/normalize/default/derived/inherited/fallback/enum/required、DB/OS inheritance、relation graph、higher/lower gate、planDigest/confirmationDigest；输入缺口必须可解释且 fail closed。
4. **Managed Content schema/migration**：补齐 object currentRevision/stateDigest/authorityRevision、revision/provenance、relation、change ledger、tombstone、freshness/completeness、CAS/outbox；保留旧表兼容迁移，不直接把未读回对象写 current。
5. **真实 Operation contract**：基于 Recording/live read 确认 create IT Element、GRA、association 的 path/method/body/header/tab/concurrency/readback；签名 allowlist；扩展 operation-host body schema（当前仅 parameter_array 不够）。
6. **Uncertain/reconcile**：Local/Remote 统一 POST/PATCH/association 的 response-loss 分类、持久化 unknown、只读 reconcile、重启恢复；禁止自动 replay。

### P1：形成可审计 Feature package

1. 打包 `create_associate`（Feature metadata、front/middle worker、backend migration、Operation manifest、contract tests、evidence/trace exporter），完成 Draft→Succeeded/Failed/Uncertain/Reconcile 状态机。
2. 实现 Recording 后的 catalogue snapshot 读取和 `catalog_present`/`link_required` 双字段校验；在 `link_required` 仍 null 时显式 NeedsInput/blocked。
3. 接通 Local canary：同一 plan 在每个 step 做 gate、exact identity/readback、Managed Content commit；覆盖 repeat submit、concurrency drift、partial relation、restart。
4. 做 Remote side-by-side Operation Module 与 WSS/DPAPI/session gate；直到真实 Omnia user login + business mutation/readback 通过前，保持 Remote mutation disabled。

### P2：扩大覆盖与运营化

1. 录制/批准 OS、Tool、SAP ECC、external/multi-APP、Risk/Control post-processing 的独立 contracts；每种 subtype 通过自己的 canary 后才显示。
2. 增加批量/分页/限流、checkpoint、repair/reconcile dashboard、tombstone retention、projection consistency scan、audit export。
3. 实现 Local/Remote parity matrix、Operation package auto-update safe window、签名轮换与回滚；持续以当前 Omnia live/read evidence 复证 v4 证据种子。

## F. Recording、删除、聊天历史之后的第一个真实 Feature slice 与测试矩阵

Feature 顺序文档是 recording → delete elements → delete chat history → create/associate。删除/聊天历史完成后，第一步不是开放全类型，而是完成上面的 APP+DB canary slice；Create/Associate 当前 package catalog 仍显示为未交付、DoR blocked，默认文档也 pending。

### F.1 最小闭环

`Recording catalog snapshot → upload TemplateVersion instance → normalize/validate → plan/review → user confirm → APP create/readback → DB create/readback → DB→APP associate/readback → GRA core readback → Managed Content intent/current+revision/ledger → evidence/export`。

### F.2 测试矩阵

| 层 | 必测场景 | 通过证据 |
|---|---|---|
| Parser/normalizer | 合法 Generic APP/DB；缺 required；非法 subtype/RAIT；默认/derived/inherited；DB 多 APP 冲突；`catalog_present` 与 `link_required` 不一致 | 固定 NormalizedInput、字段状态、ValidationReport、planDigest |
| Scope/read | wrong Engagement/Pack/parentSection、重复 Workspace、recycle/closed 对象、light→heavy 分页 | exact IDs、authority/parentSection、freshness/completeness |
| Plan/confirmation | plan drift、template/schema/input revision 变化、重复确认、过期 deadline | confirmationDigest mismatch 被拒；新 plan 需重新 review |
| Connector gate | 未签名 operation、binding 不符、lease/session 失效、wrong scope、concurrency token 过期 | gate rejection + audit event，不发 mutation |
| Mutation/readback | APP/DB/GRA create、唯一关系；重复 submit；双向关系；生成对象延迟出现 | command/evidence、exact readback、idempotent no-duplicate |
| Failure | preflight fail；第二步失败；POST response loss；PATCH 5xx；进程重启；部分关系 | Failed/Uncertain/partial 状态；无自动 replay；reconcile 结论 |
| Managed Content | intent 不改 current；成功 CAS；uncertain 保持旧 current；delete tombstone；ledger/provenance/freshness | current/revision/change/tombstone/query 结果和 digest |
| Local/Remote | 同一 plan/command 在 Local；Remote 传输已支持签名 Operation，但 create/associate 业务 Operation 在真实 canary 前保持 disabled | parity report；Remote 未获批时明确 disabled |
| Security/upgrade | signed package、allowlist、safe-window update、artifact/status unknown | gate/rollback/audit evidence |

## G. 需要用户/业务 owner 完成的动作（按先后）

1. 审批并发布 Generic APP/DB 官方 TemplateVersion；确认字段责任、required/default、allowed subtype、Higher/Lower、Factors 与命名规则。
2. 提供并确认非生产 Engagement、Pack、parent Section、Workspace、测试 APP/DB/GRA 对象和 cleanup owner；允许 Agent 做 exact light/heavy read。
3. 决定第一 canary 是否只读 GRA core，或同时要求 Risk/Control post-processing；在 `link_required_*` 未有真实证据前不要批准自动关联。
4. 确认 DB/OS RAIT 继承规则（多个 APP 是否必须同值）、外部 APP 是否允许、Tool 缺失是否只 warning；把决定写入 TemplateVersion/ScenarioVersion。
5. 授权一次性 Template publish/签名与 Operation package signing；指定版本、过期时间、回滚责任。
6. 安排真实 Omnia 登录与非生产 canary 窗口，允许 recording、create/readback、关系双向读回；提供失败清理与 reconcile 人工联系人。
7. 选择 Local-first 或 Local+Remote 同窗验证；若 Remote，必须提供 user Omnia login、WSS/DPAPI/pack/session 运行条件，不能以 status-only bridge 代替。
8. 确认 Phase2 所需 Managed Content 字段、freshness/maxAge、provenance、tombstone/retention 与“当前值”的业务定义。

## H. 未决决定与风险登记

| 决策 | 当前状态 | 若不决定的结果 |
|---|---|---|
| 官方 default document/TemplateVersion 与签名 owner | `[Pending]` | Feature DoR blocked；不得把 inspect workbook 当运行时模板 |
| APP/DB/GRA create/readback payload、headers、tabs、concurrency | `[Pending][Canary]` | Operation 只能保留 disabled；禁止猜测 API |
| Risk/Control `link_required` Higher/Lower | `[Pending]`，Recording 为 null | 只能 catalog/read-only，不能自动 link |
| Remote business mutation 是否进入第一 canary | `[Pending]`，传输层已支持 signed Operation，真实业务 mutation/readback 尚未 canary | Remote create/associate 保持 disabled；不存在 Local fallback |
| OS/Tool/SAP ECC/external/multi-APP 开放顺序 | `[Pending]` | 仅 Generic APP+DB+GRA core 可评估 |
| Managed Content current/revision/ledger/tombstone/CAS/outbox 的 schema 与 retention | `[Design]` 未完全落库 | Phase2 不能可靠读取 current/freshness；uncertain/repair 风险高 |
| 失败清理、并发窗口、重试上限、人工 reconcile SLA | `[Pending]` | 部分/不确定对象可能长期悬挂，不能声称生产就绪 |

## 证据索引（可复核路径 + 行/函数/章节）

| # | 来源 | 定位 | 结论 |
|---:|---|---|---|
| 1 | `omnia-agent-v5/docs/architecture/SYSTEM_ARCHITECTURE.md` | §2–§4, §6–§8 | 四 Plane、统一 Run、Managed Content current 只由 readback/reconcile 前进 |
| 2 | `omnia-agent-v5/docs/architecture/CONNECTOR_GATE.md` | §2–§7, `workspace_light_read`, mutation state | Core 禁止业务编排；gate/幂等/uncertain/readback 边界 |
| 3 | `omnia-agent-v5/docs/product/CREATE_AND_ASSOCIATE_FEATURE.md` | scope/canary、state machine、Operations、Local/Remote | 首 canary、非目标、状态机与 Operation 禁止项 |
| 4 | `omnia-agent-v5/docs/planning/CREATE_ASSOCIATE_DEFAULT_DOCUMENT_PROJECT.md` | Pending/DoR、交付物、授权与 closure | 默认文档未批准即阻断 |
| 5 | `omnia-agent-v5/docs/planning/PHASE1_TEMPLATE_MASTER_WORKBOOK_TODO.md` | 字段迁移、默认/枚举、编译要求 | 母 workbook 只作设计输入，runtime 编译 JSON/DB |
| 6 | `omnia-agent-v5/docs/implementation/FEATURE_PACKAGE_CATALOG.md` | create/associate package row | 当前无 v5 create/associate package/worker/backend/operation |
| 7 | `omnia-agent-v5/docs/implementation/RECORDING_FEATURE.md` | catalog 与 evidence 说明 | 当前 GRA catalog 只读、`linkRequired:null`、无 mutation |
| 8 | `omnia-agent-v5/feature-packages/recording/source/middle/worker.cjs` | actions/status/start/stop/capture | Recording worker 真实状态/证据闭环，不是 create worker |
| 9 | `omnia-agent-v5/src/connector/recording/recording-service.ts` | `captureCurrentGraCatalog`, merge | 仅 GET catalog、保留 RAIT、强制 `linkRequired:null`、不推断 |
| 10 | `omnia-agent-v5/src/connector/contracts.ts` | connector operation union、`WorkspaceLightRead` | 当前 contract 仅 health/connect/refresh/status/light-read/recording/operation host |
| 11 | `omnia-agent-v5/src/connector/operation-host.ts` | register/invoke/route schema/mutation permit | signed package/allowlist；body 仅 parameter array 是 create gap |
| 12 | `omnia-agent-v5/src/connector/local-connector.ts` | `workspace_light_read`, `invokeHttpStep` | exact workspace 与 GET/POST/PATCH；POST response-loss 未统一 uncertain |
| 13 | `omnia-agent-v5/src/main/database.ts` | migration around managed tables | 现有 records/changes 表无完整 revision/relation/tombstone/CAS/outbox |
| 14 | `omnia-agent-v5/src/main/features/feature-runtime-store.ts` | `upsertManagedContent` | 当前 upsert + change append，尚无 intent/current/reconcile semantics |
| 15 | `omnia-agent-v5/src/remote-connector/worker.ts` | status/dispatch, `uncertainOperations: 0` | Remote uncertain/reconcile 仍是占位，业务 mutation 未闭环 |
| 16 | `omnia-agent-v5/docs/implementation/REMOTE_CONNECTOR_0_3_4_RELEASE.md` | discovery/自动升级/Remote canary/gate | Remote transport 与 signed Operation 通道已上线；仍未有 user Omnia create/associate mutation canary |
| 17 | `omnia-agent-v5/docs/adr/0024-agent-managed-content-registry.md` | current projection/ledger/intent/reconcile | Managed Content 目标语义与 Phase2 query |
| 18 | `omnia-agent-v5/docs/data/AGENT_MANAGED_CONTENT_REGISTRY.md` | object/revision/relation/change/query/outbox | 机器字段、CAS、tombstone、freshness、projection 约束 |
| 19 | `omnia-agent-v5/docs/data/TEMPLATE_AND_DOCUMENT_PIPELINE.md` | quarantine/status/default/gate | upload-only、来源状态、无猜测、不可变 TemplateVersion |
| 20 | `omnia-agent-v5/docs/adr/0025-authoritative-light-heavy-workspace-reads.md` | light/heavy/exact hierarchy | parentSectionId/exact scope、bounded heavy read |
| 21 | `omnia-agent-v5/docs/adr/0018-create-associate-first-vertical-slice.md` | first canary/exclusions | Generic APP+DB+2 GRA+唯一关系，真实 readback，无 mock |
| 22 | `omnia-agent-v5/docs/adr/0028-remote-automatic-safe-window-rollout.md` | safe-window boundaries | active mutation/uncertain 时阻断升级，Operation 侧向安装 |
| 23 | `omnia-agent-v5/docs/adr/0029-user-or-authorized-codex-template-publication.md` | one-time publish authorization | 模板发布授权绑定 user/instance/digest/expiry/nonce |
| 24 | `omnia-agent-v5/docs/adr/0030-v4-evidence-seeded-recertification.md` | v4 evidence seed rule | v4 可作证据种子，当前 live/read evidence 胜出 |
| 25 | `omnia-agent-v5/.codex-tmp/omnia-agent-phase1-master-v4-based.xlsx.inspect.ndjson` | `字段母版!A1:V187` | 183 normalized fields，machine columns/source trace/confidence |
| 26 | 同上 | `Risk-Control关系!A1:V72` | 68 relation rows，双层 catalog/linkRequired 分离 |
| 27 | 同上 | `规则与枚举!A1:H22` | APP/DB/OS/Tool subtype、RAIT、inheritance 与 blocked 规则 |
| 28 | 同上 | `覆盖与质检!A1:E1105` | 180 source fields、183 normalized、68 relations、强/部分/blocked/pending 摘要 |
| 29 | `omnia-agent-v4/toolkit/tools/gra-creator/src/app.js` | `GRA_TYPE_CONFIGS`, `readPlanFromExcel`, `validatePhase1ScopedPlans` | v4 类型常量、Excel runtime、scoped-plan 校验 |
| 30 | 同上 | `validateBatchItElementIdentities`, `createOneGra`, `runBatch` | exact identity、创建/读回、依赖图、部分/uncertain、批量编排 |
| 31 | `omnia-agent-v4/toolkit/tools/gra-creator/src/phase1-relationships.js` | `ensureInfrastructureApplication`, tool relation | 双面预读/POST/后读，Tool optional |
| 32 | `omnia-agent-v4/src/omnia-phase1.js` | V2 parser、`inheritInfrastructureRait` | DB/OS RAIT 继承、V2 relationships、legacy/runtime edit |
| 33 | `omnia-agent-v4/src/omnia-phase1-validation.js` | Factors/workspace/external validation | 规则分层、AI warning、live workspace/identifier checks |
| 34 | `omnia-agent-v4/src/omnia-phase1-predispatch-read.js` | pre-dispatch retry | 只允许 dispatch 前重试 |
| 35 | `omnia-agent-v4/src/omnia-phase1-external-references.js` | external APP/Tool states | external exact proof 与 Tool 可选状态 |
| 36 | `omnia-agent-v4/connector/src/omnia-gateway.js` | exact workspace/identifier、`manageRelationship` | allowlist、精确匹配、关系幂等/读回、旧 Connector 业务耦合 |
| 37 | `omnia-agent-v4/connector/src/omnia-gateway.js` | mutation state/reconcile helpers | v4 有部分 mutation-state 经验，但并非 v5 Managed Content 契约 |
| 38 | `omnia-agent-v4/src/server.js` | upload/quarantine/preview/push flow | v4 前后端/Creator 交织；可提取证据，不可复制 runtime 形态 |
| 39 | `omnia-agent-v4/tests/omnia-phase1.test.js` | APP/DB/OS/Tool、external、scoped plan | v4 parser/规则回归种子 |
| 40 | `omnia-agent-v4/tests/gra-creator-eventual-consistency.test.js` | generated risk/control poll/readback | eventual consistency、catalog budget、association idempotence |
| 41 | `omnia-agent-v4/tests/omnia-phase1-exact-target.test.js` | ambiguity/closed/foreign engagement | exact target safety |

## 结束判定

在官方 TemplateVersion、真实非生产 scope、签名 create/associate Operation、Local/Remote command parity、Managed Content current/revision/ledger/tombstone/CAS 和 uncertain/reconcile 通过前，v5 “新建并关联”只能保持设计/hidden/blocked 状态。把 v4 workbook、硬编码常量或 fixture 跑通都不构成 canary 通过。本文完成的是边界审计；产品代码、母 workbook 和运行时外部数据均未改动。
# v5 implementation disposition

Confirmed v4 routes and bodies were moved into fixed signed Operations, including paged element/relationship reads, exact IT Element/GRA create bodies, dynamic Risk Factor spectrum selection, `/documentation` JSON Patch, Risk-Control hidden-data validation and association, Evaluation submission, and readback. Unverified fields stay blocked; v5 does not import or execute v4 runtime code.

## Current status (2026-08-03; supersedes historical gap statements above)

`omnia.create-associate@0.1.0` now has a Remote-only signed automated candidate: frozen V8 governance (9 sheets, 187 fields, 68 relations), offline conversion/revision, one-time confirmation, signed business Operations, receipt-backed readback and Managed Content, and uncertain/read-only reconcile. Statements above that call the package or business Operations unimplemented, require Local/Remote parity, or describe 7 sheets/183 fields are retained only as historical research and are superseded.

This is not a real Omnia canary result. Production Return remains fail-closed until the live Connector provides canonical authority-instance, tenant/org, Pack, Engagement, and Workspace identities and the exact mutation/readback capability has current non-production canary evidence. There is no Local transport or silent fallback.
