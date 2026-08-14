# 底稿编制 Feature __FEATURE_VERSION__

当前版本实现 Phase2 的录制证据范围闭环：激活隐藏 Tab 后生成可编辑的预置控制母版，上传用户填写的母版与制度资料，合并生成完整母版；确认后只写回已有录制证明的 Control/ProcedureResults/DesignEvaluation/OperatingEffectiveness 字段，并逐字段 readback。母版非空但尚无保存录制的字段会进入 `recording_required` 覆盖清单，不冒充已完成。

1. 从当前 Connector authority、显式安全锁 Workspace 与 Standardized Accounts List 读取权威 Generic Application GRA，允许选择一个或多个 GRA 形成同一冻结批次。
2. 读取该 GRA 的真实 Control 目录，逐项核验 Control、Work Item、APP、GRA、Workspace 和并发令牌。
3. 用户确认后，按照真实录制的两阶段流程执行：先开启运行有效性测试，再明确选择“不利用前期审计证据”。
4. 最终只在同一 Control 同时满足以下条件时判定成功：`planningOperatingEffectivenessTesting=true`、`planningCommonControlTesting=false`、`usePreviousAuditEvidence=false`、存在 OE 实体。Tab 209 时间戳是诊断证据，不是完成条件。
5. 根据选中的 APP 名称生成 Phase 2 预置母版。下载文件包含可编辑的 `替换字段` 与 `Controls`，以及隐藏的 `Scope`；不再启用工作表保护。绿色单元格是建议填写区，`controlNumber` 是只读身份，上传时会严格核验。
6. 用户可以填写 `替换字段` E 列，也可以直接修改 `Controls` 的非身份列；参数表可以全空或部分填写，留空内容允许后续在 Pack 补录。重新上传后，参数目录、Controls 行身份、表头和冻结 Scope 都会校验；用户编辑的 Controls 是后续制度解析的真实输入，用户新增的 `【...】` 正文不会被二次当作占位符。模板与目标都只有一个系统时，允许把模板的源系统标签确定性重绑定到已冻结的目标 APP；多系统范围不一致仍因映射歧义而拒绝。
7. 制度资料支持点击选择单个/多个文件或文件夹，也支持拖入 ZIP、Word、Excel 与 PDF。单个文件保持原文件，文件夹或多个文件由 Shell 归一化为一个 ZIP；解析器也允许 ZIP 内继续包含 ZIP，递归展开至 4 层，并对成员数、单成员大小、累计展开字节与累计文本量统一限额。内层 Word/Excel 使用完整归档路径进入制度索引，PDF 无文本层时仍明确跳过，绝不猜测。
8. 用户填写内容与制度解析结果合并后，后台会生成并保存一份 `workpaper-phase2-filled-*.xlsx` 完整母版，但不在界面增加下载核对或额外确认环节。制度有证据支持的占位符才会替换；正常返回的 `missing_evidence / ambiguous` 保留原占位符，并在计划中记录待人工补录数量。Feature AI review 使用制度/参数表上传时由 Core 创建的真实 Run identity，不把私有 `planId` 冒充 Run。若 AI 端口缺失、调用失败、身份被拒绝或返回无效，计划会显式记录 `placeholder_writeback` 降级并继续回传：已录制的富文本/普通文本字段保留原 `【占位符】` 写入 Pack；数字、布尔、枚举/选择等类型不兼容字段不伪造值，继续进入待人工补录统计。现有“确认回传”步骤不变：富文本先转换为 Omnia editor JSON（不是裸字符串）；按录制分别使用 Tab 204/205/210/211/212/214。Tab 204/211/212 使用最新 GET 的 token，尚无 token 时移除；OE 程序逐项 PATCH 且每次写后重新 GET。每个字段都冻结旧值、取得独立权威 snapshot receipt 并逐字段读回相等后才标记成功；超时/断线/中断标 uncertain，禁止盲目重放。

