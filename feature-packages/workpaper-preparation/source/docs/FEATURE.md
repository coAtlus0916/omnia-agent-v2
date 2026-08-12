# 底稿编制 Feature __FEATURE_VERSION__

当前版本实现 Phase2 的完整闭环：激活隐藏 Tab 后，生成控制底稿 Excel、下载审核、重新上传、逐字段预览、确认后写回已有 Control/ProcedureResults/RiskScopeDetails/DesignEvaluation/OperatingEffectiveness 字段，并做写后 readback 与 uncertain reconcile。

1. 从当前 Connector authority、显式安全锁 Workspace 与 Standardized Accounts List 读取权威 Generic Application GRA，允许选择一个或多个 GRA 形成同一冻结批次。
2. 读取该 GRA 的真实 Control 目录，逐项核验 Control、Work Item、APP、GRA、Workspace 和并发令牌。
3. 用户确认后，按照真实录制的两阶段流程执行：先开启运行有效性测试，再明确选择“不利用前期审计证据”。
4. 最终只在同一 Control 同时满足以下条件时判定成功：`planningOperatingEffectivenessTesting=true`、`planningCommonControlTesting=false`、`usePreviousAuditEvidence=false`、存在 OE 实体。Tab 209 时间戳是诊断证据，不是完成条件。
5. 打开并读回成功后，可生成 Phase 2 控制底稿 Excel：一行一个 Control（含来源 GRA 与精确四元组身份），可写字段列来自可执行字段合同，缺证据字段留空，绝不猜测。
6. 用户下载、线下修改、重新上传后，按隐藏 Scope sheet 的四元组精确匹配回冻结 Control，拒绝重复/歧义/无法证明来源的行，生成「上传值 vs 实时快照值」的逐字段只读预览。
7. 只有用户明确确认后才写回：按 Control 逐个执行，每个字段一个 JSON Patch（带 Tab 201/209 并发令牌），写后立即权威读回对账，成功才标记完成；超时/断线/中断标 uncertain，只读 reconcile，禁止盲目重放。

所有选择、确认、执行进度、失败和待核验状态只显示在 Feature 工作台，不写入 Comments。

## 写回目标与证据来源

写回不新建任何 Workpaper 对象，而是对已有实体的字段做 JSON Patch（`PATCH /rapr/v0/engagements/{id}/controls/{controlId}`）：

- Control 本体：`/description`、`/approach`、`/riskAssociationType`、`/riskAssociationDescription`
- Design Evaluation：`/controlDesignEvaluation/{id}/competenceAndAuthorityDocumentation|frequencyAndConsistency|levelOfAggregation|criteriaForInvestigation|dependentOnOtherControls|designEffective|properlyImplemented`
- ProcedureResults：`/gitcNonDetailedTestingProcedures/{procedureId}/documentProcedureResults`（TestOfDesign=Tab 201，OperatingEffectiveness=Tab 209）
- RiskScopeDetails：`/controlRiskScopes/{scopeId}/controlRiskScopeDetails/{detailId}/appropriatenessAndCorrelation`
- Operating Effectiveness：`/controlOperatingEffectiveness/{id}/{procedureTiming|frequencyOfPerformance|...|operatingEffectively}`

这些 JSON Patch path 继承 v4 gc-editor 对 Omnia 真实 API 的已验证行为（`gc-stage-builder.js`），当前证据标注为 `v4-verified-path`，后续用 v5 录制复核。字段合同见 `docs/PHASE2_GENERIC_APP_FIELDS.json`（含 writePath/concurrencyTab/valueKind/readOnly/evidence）。


## 安全与恢复

- Feature Worker 保存计划、一次性确认、Core intent、command、Operation receipt、读回证据和 Managed Content 投影。
- 签名 Operation package 只声明本 Feature 所需的 Omnia 路由；Connector 不包含 Workpaper、Control 或 Phase2 业务规则。
- 尚未生成 Tab 201 行时，先严格采用录制中的 no-token PATCH 临时启用 common-control testing，使 Omnia 生成真实 Tab 201 token；读回后再执行 common/OE 的 `validateHiddenData` 与带真实 token 的 OE PATCH。最后按录制的 Tab 209 合同明确写入“不利用前期证据”。绝不把 Control `updatedOn` 冒充并发令牌，也不直接用 no-token 形态提交 OE。
- PATCH 响应不确定时不会盲目重放，只允许同一 command、Control 和冻结计划的只读 reconcile。
- 若第一阶段已经由权威读回证明完成，下一次受控执行只补第二阶段，不重复第一阶段。
- CPython 只使用 release 托管的 3.13.14，负责九个 Generic APP Control 的选择、参数化计划、状态不变量和权威读回结果分类。
- 当前只支持权威内容类型为 `Generic` / `Generic Application` 的 Application GRA；SAP、Oracle 等其他 Application 子类型及其他 GRA 类型均不会进入可选目录。

## 录制证据

2026-08-12 的 Remote 录制完整包含 85 个连续事件、0 omission，并冻结了以下真实顺序：

- `POST .../controls/{controlId}/validateHiddenData`
- `PATCH .../controls/{controlId}` 开启 `planningOperatingEffectivenessTesting`
- 权威 GET 回读确认 OE 实体与 Tab 209
- `POST .../controls/{controlId}/validateHiddenData`
- `PATCH .../controls/{controlId}` 设置 `usePreviousAuditEvidence=false`
- 权威 GET 回读确认最终双字段状态

录制还证明：没有可复用 Tab 时间戳时，Omnia 前端会发送不带值的 `replace /concurrencyTabUpdatedOn`；因此 Feature 冻结“令牌存在/不存在”本身，不能从实体时间戳推导令牌。即使前期证据列表为空，完成态仍要求权威字段 `usePreviousAuditEvidence=false`，不会用空列表替代用户要求的“不利用前期审计证据”。

同一录制还证明“前期审计证据”“与控制相关的风险（RAWC）”“运行有效性”三个 Tab 在最终状态可访问。该合同按 Control 身份参数化，不按 APP 编号复制实现。

Sheet2 字段候选、已确认边界和下一轮录制要求见 `docs/PHASE2_GENERIC_APP.md`。其中未标记“已实现”的 v4 遗留字段不会显示为可执行入口。
