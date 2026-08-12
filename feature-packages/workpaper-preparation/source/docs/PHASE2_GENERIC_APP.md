# Phase2 Generic APP 字段合同（草案）

## 当前可执行范围

当前签名 Feature 只执行“开启隐藏 Tab”闭环，适用于 `APP.01`、`APP.02`、`APP.03`、`APP.05`、`APP.06`、`APP.10`、`APP.13`、`APP.15`、`APP.16`。

2026-08-12 的 Remote 录制 `bb8e103f-097a-4199-8c6b-a16cec6001d1` 完整冻结 85 个事件、0 omission。录制证明同一 Control 的真实顺序是：

1. 尚无 Tab 201 行时，先按录制证明的 no-token PATCH 临时启用 common-control testing，删除 `concurrencyTabUpdatedOn`，再读回 Omnia 新生成的真实 Tab 201 token；不把 Control `updatedOn` 当令牌。
2. `validateHiddenData` 依次校验 `planningCommonControlTesting=false` 与 `planningOperatingEffectivenessTesting=true` / `planningCommonControlTesting=false`。
3. 使用刚读回的真实 Tab 201 token 提交 OE PATCH，并权威 GET 读回 OE 实体；若 Omnia 返回 Tab 209 时间戳则仅作为诊断字段保留。
4. `validateHiddenData` 校验 `usePreviousAuditEvidence=false`。
5. 使用 Tab 209 合同提交第三阶段 PATCH，再由权威 GET 读回最终状态。录制证明该 PATCH 会删除
   `concurrencyTabUpdatedOn`，因此完成态以 OE 实体和权威字段为准，不伪造 Tab 209 时间戳。

前期证据列表为空只是一项诊断事实，不代表已经选择“不利用前期审计证据”。完成态仍必须由权威 GET 读到 `usePreviousAuditEvidence=false`。

Control 编号只用于从 GRA 的真实 Control 目录选择上述九个目标；运行时始终绑定 `controlId`、`workItemId`、GRA、APP、Workspace 和实时并发令牌。没有九套复制代码。

## Python 与 Connector 边界

- CPython 负责目标 Control 选择、冻结计划、状态不变量和 `applied / partial_applied / not_applied / pending / contradiction` 结果分类。
- Feature Worker 负责 Core Run、确认、命令、收据、恢复和投影编排，不重复实现 Control 完成条件。
- 签名 Operation handler 只是 Omnia 路由适配器：读取原始 Control、执行录制证明的请求顺序、返回有限字段。
- Connector 只加载并执行通用签名 Operation；没有 APP 编号、字段模板或 Workpaper 规则。

## Sheet2 第一版字段映射

以下映射来自 v4 遗留合同和本次真实 Control GET。除“开启隐藏 Tab”三个字段外，其余字段尚未开放写入 Operation，必须在后续录制确认当前 Omnia 请求体、枚举值和并发 Tab 后才能成为可执行功能。

