# Shell Baseline 实现映射

版本：`0.4.18`
状态：2026-08-14 `integration/remote` 当前源码映射。Connector Next v3 是唯一 Connector 产品链；旧 Bridge、旧 Remote Connector 和 Local fallback 已退出当前构建与运行选择。标准 Shell baseline、公司 loopback profile 和 Feature 源码候选是不同状态，精确集合见 [Feature 包总览](FEATURE_PACKAGE_CATALOG.md)。

SurfaceWindowManager 在 Feature action 成功或失败后向所有同 Feature/版本/Surface 实例广播 Core 最新投影。每个已授权实例保存自己的最后一份 `DeclarativeFeatureSurface`；聚焦、dock、minimize、restore 和已有实例再次 open 只能使用身份匹配的实例缓存，不得从全局 selected Surface 借用另一 Feature 的投影。Artifact 输入授权在打开文件选择器前复核当前 workflow，仅上传步骤接受 `open_file`；旧 WebContents 不能在后台已进入校验后继续导入。

Connector/Pack 在线与安全锁有效性是两个独立状态。同一 Connector 和同一权威 Pack 在重连后产生新 `sessionGeneration` 时，Shell 仍投影真实在线，但旧安全锁继续失败关闭。安全锁恢复状态由 `ShellService` 统一投影；重新验证必须再次执行真实 Workspace authority read，并在 Connector、authority、tenant、Pack、Engagement 和 Workspace 成员满足合同后才保存。Renderer 不通过本地布尔值恢复写权限。

Shell 顶部标签与左侧 FeatureNavigation 共用同一激活实现。已打开实例先调用 Main `surface:focus` 原子切换 native attachment，再用同一 selection epoch 同步 Core `selectFeature`；新实例只在 Core 返回真实且身份匹配的 Surface 后调用一次 `surface:open`。旧异步 completion 必须重新聚焦最新实例并把 Core selection 收敛到最新用户意图，不能覆盖当前标签。`shell:changed` 只 `ensure/update` 实例投影，不得隐式 open 或抢焦点；Comments/overlay 仅通过 visibility 合同隐藏，overlay 关闭后通过 focus 恢复。

## 范围

Shell 原装平台包含 Core Store、Feature/Documentation Registry、通用 Worker/Store/Event/Managed Content ports、声明式 Surface Host 和唯一 `ConnectorNextTransport`。Shell 不包含 Feature 业务算法、Local Connector、旧 Transport router 或静默 fallback。业务 Feature 均保持独立签名包；哪些版本随产品内置由单一 builtin release inventory 决定，不能从源码目录或最新候选文件自动推导。删除聊天记录仍未交付，当前 UI 不应出现可点击入口。

