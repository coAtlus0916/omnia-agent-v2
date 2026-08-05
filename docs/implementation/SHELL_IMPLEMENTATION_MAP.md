# Shell Baseline 实现映射

版本：`0.4.12`
状态：Remote-only 发布源码；内置 recording 0.3.0、create-associate 0.2.9 与 delete-elements 0.2.1，均由 builtin bootstrap 自动安装/升级。0.4.12 固定宿主加载启动器构建的工作区代码；安全锁与 create-associate authority 只使用 Omnia 真实 `CustomWorkspaceGroup → CustomWorkspace.parentId`。Connector 仅执行固定读取和签名 Operation；Core/Worker 处理校验、规则与持久化。

SurfaceWindowManager 在 Feature action 成功或失败后向所有同 Feature/版本/Surface 实例广播 Core 最新投影。每个已授权实例保存自己的最后一份 `DeclarativeFeatureSurface`；聚焦、dock、minimize、restore 和已有实例再次 open 只能使用身份匹配的实例缓存，不得从全局 selected Surface 借用另一 Feature 的投影。Artifact 输入授权在打开文件选择器前复核当前 workflow，仅上传步骤接受 `open_file`；旧 WebContents 不能在后台已进入校验后继续导入。

Shell 顶部标签与左侧 FeatureNavigation 共用同一激活实现。已打开实例先调用 Main `surface:focus` 原子切换 native attachment，再用同一 selection epoch 同步 Core `selectFeature`；新实例只在 Core 返回真实且身份匹配的 Surface 后调用一次 `surface:open`。旧异步 completion 必须重新聚焦最新实例并把 Core selection 收敛到最新用户意图，不能覆盖当前标签。`shell:changed` 只 `ensure/update` 实例投影，不得隐式 open 或抢焦点；Comments/overlay 仅通过 visibility 合同隐藏，overlay 关闭后通过 focus 恢复。

## 范围

Shell 原装平台包含 Core Store、Feature/Documentation Registry、通用 Worker/Store/Event/Managed Content ports 和唯一 RemoteConnectorTransport。Shell 不包含 Local Connector、Transport router 或 fallback。业务不硬编码进 Shell：recording、`omnia.delete-elements@0.2.1` 与 `omnia.create-associate@0.2.9` 都保持独立签名 Feature，但随同一个 Shell 包内置并自动升级；新建与关联首次真实回传必须经过确认、逐命令权威读回，只在完整成功后记录精确 scope 的限时 capability evidence。删除图由 Worker/Core 编排，Connector 不持有业务状态。删除聊天记录仍未交付。

| 能力 | Delivery | Control & Data | Integration | 真实状态 |
|---|---|---|---|---|
| 首次配对 | 顶部 Connect 引导显示短期链接码/expiry | Core pairing session、safeStorage credential、Remote binding/generation/audit | Bridge 0.4.4 → Remote Connector 0.3.10 消费链接码 | 候选实现；真实公司电脑配对待 canary |
| 连接 | 顶部 Connect/Cancel 与分阶段状态 | `ShellService` 后台持久 Remote-only connect state；启动命令 30 秒有界、启动状态 90 秒有界，只有真实进入登录/Pack/授权/识别阶段后才保留最长 10 分钟只读 polling；Cancel 先收敛 Core 状态再通知远端 | Remote transport → Bridge → Remote Worker → `WorkstationOmniaSession` | 源码已实现有界启动与可靠取消；公司电脑离线，真实 Omnia canary 待执行 |
| 刷新 | 顶部刷新按钮与错误提示 | `ShellService.refresh` 更新 Core 状态 | Remote Worker 的 Session Core 重新加载页面、识别 Pack，并触发轻抓取 | 失败不覆盖成功 observation；真实 Pack 待 canary |
| 保活 | 启停、运行/下次/错误状态 | Core DB `keepalive_state` + 后台 5 秒调度扫描 | 到期调用真实只读 refresh | 已实现；重启恢复 |
| 安全锁 | 大弹窗、搜索、Omnia 真实所在部分折叠、组内全选、右侧完整已选列表、全局所在部分关联锁 | Core 解析 v2 原始 Facet 目录；`workspace_safety` 单事务 CAS 保存显式 Workspace IDs、Group GUID 与冻结成员；成员漂移失败关闭 | Connector 0.3.15 固定 POST `facets/byEngagementIds`；打开/保存重叠读取按完整 authority identity 单飞合并 | 真实端点与 17 Group/193 Workspace 层级已现场只读采样；缺真实 parentId 时明确未归属且不冒充全局授权 |
| 对话 | 第三列消息列表与输入区 | `chat_sessions/chat_messages` 持久化状态 | Provider 只由 Main 受控调用；未配置则不调用 | 已实现；无假回复 |
| 缩放 | 右上角/设置 `− 百分比 +`、快捷键 | `user_preferences` CAS；Main 对所有当前/新建 WebContents `setZoomFactor` | Feature view/window 继承同一值 | 0.4.1 已按实际 DPR/viewport/bounds 验证；重启恢复、无 CSS 双缩放 |
| Splitter | Feature 菜单/Tabbed Host、Comments 内容/composer、设置导航/内容 | `layout_preferences` 与 `settings.main` CAS | 不适用 | 已实现；pointer/键盘；Rail 固定且无 splitter |
| Native Surface 可见性 | Renderer 只声明 active tab/overlay | `SurfaceWindowManager` 唯一拥有 attached/visible，Comments/Settings 时附着数为 0；Shell 主窗口在 load 前订阅显示事件并在 load 后检查可见性 | Worker/Run 生命周期不随隐藏终止 | 0.4.4 修复主窗口隐藏竞态；任意时刻最多一个 docked view |
| 设置稳定布局 | 固定/clamp 外框、左右独立滚动、公共 splitter；无 Connector 子菜单 | `settings.main` LayoutPreference CAS | 配对/修复只从顶部 Connect 进入 | 继承 0.4.1；0.4.2 删除 Local/Remote/Bridge/Pair 表单 |
| 重新配对/解除绑定 | Connect 错误/详情弹层，明确确认 | candidate 原子切换、previous generation 撤销；解除不清其他用户数据 | Bridge binding store + 双端 protected credential | 自动化收口中；真实撤销/重配待 canary |

