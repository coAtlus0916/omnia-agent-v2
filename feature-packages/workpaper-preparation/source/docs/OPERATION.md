# 底稿编制签名 Operation __FEATURE_VERSION__

Operation package 提供七个能力：

- `omnia.workpaper.directory.read.v1`：用 Standardized Accounts List 的实时 Generic APP 内容身份筛选当前 authority 内的 Application GRA，并返回精确 GRA/APP/Workspace 身份。
- `omnia.workpaper.controls.read.v1`：读取选定 GRA 的 Control 目录和每个 Control 的精确详情。
- `omnia.workpaper.control.preflight.v1`：重新核验 GRA/APP/Workspace/Control/Work Item，并冻结当前 Control 状态和 Tab 201/209 令牌；只为单一隐藏 Tab mutation 签发 permit。
- `omnia.workpaper.control.open-hidden-tab.v1`：若 Control 尚无 Tab 201，先按录制合同用无 token PATCH 临时启用 common-control testing 并读回真实 Tab 201 token；随后执行 common/OE 校验与带真实 token 的 OE PATCH，最后执行 prior-evidence 校验与 Tab 209 PATCH。最终要求 `planningOperatingEffectivenessTesting=true`、`planningCommonControlTesting=false` 且 `usePreviousAuditEvidence=false`。
- `omnia.workpaper.control.reconcile.v1`：只读同一个 Control；成功必须同时具有三个目标字段与 OE 实体。Tab 209 时间戳允许缺失，因为录制的第二阶段 PATCH 会删除 `concurrencyTabUpdatedOn`。
- `omnia.workpaper.phase2.snapshot.read.v1`：读取现有 Control 的 Phase 2 有限字段；绑定 `target + planDigest` 时，只为同一 Control 的正文写回 Operation 签发一次性 mutation permit。写后同一 Operation 生成独立权威 receipt。
- `omnia.workpaper.phase2.writeback.v1`：只接受 Core durable command、幂等 delivery identity、冻结 plan 和精确 Control 目标；`valueKind=editor` 必须是录制证明的 Omnia 富文本 JSON（`editorData`、`suggestionsData`、`trackChangesEnableFlagInEditor`、`plainText`），拒绝裸文本。Operation 支持录制确认的 Tab 204/205/210/211/212/214；Tab 204/211/212 采用 current-or-remove：GET 有当前页签 token 就携带，否则移除。相同表单字段合并 PATCH，OE ProcedureResults 按 `phaseType + procedureIndex` 分组逐项 PATCH，并在每次 PATCH 后重新 GET。PATCH 前逐字段验证冻结旧值，PATCH 后逐字段读回并返回 ledger。RiskScopeDetails 按录制发送整体对象。

未生成 Tab 201 数组行的关闭态 Control 仍可使用根对象上同时存在且 `concurrencyTabId=201` 的 `concurrencyTabUpdatedOn`；该成对字段是真实并发令牌。Operation 绝不使用实体普通 `updatedOn` 冒充令牌。数组行和根字段都不存在时才进入录制证明的不带时间戳 bootstrap PATCH；存在令牌时必须逐值匹配。空的前期证据列表不会替代 `usePreviousAuditEvidence=false`。

Operation handler 不保存 Feature 计划，不实现业务界面，也不修改 Connector。任何身份漂移、跨 Workspace、缺失并发令牌，或只有布尔值而缺少 OE 实体的状态均失败关闭。
