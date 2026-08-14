# Phase2 Generic APP 字段合同

## 当前可执行范围

当前签名 Feature 执行“开启隐藏 Tab + 母版字段转换 + 已录制字段写回”闭环，适用于 `APP.01`、`APP.02`、`APP.03`、`APP.05`、`APP.06`、`APP.10`、`APP.13`、`APP.15`、`APP.16`。实际预置母版当前包含 APP.01/.02/.05/.06/.10/.13 六类 Control。

## 用户母版与制度转换

当前下载的母版不启用 Excel 工作表保护，包含三张表：

- `替换字段`：E 列绿色单元格可填写系统级或测试点级替换内容。
- `Controls`：除 `controlNumber` 外的绿色单元格都可直接修改。用户填写值会成为制度解析前的真实源内容。
- `Scope`：隐藏的冻结身份表；上传时与当前 Run、APP、Workspace 和安全锁范围核对。

参数表允许完全留空，用户可以在 Pack 中继续补录；也允许只填写一部分。上传时会按当前权威目录逐行校验编号、测试点和占位符，再校验固定表头、Control 行身份和完整 Scope，防止把另一批次或被改坏的模板写入当前计划。单 APP 模板可以确定性重绑定到当前冻结的单 APP；多 APP 范围不一致会拒绝。用户填写值中新增的 `【...】` 是普通正文，不会再次被识别成待制度解析的占位符。

当前目录只有 18 个存在母版消费位置的活动参数。旧目录中的 `1.08 / 【抽样标准】` 没有已录制的母版落点，因此新模板不再展示它；旧版仅含 `替换字段` 的文件仍可兼容读取，但该旧行必须留空，非空时会明确拒绝，避免静默丢值。

当填写件与制度资料都已上传后，Feature 对每个 Control、每个母版字段执行制度解析，将有制度证据支持的结果覆盖到对应 `Controls` 单元格，并在后台生成、保存新的 `workpaper-phase2-filled-*.xlsx` 结果 Artifact。它不展示为下载项，也不增加用户核对步骤；现有三步流程保持不变。缺少证据或存在歧义的内容会保留原 `【占位符】`，并在计划中记录待人工补录数量，而不是转换成无法辨认来源的空白。空解析结果不会生成 Omnia 写入，缺少当前保存录制的非空字段只进入 `recording_required` 覆盖清单。

制度资料入口的点击选择会先让用户选择“文件”或“文件夹”：文件模式支持一个或多个 `.zip/.docx/.xlsx/.xlsm/.pdf`，文件夹模式递归收集这些类型。拖入单个 ZIP 时保持原 ZIP，不再额外套一层归档；拖入文件夹或多个文件时才归一化为 ZIP。Worker 不以内联 Base64 搬运制度文件，而是使用 Core 校验后的只读文件句柄交给 CPython。

2026-08-14 的六类 APP 编辑录制证明字段写回分别使用 Tab 204（TestOfDesign ProcedureResults）、205（Design Factors/RiskScopeDetails）、210（风险关联描述）、211（OE 时间与范围）、212（OE ProcedureResults）和 214（OE 结论）。同一表单保存的字段合并 PATCH；OE ProcedureResults 按程序逐项 PATCH。Tab 204/211/212 每次 PATCH 前使用最新 GET：存在当前页签 token 就携带，否则移除，PATCH 后立即重新 GET。每个字段必须权威读回相等。Feature AI review 必须绑定 Core 管理的源文件上传 Run，不能使用 Feature 私有计划 ID。AI 能力不可用、调用/身份校验失败或返回不完整时不再停止整个流程，而是记录 `placeholder_writeback` 降级：保留原 `【占位符】`，通过已录制的 editor/text API 回传到 Pack；不接受占位字符串的 number/boolean/enum/choice 字段仍留作人工补录。AI 正常返回的 `missing_evidence / ambiguous` 继续保留原占位符并只进入人工补录统计，不冒充 AI 故障降级。

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

以下映射以当前真实 Control GET、2026-08-14 编辑录制和预置母版为准。`已实现` 表示同时具备母版源列、当前保存录制、冻结旧值、真实 PATCH 与逐字段读回；其余字段只做覆盖报告，不生成 PATCH。