## 进程与信任边界

```text
Electron Renderer（无 Node）
  → contextIsolation + sandbox preload
  → allowlisted typed IPC
Electron Main / Core（SQLite owner、AI broker、Remote binding owner）
  → authenticated RemoteConnectorTransport
v5 Bridge 0.4.5（binding/generation/relay/heartbeat/update_check）
  → v5 Remote Connector Worker 0.3.15 / sequence 18
  → WorkstationOmniaSession（Omnia credential/session owner）
  → verified dedicated Edge CDP + signed OperationHost
```

关键约束：

- Renderer 不访问数据库、文件、Provider Key、CDP 或 Omnia。
- Connector 不接收任意 URL/method/body；基础 Shell 使用 `health/connect/status/refresh/workspace_authority_read`。Workspace 原始响应只在 Core 解析和判定；已装载的官方签名 Operation 通过固定 step gate 执行。
- Omnia host 仅允许 Deloitte Omnia HTTPS suffix；回环 CDP 必须同时匹配动态端口与精确 profile。
- Connector 退出不关闭 Edge。
- Shell package、Main 和 data root 不包含/启动 Local Connector，不创建 Edge profile/port/instance lock；Remote 故障不存在 fallback。
- 具体 Feature 的 mutation 是否可用由签名 Operation、依赖状态和真实 canary 决定；失败时明确禁用，不静默回退或重放猜测。

## Remote

`0.3.4` 至 `0.3.14` Remote Connector 和 Bridge `0.4.0` 至 `0.4.4` 均为不可变 historical previous。当前配套为 Remote Connector `0.3.15 / sequence 18` 与 Bridge `0.4.5`：0.3.15 保留 0.3.14 的真实 Facet authority，并修复跨 Realm Operation 错误信息退化。Bridge 连接时及每 60 秒下发 `update_check`，Supervisor 另以五分钟固定 stable 轮询兜底；现场已确认 0.3.14 自动升级到 0.3.15，无需用户搬包或运行安装器。

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

以下表格记录 0.2.0 当时的实施范围。它保留作验收证据，不覆盖本页顶部 Remote-only 0.4.2 状态；当时的 Local/Remote 设置已被 [ADR-0035](../adr/0035-remote-only-connector-and-link-code-pairing.md) 取代。

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

## Remote-only 传输

Remote 只暴露：

`health | connect | status | refresh | workspace_light_read`

Remote 不把任意 URL/method/body 传给 Connector；mutation 只使用官方签名 Operation。Bridge、Connector、Session 或 Pack 不可验证时失败关闭，且代码、IPC、package 和运行时均不存在 Local fallback。
# Create-and-associate host responsibilities

Shell hosts native file selection/export, no-path artifact descriptors, scoped byte transfer, Surface state persistence, Comments message cards, action-level dependency/capability gates, and lazy Operation registration. Renderer only collects declared editor values; Core validates Run/artifact ownership, revisions, template identities, and evidence.

# Interaction diagnostics

`src/main/index.ts` 的统一 IPC handler 为 Shell 与 Feature Surface 入口建立真实 interaction；原有五个 Feature Surface 直连 handler 也复用同一包装。`InteractionLogService` 负责 SQLite start/success/failure、trace/parent 关联、脱敏、崩溃恢复、滚动与受限查询。Feature Worker 调用显式传递 interaction context，签名 Connector Operation 按 preflight/execute/readback/reconcile 的 operation ID 记录子阶段；AI Provider 与逐文件附件导入补记原先会被业务状态吸收的失败。

设置 → 日志直接查询 Core 数据，不使用 sample 数据。窗口保持固定 860×680（小屏受 viewport 上限约束），日志列表与详情独立滚动；不存在清空/导出入口。该诊断不替代 Feature Run/Event/Evidence，也不改变 Remote-only、失败关闭或无 Local fallback 边界。
