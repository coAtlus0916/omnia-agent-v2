# Shell Baseline 实现映射

版本：`0.4.2`
状态：Remote-only 候选；继承 Shell 0.4.1 UI regression patch。录制沿用当前独立签名 patch，删除元素 0.1.2 为独立后装 Feature。公司电脑真实 Remote Pack canary 未通过/待 canary。

## 范围

Shell 原装平台包含 Core Store、Feature/Documentation Registry、通用 Worker/Store/Event/Managed Content ports 和唯一 RemoteConnectorTransport。Shell 不包含 Local Connector、Edge/CDP Session Core、Transport router 或 fallback。业务不硬编码进 Shell：当前 recording patch 作为独立签名 Feature 随便携包携带并首次启动自动升级/注册；删除元素 0.1.2 作为独立签名 Feature按需后装。删除聊天记录、新建与关联仍未交付。

| 能力 | Delivery | Control & Data | Integration | 真实状态 |
|---|---|---|---|---|
| 首次配对 | 顶部 Connect 引导显示短期链接码/expiry | Core pairing session、safeStorage credential、Remote binding/generation/audit | Bridge 0.4.1 → Remote Connector 0.3.5 消费链接码 | 候选实现；真实公司电脑配对待 canary |
| 连接 | 顶部 Connect/Cancel 与分阶段状态 | `ShellService` 持久 Remote-only connect state，最长 10 分钟只读 polling | Remote transport → Bridge → Remote Worker → `WorkstationOmniaSession` | 自动化收口中；真实 Omnia canary 待执行 |
| 刷新 | 顶部刷新按钮与错误提示 | `ShellService.refresh` 更新 Core 状态 | Remote Worker 的 Session Core 重新加载页面、识别 Pack，并触发轻抓取 | 失败不覆盖成功 observation；真实 Pack 待 canary |
| 保活 | 启停、运行/下次/错误状态 | Core DB `keepalive_state` + 后台 5 秒调度扫描 | 到期调用真实只读 refresh | 已实现；重启恢复 |
| 安全锁 | 权威 Section/Workspace 树与保存 | `workspace_observations`、`workspace_safety`、CAS 与目标校验 | `workspace_light_read` 只读 Operation | 已实现；缺 `parentSectionId` 失败关闭 |
| 对话 | 第三列消息列表与输入区 | `chat_sessions/chat_messages` 持久化状态 | Provider 只由 Main 受控调用；未配置则不调用 | 已实现；无假回复 |
| 缩放 | 右上角/设置 `− 百分比 +`、快捷键 | `user_preferences` CAS；Main 对所有当前/新建 WebContents `setZoomFactor` | Feature view/window 继承同一值 | 0.4.1 已按实际 DPR/viewport/bounds 验证；重启恢复、无 CSS 双缩放 |
| Splitter | Feature 菜单/Tabbed Host、Comments 内容/composer、设置导航/内容 | `layout_preferences` 与 `settings.main` CAS | 不适用 | 已实现；pointer/键盘；Rail 固定且无 splitter |
| Native Surface 可见性 | Renderer 只声明 active tab/overlay | `SurfaceWindowManager` 唯一拥有 attached/visible，Comments/Settings 时附着数为 0 | Worker/Run 生命周期不随隐藏终止 | 0.4.1；任意时刻最多一个 docked view |
| 设置稳定布局 | 固定/clamp 外框、左右独立滚动、公共 splitter；无 Connector 子菜单 | `settings.main` LayoutPreference CAS | 配对/修复只从顶部 Connect 进入 | 继承 0.4.1；0.4.2 删除 Local/Remote/Bridge/Pair 表单 |
| 重新配对/解除绑定 | Connect 错误/详情弹层，明确确认 | candidate 原子切换、previous generation 撤销；解除不清其他用户数据 | Bridge binding store + 双端 protected credential | 自动化收口中；真实撤销/重配待 canary |

## 进程与信任边界

```text
Electron Renderer（无 Node）
  → contextIsolation + sandbox preload
  → allowlisted typed IPC
Electron Main / Core（SQLite owner、AI broker、Remote binding owner）
  → authenticated RemoteConnectorTransport
v5 Bridge 0.4.1（binding/generation/relay/heartbeat）
  → v5 Remote Connector Worker 0.3.5 / sequence 8
  → WorkstationOmniaSession（Omnia credential/session owner）
  → verified dedicated Edge CDP + signed OperationHost
```

关键约束：

- Renderer 不访问数据库、文件、Provider Key、CDP 或 Omnia。
- Connector 不接收任意 URL/method/body；基础 Shell 使用 `health/connect/status/refresh/workspace_light_read`，已装载的官方签名 Operation 通过固定 step gate 执行。
- Omnia host 仅允许 Deloitte Omnia HTTPS suffix；回环 CDP 必须同时匹配动态端口与精确 profile。
- Connector 退出不关闭 Edge。
- Shell package、Main 和 data root 不包含/启动 Local Connector，不创建 Edge profile/port/instance lock；Remote 故障不存在 fallback。
- 具体 Feature 的 mutation 是否可用由签名 Operation、依赖状态和真实 canary 决定；失败时明确禁用，不静默回退或重放猜测。

## Remote

`0.3.4 / sequence 7` Remote Connector 和 `0.4.0` Bridge 是不可变 historical previous。0.4.2 配套候选为 Remote Connector `0.3.5 / sequence 8` 与 Bridge `0.4.1`：删除 waiting discovery/匿名候选认领，改为顶部 Connect 创建短期链接码、公司电脑 Connector 消费、双端保存长期受保护 credential。普通重启/断线不重新配对；撤销/不可恢复进入 `repair_required`。`state` envelope、heartbeat freshness、协议兼容和 Pack Session 分开投影。具体真实 Pack、录制与 mutation 仍待公司电脑 canary。

## AI

设置页支持 DeepSeek 与 OpenAI-compatible Custom 的 Base URL、模型、附件能力和 API Key。
Key 在 Main 进入数据库前使用 AES-256-GCM 加密，实例 DEK 由 Electron `safeStorage` 绑定
Windows 当前用户保护；Renderer 只看到 `hasApiKey`。连通性测试真实调用 `/models`，
发送真实调用 `/chat/completions`。未配置或失败时持久化真实状态，不创建假 assistant 消息。

## 已知开发后门禁

真实 canary 前仍需验证：

1. 目标 Omnia 版本的真实 hierarchy 与授权请求捕获；
2. `liveindex/menu/sections` 是否为每个 Workspace 提供可证明的 Section identity；
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