当前模板只生成 18 个存在母版落点的活动参数；旧目录 `1.08 / 【抽样标准】` 没有可消费落点，已从新模板停用。旧版仅含 `替换字段` 的填写件仍可读取，但不会提供直接编辑 Controls 的能力，且旧 `1.08` 行只能留空；新流程应重新下载当前版本母版。

所有选择、确认、执行进度、失败和待核验状态只显示在 Feature 工作台，不写入 Comments。

## 写回目标与证据来源

写回不新建任何 Workpaper 对象，而是对已有实体的字段做 JSON Patch（`PATCH /rapr/v0/engagements/{id}/controls/{controlId}`）：

- Control 本体：`/riskAssociationDescription`（Tab 210）。
- Design Evaluation：母版当前提供的 `frequencyAndConsistency`、`levelOfAggregation`、`criteriaForInvestigation`（Tab 205）。
- ProcedureResults：`/gitcNonDetailedTestingProcedures/{procedureId}/documentProcedureResults`（TestOfDesign=Tab 204；OperatingEffectiveness 第 1–4 项=Tab 212，按实时程序顺序绑定并逐项写后 GET）。
- Operating Effectiveness：`/controlOperatingEffectiveness/{id}/operatingEffectively`（Tab 214；仅在母版提供数值选择时写入）。
- RiskScopeDetails 的整体对象 PATCH（Tab 205）和 `competenceAndAuthorityDocumentation` 已有录制合同及母版源列，可生成真实写入。

2026-08-14 的 v5 录制证明，富文本字段的 `value` 必须是 JSON 字符串，例如 `{"editorData":"<p>a</p>","suggestionsData":[],"trackChangesEnableFlagInEditor":false,"plainText":""}`。向相同 path 写裸文本虽然可能被 API GET 原样读回，但 Omnia 编辑器不会渲染，因此不再视为有效回传。OE 的 `procedureTimingRationale` 与 `frequencyOfPerformanceExplanation` 是普通字符串，`frequencyOfPerformance` 是数字。控制描述、风险类型、依赖控制、Design 结论以及三个样本量字段仍需当前版本的保存录制，字段合同见 `docs/PHASE2_GENERIC_APP_FIELDS.json`。


## 安全与恢复

- Feature Worker 保存计划、一次性确认、隐藏 Tab 与正文写回各自的 Core intent/command、Connector delivery witness、Operation receipt、读回证据和 Managed Content 投影。
- 签名 Operation package 只声明本 Feature 所需的 Omnia 路由；Connector 不包含 Workpaper、Control 或 Phase2 业务规则。
- 尚未生成 Tab 201 行时，先严格采用录制中的 no-token PATCH 临时启用 common-control testing，使 Omnia 生成真实 Tab 201 token；读回后再执行 common/OE 的 `validateHiddenData` 与带真实 token 的 OE PATCH。最后按录制的 Tab 209 合同明确写入“不利用前期证据”。绝不把 Control `updatedOn` 冒充并发令牌，也不直接用 no-token 形态提交 OE。
- PATCH 响应不确定时不会盲目重放，只允许同一 command、Control 和冻结计划的只读 reconcile。
- 正文写回 payload 同时冻结每个 Phase 2 字段的旧值；Operation 在 PATCH 前用刚读到的权威详情逐字段比较，任一并发漂移即失败关闭。
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

2026-08-14 的 Remote 编辑录制 `d9e67227-5eb4-4001-95a5-c632c9075b0e` 包含 159 个连续事件，并抓到真实 `PATCH .../controls/{controlId}`：所有 Rich Text Editor 字段都提交上述四字段编辑器 JSON；运行有效性 ProcedureResults 的真实 path 为 `/gitcNonDetailedTestingProcedures/{procedureId}/documentProcedureResults`。该证据直接否定了裸文本 payload。

Sheet2 字段候选、已确认边界和下一轮录制要求见 `docs/PHASE2_GENERIC_APP.md`。其中未标记“已实现”的 v4 遗留字段不会显示为可执行入口。
