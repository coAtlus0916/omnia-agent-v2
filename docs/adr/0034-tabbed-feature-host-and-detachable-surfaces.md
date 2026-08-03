# ADR-0034：第三列标签式 Feature Host 与可弹出 Surface

状态：Accepted  
日期：2026-08-02  
决策来源：用户 UI 产品决策  
Supersedes：ADR-0033 中“点击 Feature 默认打开独立窗口”和“第三列始终只显示聊天记录”的部分

## Context

第二列继续只承担纯功能菜单，但默认把每个 Feature 打开成独立窗口会造成窗口数量过多，也不利于在多个功能之间快速切换。用户要求点击功能后，先占用第三列原聊天记录区域；该区域顶部采用浏览器式标签页，永久保留 `Comments`，并按已打开 Feature 显示名称。只有用户主动选择弹出或最小化时，Feature 才转为独立窗口。

v4 的 `sidebarToggleBtn` 已证明主内容标题左侧可以提供紧凑折叠按钮，并持久化侧栏折叠状态。v5 采用这一交互语义折叠第二列功能菜单，但不复用 v4 的 Agent/Room 数据模型或 localStorage 事实模型。

## Decision

1. 第二列仍只显示后台 `FeatureNavigation` 纯菜单，不加载 Feature DOM、CSS 或业务 Store。
2. 第三列由 Shell 拥有一个 `TabbedFeatureHost`：顶部是标签栏，中部是聊天记录或当前 Feature Surface，底部聊天输入区始终保留。Global Session Bar 与标签栏之间不设置 Conversation Header；删除“Omnia Agent”、聊天说明和常驻 AI Provider 状态。Provider 状态只在 AI 设置页和真实请求错误中呈现。
3. `Comments` 是固定首个标签，不可关闭、不可弹出、不可最小化。它显示聊天消息、Feature 进度、唯一确认卡、结果和 Artifact。
4. 点击可用 Feature 叶子时，默认调用 `openFeatureSurface(featureId, contextVersion, placement="docked")`，在第三列新增或聚焦以真实 Feature 名称显示的标签。相同 `featureId + FeatureContextId` 不重复创建实例。
5. 多个 docked Feature 以浏览器式标签切换；同一时间只显示一个标签内容。切换只改变当前 Surface 可见性，不取消 Run、不丢失已持久状态，也不把隐藏标签的前端缓存当成事实。
6. Feature 内容虽然视觉上嵌在第三列，但仍运行在 Shell 管理的独立、无特权、sandboxed renderer/WebContents 中，通过版本化 Shell UI Bridge 访问 Core。禁止把 Feature 包代码直接 import 到 Shell renderer，禁止共享 DOM、CSS 或内存 Store。
7. 第二列折叠按钮位于第三列标签栏最左侧、紧邻第二/第三列边界，视觉和可访问语义参考 v4 三横线按钮。折叠后第二列及其 Splitter 宽度归零，第三列扩展；按钮始终可见，可再次展开。折叠状态由 Core `LayoutPreference` 持久化，默认展开。
8. 当活动标签是 Feature 时，内容头部右上角显示且只显示三个窗口动作：
   - `↗` 弹出：把同一 Surface 迁移为正常显示的独立 Feature 窗口；
   - `−` 最小化：把同一 Surface 迁移为独立窗口，并在完成 bootstrap/状态接续后直接最小化到 Windows 任务栏，不闪现第二份可操作界面；
   - `×` 关闭：关闭该 Feature UI 实例和标签，不卸载 Feature，也不自动取消已提交的 Run。
9. Surface 弹出或最小化后，从主标签栏移除；第二列菜单保留“已在独立窗口打开”的真实状态。再次点击该菜单叶子时恢复/聚焦现有窗口，不创建第二实例。独立窗口关闭后，再次点击菜单会新建 docked 标签。
10. 如果 Feature 有未保存的本地输入，`×` 必须通过统一 Surface lifecycle 返回真实 dirty 状态并使用标准关闭确认；没有 dirty 状态时立即关闭。进行中的 Run 属于 Core，不因关闭 UI 而取消；停止必须通过 Feature 自己绑定 Run 的真实终止 action。
11. 用户从 Feature 主动创建需要立即处理的高风险确认时，Shell 切换到 `Comments` 并聚焦唯一确认卡。后台异步产生的进度或结果不抢焦点，只在 `Comments` 标签显示状态标记和可访问通知。
12. 标签标题、可用状态和 Surface 入口全部来自已签名 Feature manifest 与后台 Registry；Shell 不硬编码未安装功能，也不允许任意 URL。未安装、禁用、不兼容、不健康或未授权 Feature 不生成可用标签。
13. Pack、Transport、安全锁或 FeatureContext 漂移时，docked 与 detached Surface 使用同一版本检查进入只读阻断/重新 bootstrap；不得继续使用旧视图提交 mutation。
14. 主应用退出时关闭全部 docked/detached Surface。首次实现不跨应用重启恢复标签；重启后仅显示 `Comments`，仍在 Core 中运行的任务通过消息和事件恢复，不重新提交。