| 能力 | Delivery | Control & Data | Integration | 真实状态 |
|---|---|---|---|---|
| Connector 配置 | 正常产品 UI 不展示任意服务器、token 或 target 编辑器 | Main 从持久设置、受控开发环境或 packaged loopback marker 取得 exact `serverUrl + controlToken + target`；不完整即启动失败 | `EmbeddedConnectorNextHost` 只在 company loopback profile 启动本包 Server/Agent | 没有可伪造的前端入口；Secret 不返回 Renderer。 |
| 连接 | 顶部 Connect/Cancel 与分阶段真实状态 | `ShellService` 持久化连接、安全锁和恢复状态 | `ConnectorNextTransport` 经 Server durable job 到 exact Agent，再由工作站 Session Core 连接 Pack | 源码已接通；是否 live accepted 由精确产物和目标 Pack canary 决定。 |
| 刷新 | 顶部刷新按钮与错误提示 | `ShellService.refresh` 只读调和 Core 状态和 Workspace 权威目录 | Connector Next `status/refresh/lightRead` 合同；不把任意 URL/method/body 交给 Agent | 失败不覆盖已验证 observation，也不恢复失效安全锁。 |
| 保活 | 启停、运行/下次/错误状态 | Core DB `keepalive_state` + 后台 5 秒调度扫描 | 到期只调用 `status`；不启动、聚焦、刷新或关闭受控浏览器 | 已实现；重启恢复 |
| 安全锁 | 工作台展示真实 Workspace 目录、选择和恢复原因 | Core 以 CAS 保存 authority observation、精确 Workspace IDs 与 session generation；成员或身份漂移失败关闭 | Connector Next 执行权威轻读取；Feature mutation 仍在预检和提交前重新验证 | 2026-08-14 已统一恢复状态；真实 Pack 身份和成员关系仍以当前读取为准。 |
| 对话 | 第三列消息列表与输入区；用户消息落库后立即可见 | `chat_sessions/chat_messages` 持久化 user/assistant 两阶段状态 | Provider 只由 Main 受控调用；系统提示包含 Omnia Agent 身份、保密边界和不可替代专业判断 | Provider 未配置或失败时不造假回复；失败保留真实用户消息。 |
| 缩放 | 右上角/设置 `− 百分比 +`、快捷键 | `user_preferences` CAS；Main 对所有当前/新建 WebContents `setZoomFactor` | Feature view/window 继承同一值 | 0.4.1 已按实际 DPR/viewport/bounds 验证；重启恢复、无 CSS 双缩放 |
| Splitter | Feature 菜单/Tabbed Host、Comments 内容/composer、设置导航/内容 | `layout_preferences` 与 `settings.main` CAS | 不适用 | 已实现；pointer/键盘；Rail 固定且无 splitter |
| Native Surface 可见性 | Renderer 只声明 active tab/overlay | `SurfaceWindowManager` 唯一拥有 attached/visible，Comments/Settings 时附着数为 0；Shell 主窗口在 load 前订阅显示事件并在 load 后检查可见性 | Worker/Run 生命周期不随隐藏终止 | 0.4.4 修复主窗口隐藏竞态；任意时刻最多一个 docked view |
| 设置稳定布局 | 固定/clamp 外框、左右独立滚动、公共 splitter；无旧 Connector/Bridge 表单 | `settings.main` LayoutPreference CAS | Connector Next 设置不暴露 Secret | 已实现；无 Local/Remote 模式切换。 |
| 交互诊断 | 当前主导航隐藏日志菜单，不提供清空/导出假入口 | `InteractionLogService` 仍记录 start/success/failure、崩溃恢复、严格脱敏和受限查询；保留期为 1 天，上限 20,000 行 | Feature/Operation/AI 子阶段沿 trace 关联 | 诊断状态是真实 Core 数据；隐藏菜单不删除后台合同，也不把日志冒充 Run/Evidence。 |
| Feature 包运行 | 导航和 Surface 完全来自已验签 manifest/active head | `FeaturePackageManager`、每 Feature Worker、私有 Store、Artifact、Command/Receipt 和交接 ledger | Feature 只经自身签名 Operation 调用 Connector Next | 候选、安装、便携和 live canary 状态必须分别记录。 |

## 进程与信任边界

```text
Electron Renderer（无 Node）
  → contextIsolation + sandbox preload
  → allowlisted typed IPC
Electron Main / Core（SQLite owner、AI broker、Feature/activation owner）
  → authenticated ConnectorNextTransport
Connector Next Server（durable jobs/results/logs/update state）
  → exact target Agent（agentId + deviceId + connectorInstanceId）
  → WorkstationOmniaSession / ShellFeatureHost
  → verified browser session + signed Pack OperationHost
```

关键约束：

- Renderer 不访问数据库、文件、Provider Key、CDP 或 Omnia。
- Connector 不接收任意 URL/method/body；业务调用只能解析到已注册、已签名 Operation 的固定 route/effect/policy。Workspace 原始响应只通过受控读取合同进入 Core；已装载 Operation 通过固定 step gate 执行。
- Omnia host 仅允许 Deloitte Omnia HTTPS suffix；回环 CDP 必须同时匹配动态端口与精确 profile。
- Connector 退出不关闭 Edge。
- Shell 不包含旧 Local Connector 或旧 Bridge 客户端。company loopback profile 启动的 Connector Next Server/Agent 与 remote-test profile 使用相同协议和业务合同，不是 Local fallback 或第二套 Feature 实现。
- 具体 Feature 的 mutation 是否可用由签名 Operation、依赖状态和真实 canary 决定；失败时明确禁用，不静默回退或重放猜测。

## Connector Next

当前产品身份是 `com.deloitte.omnia-agent.connector-next`，协议是 `omnia.connector-next/v3`。服务端、Agent、Updater、Bootstrap、Installer、日志 spool、A/B 槽和 update offer 均位于 `src/connector-next`；Shell 侧只持有 exact target 和受保护 control credential。

远端联调与 company loopback 只改变部署 topology：前者连接外部 Connector Next Server/Agent，后者由 Shell EXE 在本机启动包内 Server/Agent。两者使用相同 Feature/Operation 合同，Transport 不可用时明确失败。Connector Next 的发布版本由签名候选 manifest 和部署记录决定，源码默认值 `0.1.0 / sequence 1` 仅用于未配置开发启动，不能被文档写成当前正式发布版本。

## AI

设置页支持 DeepSeek 与 OpenAI-compatible Custom 的 Base URL、模型、附件能力和 API Key。
Key 在 Main 进入数据库前使用 AES-256-GCM 加密，实例 DEK 由 Electron `safeStorage` 绑定
Windows 当前用户保护；Renderer 只看到 `hasApiKey`。连通性测试真实调用 `/models`，
发送真实调用 `/chat/completions`。未配置或失败时持久化真实状态，不创建假 assistant 消息。

