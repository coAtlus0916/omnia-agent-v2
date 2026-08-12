# 底稿编制 Feature __FEATURE_VERSION__

当前版本实现 Phase2 的第一个真实闭环：为选定 Application GRA 下的 Control 激活隐藏 Tab。

1. 从当前 Connector authority、显式安全锁 Workspace 与 Standardized Accounts List 读取权威 Generic Application GRA，允许选择一个或多个 GRA 形成同一冻结批次。
2. 读取该 GRA 的真实 Control 目录，逐项核验 Control、Work Item、APP、GRA、Workspace 和并发令牌。
3. 用户确认后，按照真实录制的两阶段流程执行：先开启运行有效性测试，再明确选择“不利用前期审计证据”。
4. 最终只在同一 Control 同时满足以下条件时判定成功：`planningOperatingEffectivenessTesting=true`、`planningCommonControlTesting=false`、`usePreviousAuditEvidence=false`、存在 OE 实体。Tab 209 时间戳是诊断证据，不是完成条件。

所有选择、确认、执行进度、失败和待核验状态只显示在 Feature 工作台，不写入 Comments。

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