| 区域 | 前台含义 | 当前后台候选 | 容器/路径候选 | 状态 |
| --- | --- | --- | --- | --- |
| 控制详细信息 | Control ID | `controlNumber` | Control 根对象 | 只读身份，已确认 |
| 控制详细信息 | Control 名称 | `name` | Control 根对象 | 只读身份，已确认 |
| 控制详细信息 | Control 描述 | `description` | Control 根对象 | 母版有值；待当前保存录制 |
| 控制详细信息 | Control 类型 | `controlType` | Control 根对象 | 只读身份，已确认 |
| 控制详细信息 | 性质 | `controlNature` | Control 根对象 | 前台已录制，后台字段待确认 |
| 控制详细信息 | 方法 | `approach` | Control 根对象 | 当前 GET 已确认 |
| 控制详细信息 | 风险关联类型 | `riskAssociationType` | Control 根对象 | 母版有值；待枚举与保存录制 |
| RAWC | 风险关联描述 | `riskAssociationDescription` | Control 根对象 / Tab 210 | 已实现：editor JSON、remove token、purge |
| 控制详细信息 | 测试运行有效性 | `planningOperatingEffectivenessTesting` | Control 根对象 / Tab 201 | 已录制、已实现 |
| 控制详细信息 | 同质化控制测试 | `planningCommonControlTesting` | Control 根对象 / Tab 201 | 已录制、已实现 |
| 前期审计证据 | 是否利用前期审计证据 | `usePreviousAuditEvidence` | Control 根对象 / Tab 209 | 已录制、已实现 |
| 设计因素 | 人员胜任能力与权限 | `competenceAndAuthorityDocumentation` | `controlDesignEvaluation/{id}` / Tab 205 | 已实现：母版源列、editor JSON、remove token、purge |
| 设计因素 | 一致执行的频率 | `frequencyAndConsistency` | `controlDesignEvaluation/{id}` / Tab 205 | 已实现：editor JSON、remove token、purge |
| 设计因素 | 汇总程度 | `levelOfAggregation` | `controlDesignEvaluation/{id}` / Tab 205 | 已实现：editor JSON、remove token、purge |
| 设计因素 | 调查标准 | `criteriaForInvestigation` | `controlDesignEvaluation/{id}` / Tab 205 | 已实现：editor JSON、remove token、purge |
| 设计因素 | 是否依赖其他控制 | `dependentOnOtherControls` | `controlDesignEvaluation/{id}` | 母版有值；待当前值域与保存录制 |
| 设计结论 | 设计是否有效 | `designEffective` | `controlDesignEvaluation/{id}` | 母版列当前为空；待当前选择值与保存录制 |
| 设计结论 | 是否得到执行 | `properlyImplemented` | `controlDesignEvaluation/{id}` | 母版缺少源列；待当前选择值与保存录制 |
| 设计程序 | 程序结果 | `documentProcedureResults` | `gitcNonDetailedTestingProcedures/{id}`，`phaseType=TestOfDesign` / Tab 204 | 已实现：editor JSON、current-or-remove token、no purge |
| RAWC | 适当性与相关性 | `appropriatenessAndCorrelation` | `controlRiskScopes/{scopeId}/controlRiskScopeDetails` / Tab 205 | 已实现：母版源列、整体对象、editor JSON、remove token、purge |
| 运行有效性 | 程序时间 | `procedureTiming` | `controlOperatingEffectiveness/{id}` / Tab 211 | 已实现：字符串枚举、current-or-remove token、purge |
| 运行有效性 | 时间理由 | `procedureTimingRationale` | `controlOperatingEffectiveness/{id}` / Tab 211 | 已实现：普通字符串、current-or-remove token、purge |
| 运行有效性 | 执行频率 | `frequencyOfPerformance` | `controlOperatingEffectiveness/{id}` / Tab 211 | 已实现：数字、current-or-remove token、purge |
| 运行有效性 | 执行频率说明 | `frequencyOfPerformanceExplanation` | `controlOperatingEffectiveness/{id}` / Tab 211 | 已实现：普通字符串、current-or-remove token、purge |
| 运行有效性 | 使用建议样本量 | `useRecommendedSampleSize` | `controlOperatingEffectiveness/{id}` | 母版列当前为空；待当前保存录制 |
| 运行有效性 | 实际样本量 | `actualSampleSize` | `controlOperatingEffectiveness/{id}` | 母版列当前为空；待当前保存录制 |
| 运行有效性 | 实际样本量理由 | `actualSampleSizeRationale` | `controlOperatingEffectiveness/{id}` | 母版列当前为空；待当前保存录制 |
| 运行有效性程序 | 程序结果 1–4 | `documentProcedureResults` | `gitcNonDetailedTestingProcedures/{id}`，`phaseType=OperatingEffectiveness` / Tab 212 | 已实现：按程序顺序逐项 PATCH、editor JSON、current-or-remove token、每次写后 GET、no purge |
| 运行有效性 | 运行是否有效 | `operatingEffectively` | `controlOperatingEffectiveness/{id}` / Tab 214 | 已实现数值选择、remove token、purge；母版非空时写入 |

## 后续实现顺序

1. 补录控制描述、风险关联类型、依赖控制、Design 结论以及三个样本量字段的当前保存请求、枚举值和并发页签；在此之前继续保持 `recording_required`。
2. 对新增录制继续执行冻结旧值、按表单合并 PATCH、逐字段权威读回和不确定状态禁止重放的同一闭环。