## 已知开发后门禁

真实 canary 前仍需验证：

1. 目标 Omnia 版本的真实 hierarchy 与授权请求捕获；
2. `facets/byEngagementIds` 在安全锁保存时的第二次实时读取与成员冻结读回；
3. Windows 10/11 代表性 ThinkPad 的 Edge、杀软、系统缩放与资源表现；
4. 用户真实 Provider Key 下的模型清单、附件能力、超时、错误分类和数据处理边界。

canary 未通过不改变失败关闭语义。

## 历史快照：正式版实施增量（2026-07-31）

以下表格记录 0.2.0 当时的实施范围。它只保留作历史说明，不覆盖本页顶部 Connector Next v3 / Shell 0.4.18 状态；当时的 Local/Remote 设置与 Bridge 产品链均已退出当前构建。

版本：0.2.0。范围仍只有三列首页 Shell，无业务 Feature。

| 能力 | Renderer | Core / 数据 | 真实外部边界 |
|---|---|---|---|
| 连接/刷新/保活 | 首页状态与按钮 | `ShellService`、SQLite | 统一 `ConnectorTransport` |
| Local | 设置选择 Local | 上次成功模式持久化 | 独立子进程、Edge/CDP |
| Remote | 设置配对与切换 | Bridge token 加密 | WSS Bridge → Remote Connector |
| 安全锁 | Section/Workspace 树 | observation + CAS | 权威轻抓取 |
| 对话 | 第三列消息 | 加密正文 | OpenAI-compatible Provider |
| 附件 | 选择、管理、预览、移除、送达标记 | `chat_attachments` + `data/artifacts` | 按 Provider 能力实际构造输入 |
| AI 设置 | 真实设置页 | API Key 加密、测试状态 | DeepSeek 或 Custom `/models`、`/chat/completions` |
| 布局 | 两个竖向分隔条、输入区横向分隔条、全局缩放 | 持久化偏好 | 不适用 |

## 附件能力

- DeepSeek 在当前合同中固定为 `text_only`。
- Custom 可由用户声明 `text_only`、`images` 或 `images_and_text`。
- 图片模型输入上限 10 MB；文本模型输入上限 1 MB 且必须是有效 UTF-8。
- 其他格式可保存和管理，但发送时阻断并持久化 `model_delivery=blocked`。
- Provider 请求失败时使用 `unconfirmed`，不会声称模型已收到。

## AI 安全

Base URL 必须 HTTPS，禁止 URL 凭据、查询参数、localhost、私网、链路本地地址；请求前再次
解析 DNS 并拒绝任何私网结果。测试只在 `NODE_ENV=test` 允许 loopback。

Custom 仅声明 OpenAI-compatible 合同。它可填写 Nova API 地址，但没有验证 Nova 专有协议。

## Connector Next-only 传输

Shell 侧通用 Transport 暴露连接、刷新、权威轻读取、签名 Operation 注册/调用，以及 durable delivery 状态与 ACK。Connector Next Server/Agent 负责真实 job/result/receipt 交付，不把 Feature 业务塞入传输层。

任意 URL/method/body 不会从 Shell 透传给 Connector；mutation 只使用官方签名 Operation。Server、Agent、Session、Pack binding、Operation 或安全锁不可验证时失败关闭，且代码、IPC、package 和运行时均不存在旧 Local/Bridge fallback。
# Create-and-associate host responsibilities

Shell hosts native file selection/export, no-path artifact descriptors, scoped byte transfer, Surface state persistence, Comments message cards, action-level dependency/capability gates, and lazy Operation registration. Renderer only collects declared editor values; Core validates Run/artifact ownership, revisions, template identities, and evidence.

# Interaction diagnostics

`src/main/index.ts` 的统一 IPC handler 为 Shell 与 Feature Surface 入口建立真实 interaction；原有五个 Feature Surface 直连 handler 也复用同一包装。`InteractionLogService` 负责 SQLite start/success/failure、trace/parent 关联、脱敏、崩溃恢复、滚动与受限查询。Feature Worker 调用显式传递 interaction context，签名 Connector Operation 按 preflight/execute/readback/reconcile 的 operation ID 记录子阶段；AI Provider 与逐文件附件导入补记原先会被业务状态吸收的失败。

日志查询合同直接读取 Core 数据，不使用 sample 数据；当前 Shell 主导航隐藏日志菜单，也不存在清空/导出入口。保留期为 1 天，容量上限为 20,000 行。该诊断不替代 Feature Run/Event/Evidence，也不改变 Connector Next-only、失败关闭或无 fallback 边界。