| 区域 | 前台含义 | 当前后台候选 | 容器/路径候选 | 状态 |
| --- | --- | --- | --- | --- |
| 控制详细信息 | Control ID | `controlNumber` | Control 根对象 | 只读身份，已确认 |
| 控制详细信息 | Control 名称 | `name` | Control 根对象 | 只读身份，已确认 |
| 控制详细信息 | Control 描述 | `description` | Control 根对象 | v4 遗留，待写入录制 |
| 控制详细信息 | Control 类型 | `controlType` | Control 根对象 | 只读身份，已确认 |
| 控制详细信息 | 性质 | `controlNature` | Control 根对象 | 前台已录制，后台字段待确认 |
| 控制详细信息 | 方法 | `approach` | Control 根对象 | 当前 GET 已确认 |
| 控制详细信息 | 风险关联类型 | `riskAssociationType` | Control 根对象 | v4 遗留，待写入录制 |
| 控制详细信息 | 风险关联描述 | `riskAssociationDescription` | Control 根对象 | v4 遗留，待写入录制 |
| 控制详细信息 | 测试运行有效性 | `planningOperatingEffectivenessTesting` | Control 根对象 / Tab 201 | 已录制、已实现 |
| 控制详细信息 | 同质化控制测试 | `planningCommonControlTesting` | Control 根对象 / Tab 201 | 已录制、已实现 |
| 前期审计证据 | 是否利用前期审计证据 | `usePreviousAuditEvidence` | Control 根对象 / Tab 209 | 已录制、已实现 |
| 设计因素 | 人员胜任能力与权限 | `competenceAndAuthorityDocumentation` | `controlDesignEvaluation/{id}` | v4 遗留，待写入录制 |
| 设计因素 | 一致执行的频率 | `frequencyAndConsistency` | `controlDesignEvaluation/{id}` | v4 遗留，待写入录制 |
| 设计因素 | 汇总程度 | `levelOfAggregation` | `controlDesignEvaluation/{id}` | v4 遗留，待写入录制 |
| 设计因素 | 调查标准 | `criteriaForInvestigation` | `controlDesignEvaluation/{id}` | v4 遗留，待写入录制 |
| 设计因素 | 是否依赖其他控制 | `dependentOnOtherControls` | `controlDesignEvaluation/{id}` | v4 遗留，待写入录制 |
| 设计结论 | 设计是否有效 | `designEffective` | `controlDesignEvaluation/{id}` | v4 遗留，待写入录制 |
| 设计结论 | 是否得到执行 | `properlyImplemented` | `controlDesignEvaluation/{id}` | v4 遗留，待写入录制 |
| 设计程序 | 程序结果 | `documentProcedureResults` | `gitcNonDetailedTestingProcedures/{id}`，`phaseType=TestOfDesign` | v4 遗留，待写入录制 |
| RAWC | 适当性与相关性 | `appropriatenessAndCorrelation` | `controlRiskScopes/{scopeId}/controlRiskScopeDetails/{detailId}` | v4 遗留，待写入录制 |
| 运行有效性 | 程序时间 | `procedureTiming` | `controlOperatingEffectiveness/{id}` | v4 遗留，待写入录制 |
| 运行有效性 | 时间理由 | `procedureTimingRationale` | `controlOperatingEffectiveness/{id}` | v4 遗留，待写入录制 |
| 运行有效性 | 执行频率 | `frequencyOfPerformance` | `controlOperatingEffectiveness/{id}` | v4 遗留，待写入录制 |
| 运行有效性 | 执行频率说明 | `frequencyOfPerformanceExplanation` | `controlOperatingEffectiveness/{id}` | v4 遗留，待写入录制 |
| 运行有效性 | 使用建议样本量 | `useRecommendedSampleSize` | `controlOperatingEffectiveness/{id}` | v4 遗留，待写入录制 |
| 运行有效性 | 实际样本量 | `actualSampleSize` | `controlOperatingEffectiveness/{id}` | v4 遗留，待写入录制 |
| 运行有效性 | 实际样本量理由 | `actualSampleSizeRationale` | `controlOperatingEffectiveness/{id}` | v4 遗留，待写入录制 |
| 运行有效性程序 | 程序结果 1–4 | `documentProcedureResults` | `gitcNonDetailedTestingProcedures/{id}`，`phaseType=OperatingEffectiveness` | v4 遗留，待写入录制 |
| 运行有效性 | 运行是否有效 | `operatingEffectively` | `controlOperatingEffectiveness/{id}` | v4 遗留，待写入录制 |

## 后续实现顺序

1. 用录制功能分别捕获一个设计字段、一个 Test of Design 程序结果、一个 RAWC 字段和一个 OE 字段的真实保存请求。
2. 在 Python 中形成带类型、枚举和适用 APP 控制号的字段计划；不在 Connector 中增加字段规则。
3. 扩展签名 Operation 的窄路由与读回合同。
4. 先只读预览和冻结差异，再由用户一次性确认写入；任何不确定结果只读 reconcile，禁止盲目重放。
