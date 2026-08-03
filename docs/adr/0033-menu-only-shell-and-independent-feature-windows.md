# ADR-0033：Shell 第二列只保留功能菜单，Feature 使用独立窗口

状态：Accepted；默认打开位置与第三列标签行为由 ADR-0034 更新  
日期：2026-08-02  
决策来源：用户 UI 产品决策与 v4 既有交互证据  
Refines：ADR-0032 的纯菜单决定；默认独立窗口决定已由 [ADR-0034](0034-tabbed-feature-host-and-detachable-surfaces.md) 更新  
Supersedes：ADR-0010 中“结构化工作台可内嵌主 Shell”的部分

## Context

ADR-0032 第一轮方案把功能树与选中 Feature Workbench 同时放进第二列。用户复核后认为第二列应该只承担菜单，点击功能后像 v4 一样打开额外独立页面/窗口。用户还要求移除第二列“功能 / 来自已安装 Feature 的真实导航 / v0.4.0”标题栏，并让连接、刷新、保活参考 v4 的紧凑交互。

v4 证据表明：

- `web/app-shell/shell.tsx` 和 `public/styles.css` 使用 Connect/Connecting/Connected 胶囊、圆形刷新、圆形 `A` 保活，并把真实 Pack 名称作为会话副标题；
- `public/app.js` 的 `openWorkspaceToolWindow` / `openOmniaWorkflowWindow` 打开并聚焦可移动、可缩放的独立窗口；
- `public/workspace-window-boot.js` 在真实 bootstrap 完成前使用专用加载页，失败保留错误；
- v4 README 0.6.35–0.6.45 记录删除工具独立窗口、窗口内不重复 Pack 状态，以及最终只保留 Agent 消息卡确认。

v5 采用交互方向，但不复制 v4 的 Room 模型、任意 URL `window.open`、localStorage 事实同步或共享巨型 CSS。

## Decision

1. 第一列仍只保留 OA 与底部设置；空白区不显示“不放首页与功能入口”等设计说明文字。
2. 第二列只显示后台 `FeatureNavigation` 生成的纯菜单/树和真实可用状态。
3. 顶部会话栏下直接开始功能树；不显示“功能”“来自已安装 Feature 的真实导航”“v0.4.0”标题、副标题或版本栏。
4. 第二列不渲染目录、表格、筛选、上传、计划摘要或任何 Feature Workbench，也不存在功能树/工作台水平 Splitter。
5. Feature Surface 必须由受控 WindowManager/SurfaceHost 创建，入口来自已签名 Feature manifest，不由 Shell 硬编码 URL。默认 placement 已由 ADR-0034 改为第三列 docked 标签；独立窗口保留为主动弹出/最小化 placement。
6. 主 Shell 不导航离开；第三列 `Comments`、附件、进度、唯一确认卡、结果、Artifact 与聊天输入保持挂载。Feature 活动时只切换中部可见标签内容。
7. Feature Surface 通过 Core 的 FeatureContext/Run/Event/Confirmation 合同读取同一事实；主应用退出时 SurfaceHost 关闭全部 docked/detached Surface；会话/Pack/安全锁版本变化时进入只读阻断并重新 bootstrap。
8. Feature Surface 不复制 Connect/刷新/保活按钮，也不重复 Pack 状态卡；只在状态不满足时显示真实阻断。detached 窗口继承全局缩放。
9. 删除元素的目录、选择和计划创建位于隔离 Feature Surface；唯一确认/取消/进度/终止/结果卡仍只位于 `Comments`。detached Surface 只能显示非交互提示并通过真实 WindowManager action 聚焦主窗口。
10. 删除终态后，Core 发布目录失效事件；同一删除 Surface 读取新 `stateVersion` 自动刷新。
11. 主 Shell 顶部连接控件参考 v4：Connect/Connecting/Connected 胶囊，紧邻圆形刷新和圆形 `A` 保活；Connecting hover/focus 可 Cancel，Connected hover/focus 可重连；refreshing 与 connect/cancel busy 严格分离。

完整规则和 v4 证据位置见 [主界面 UI 布局规范](../design/SHELL_UI_LAYOUT_SPEC.md)。

## Consequences

正面：

- 主 Shell 保持轻量，第二列层级稳定，不被不同 Feature 的复杂 UI 挤压；
- Feature UI 与 Shell DOM/CSS/Store 天然分离，更符合独立包升级和故障边界；
- 主 Shell 第三列保持唯一聊天与高风险确认 owner；
- v4 用户熟悉的“点功能打开工具窗口”和连接控件状态得到延续。

成本：

- 需要受控 SurfaceHost/WindowManager、Feature Surface manifest、单实例键、bootstrap 和跨 renderer 事件订阅；
- docked/detached Surface 必须处理主 Shell 最小化/关闭、Pack 漂移、安全锁变化和 Feature 升级；
- 窗口焦点、屏幕外恢复、缩放同步与崩溃恢复需要额外测试；
- Feature 计划创建后要可靠聚焦主 Shell 或提示用户回主窗口处理确认。

## Alternatives

### 第二列同时显示功能树和工作台

拒绝。与用户明确要求冲突，并使第二列宽度、内部 Splitter 和复杂 Feature UI 相互耦合。

### 删除第三列聊天并用 Feature 永久替代

拒绝。ADR-0034 允许 Feature 标签暂时占用原聊天记录区域，但 `Comments` 标签、聊天事实、唯一确认、交付和底部输入区必须保留，不能被 Feature 永久替代。

### 每个 Feature 窗口复制全局连接控件和确认卡

拒绝。会形成多个操作 owner，增加并发点击、状态漂移和重复确认风险。独立窗口读取同一后台状态，但全局会话操作与确认仍归主 Shell。

### 直接复制 v4 的 `window.open + localStorage` 方案

拒绝。v5 需要受控主进程窗口、签名 manifest、Core system of record 和版本化事件，不能让 Feature 任意打开 URL 或把 localStorage 当事实。

## Verification

- 第二列 DOM 在顶部会话栏后直接出现 tree/menu；不存在标题栏和 Feature Workbench 容器。
- Feature 叶子只在 Registry 状态真实可用时调用 SurfaceHost；重复点击聚焦现有相同上下文 docked 标签或 detached 窗口。
- 窗口真实 bootstrap 失败时显示错误/重试，不展示 mock 内容。
- 打开、关闭或崩溃 Feature Surface 时，主 Shell `Comments` 聊天与确认卡保持原状态。
- 删除 Feature Surface 没有确认/取消/终止控件；这些控件只在 Comments 消息卡。
- Pack、安全锁或 FeatureContext 版本漂移会在 Feature action 前由 Core 阻断。
- Connect/刷新/保活的状态、hover/focus、busy 和可访问性测试覆盖 v4 证据语义。
