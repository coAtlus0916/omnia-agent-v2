# 底稿编制 Feature __FEATURE_VERSION__

当前版本只完成两个真实步骤：

1. 从当前 Connector authority 与显式安全锁 Workspace 中读取 GRA，并且只允许选择一个 `Application` GRA。
2. 读取该 GRA 的真实 Control 目录，逐项核验 Control、Work Item、APP、GRA、Workspace 与 Tab 201 并发令牌；用户确认后，将 `planningOperatingEffectivenessTesting` 设置为 `true`，随后必须读回同一个 Control 的 OE 实体和唯一 Tab 209 令牌。

所有选择、确认、执行进度、失败和待核验状态只投影在 Feature 工作台，不写入 Comments。

目录工作台使用通用 `selectionBrowser.fixed_footer_split` 声明：底部固定显示同一后端投影的状态、已选数与真实操作按键；中部 Workspace/GRA 层级与当前 Application GRA 分列并各自纵向滚动。窗口收窄后分列受控地上下重排，底栏不会被目录内容推离视口。该布局不含 Feature ID 特判、前端状态或模拟操作。

## 安全与真实性

- Feature Worker 保存计划、一次性确认、Core intent、command、Operation receipt、读回证据和 Managed Content 投影。
- 签名 Operation package 只声明本 Feature 所需的 Omnia 路由；没有修改 Connector、Bridge 或 Pack 页面。
- PATCH 响应不确定时不会重放。用户只能触发同一 command、同一 Control、同一冻结计划的只读 reconcile。
- 已经打开的隐藏 Tab 仍必须同时具备 OE 实体和唯一 Tab 209 令牌；只有布尔值为真不算成功。
- CPython 只使用 release 托管的 3.13.14，负责参数化、确定性的 Control 计划构建；禁止开发机 Python fallback。
- 当前只支持 APP GRA；其他 GRA 类型不会进入可选择目录。

## 证据边界

V4 录制和代码能够证明 APP/GRA/Control 目录、Control 精确读取、Control PATCH 与 concurrency token 合同。V4 的旧缺陷是把未显示的 OE Tab 标成 `skipped_hidden_tab`，没有先开启 `planningOperatingEffectivenessTesting`。本版本补齐了 Tab 201 PATCH 与 Tab 209 读回闭环。

现有录制没有包含这一次隐藏 Tab PATCH 的成功实机回执，所以候选包只能声明自动化和合同测试通过；待用户恢复公司登录后，仍需在真实 Pack 做一次受控 canary，不能提前声称实机验证完成。