## Surface 状态机

```text
closed
  └─ menu click ─> docked(active tab)
                     ├─ switch tab ─> docked(background)
                     ├─ ↗ ─> detached(visible)
                     ├─ − ─> detached(minimized)
                     └─ × ─> closed

detached(visible/minimized)
  ├─ menu click ─> restore/focus same window
  └─ window close ─> closed
```

`placement` 变化只改变 Surface 宿主，不改变 `surfaceInstanceId`、`featureId`、`FeatureContextId`、Run 或后台事实版本。

## Consequences

正面：

- 默认工作流不产生大量 Windows 窗口；
- `Comments`、多个 Feature 和聊天输入区集中在一个稳定区域；
- 需要多屏或长时间后台运行时仍可主动弹出/最小化；
- Feature 包与 Shell renderer 继续保持进程、DOM、CSS 和权限隔离。

成本：

- Shell 需要 `TabbedFeatureHost`、受控 sandboxed Surface 容器和 placement 状态机；
- docked/detached 迁移必须处理焦点、dirty 状态、屏幕外恢复、bootstrap 和崩溃；
- 标签溢出、键盘导航、最小化到任务栏和 DPI/缩放需要真机测试。

## Rejected Alternatives

### 点击功能后默认打开独立窗口

拒绝作为默认行为。独立窗口只保留为用户主动弹出/最小化后的 placement。

### 把 Feature 包直接渲染进 Shell DOM

拒绝。视觉嵌入不代表信任边界合并；Feature 仍必须使用隔离 renderer/WebContents 和受控 Bridge。

### 最小化仅隐藏主界面标签

拒绝。用户明确要求最小化后成为独立页面，因此动作必须先迁移到独立窗口，再调用原生最小化。

### 关闭 Feature 时自动停止任务

拒绝。关闭 UI 与终止后台任务语义不同；危险或不可重放 Run 不能因窗口动作被隐式取消。

## Verification

- 折叠按钮可通过鼠标和键盘折叠/展开第二列；折叠后无残留空列或可拖动 Splitter，重启恢复最后确认状态。
- 点击两个真实已安装 Feature 后出现两个不同标签；`Comments` 始终是首个且不可关闭。
- 切换标签不丢失后台已确认状态，不创建重复 Worker/Run/Surface。
- Feature 活动时右上角出现 `↗ / − / ×`；`Comments` 活动时不显示这三个 Feature 动作。
- `↗` 只产生一个正常独立窗口，`−` 只产生一个已最小化独立窗口；菜单点击恢复/聚焦原窗口。
- `×` 关闭 UI 但不卸载 Feature、不删除数据、不隐式终止 Run；dirty 状态得到一次标准确认。
- 创建删除计划后自动切到 `Comments` 的唯一确认卡；docked、detached 或第二列都没有第二套确认。
- Feature renderer 崩溃、Pack 漂移或 Bridge 失配显示真实错误/阻断，不用静态内容冒充功能。

## 2026-08-03 实现澄清：原生视图可见性

本节澄清既有决策，不改变 Feature/Shell 边界：`placement`、Feature Run/Worker 生命周期和当前可见/附着状态是三个独立维度。`docked(background)` 表示实例和其 WebContents 可以保留，但不表示它仍附着在 Shell `contentView`。

- `SurfaceWindowManager` 是 native attachment 的唯一 owner；Renderer 只声明当前活动 docked instance 以及 Shell overlay 是否打开。
- 任意时刻最多一个 docked `WebContentsView` 附着并显示。活动 `Comments` 或 Settings/modal overlay 时附着集合必须为空；关闭 overlay 并返回 Feature 时才重新附着正确实例并按最新宿主几何计算 bounds。
- 切换标签、折叠菜单或移动 splitter 只调和当前活动实例。隐藏不会关闭 WebContents、停止 Worker 或终止 Run；关闭标签/窗口才清理对应 UI instance。
- Renderer/Feature render process gone、窗口重复关闭或实例已经不存在时，detach、sender authorization 清理和 close 必须幂等。detached window 的 `closed`、`webContents.destroyed` 与 `render-process-gone` 使用对称清理，但不得触碰业务 Worker/Run。

自动化通过 manager snapshot 同时验证 attached instance 上限、Comments/Settings 附着数为 0、detached sender 映射在关闭后移除以及重返 Feature 后 bounds 恢复。CSS `z-index` 不能解决 `WebContentsView` 的原生层级，因此不属于可接受方案。
