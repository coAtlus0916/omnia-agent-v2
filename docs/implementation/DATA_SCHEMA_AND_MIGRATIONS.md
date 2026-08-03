# Shell Core 数据 Schema 与 Migration

Owner：Control & Data Plane  
物理文件：稳定产品根下 `data/stores/core.sqlite`  
实现：Node 24 `node:sqlite`，WAL、foreign keys、`synchronous=FULL`

## Migration 1：Shell 状态

| 表 | Owner/用途 |
|---|---|
| `schema_migrations` | 已提交 migration 版本与应用时间 |
| `user_preferences` | UI scale、`state_version` |
| `layout_preferences` | `shell.main` splitter basis points、layout/state version |
| `connection_state` | 最近一次真实 Connector 快照；不是 Omnia 授权 |
| `keepalive_state` | 启停、周期、最近尝试/成功/失败、下次执行 |
| `workspace_observations` | 不可变权威轻抓取 observation |
| `workspace_safety` | 当前安全锁 Pack/Workspace identity、observation 与 CAS |
| `chat_sessions` | 本地持久会话 |
| `chat_messages` | user/assistant 正文、传输状态和脱敏错误 |

## Migration 2：真实空 Registry

| 表 | 约束 |
|---|---|
| `feature_registry` | 初始为空；只统计 `lifecycle=active` |
| `documentation_registry` | 版本外键绑定 Feature；当前为空 |

本版本没有 Package Manager 可点击入口，也没有插入示例 Feature。

## 一致性

- Preference、Layout 和 Safety 更新使用 `expectedStateVersion` CAS。
- 消息创建与会话更新时间在同一 SQLite transaction。
- Workspace observation 追加写；失败的读取不会覆盖最近成功 observation。
- UI 只有在当前 Session/Pack 已核验且本次目录 `available=true` 时展示 Workspace 名称并允许保存安全锁。
- Connection snapshot 只用于恢复说明；启动后由 Connector 实时重读。

## Secret 与正文

- Omnia Authorization 只保存在 Connector 进程内存，不进 SQLite。
- Provider Key 和 Remote Shell token 使用实例 AES-256-GCM DEK 加密后写入 Core DB；
  DEK 由 Electron `safeStorage` 绑定 Windows 当前用户保护。
- 消息正文、敏感连接快照和附件存储路径均以相同实例内容加密边界写入 Core DB。
- 日志当前不记录请求 header/body、消息正文或绝对生产路径。

## 回滚

Migration 是单调、事务应用。当前没有破坏性 migration。旧程序只有在声明能读取现有 schema 时才允许回滚；本版本不提供假回滚按钮。

## Migration 3 与 Secret 边界增量（2026-07-31）

物理数据库：`data/stores/core.sqlite`。Core 使用 Node `node:sqlite`、WAL、外键、`synchronous=FULL`。

## Migration 1：Shell 基础状态

- `user_preferences`：界面缩放；Migration 3 增加 `composer_height_px`。
- `layout_preferences`：三列布局的两个可拖动边界和 CAS 版本。
- `connection_state`：最近一次 Connector 快照（加密）。
- `keepalive_state`：启停、间隔、最近尝试/成功/错误。
- `workspace_observations`、`workspace_safety`：权威轻抓取及安全锁。
- `chat_sessions`、`chat_messages`：持久化对话正文和送达状态（正文加密）。

## Migration 2：空 Feature Registry

`feature_registry` 与 `documentation_registry` 仍为空。本轮没有业务 Feature 或可点击的假入口。

## Migration 3：附件、AI 设置与连接模式

- `user_preferences.composer_height_px`：72–360 px，重启恢复。
- `chat_attachments`：会话/消息外键、文件名、MIME、大小、SHA-256、加密存储路径、
  生命周期状态和模型送达状态。
- `ai_provider_settings`：DeepSeek/Custom、Base URL、模型、附件能力、加密 API Key、
  连通性测试结果和 CAS 版本。
- `connection_settings`：成功选择的 Local/Remote 模式、Bridge URL、Pair ID、
  加密 Shell token 和 CAS 版本。

附件实体区分两个维度：

1. `status`：`staged | attached | removed | failed`，表示本地存储/消息关系。
2. `model_delivery`：`not_attempted | sent | blocked | unconfirmed`，明确说明本次是否实际送入模型。

附件原件复制到 `data/artifacts/<uuid>/`。数据库不引用用户原始路径；预览只允许明确的图片、
文本和 PDF 类型。未知二进制可以安全存储，但不可直接预览或假称已送入模型。

## Secret 边界

- Shell API Key 和 Remote token 使用实例 AES-256-GCM DEK 加密；DEK 由 Electron
  `safeStorage` 绑定 Windows 当前用户保护。
- Remote Connector 首次配对后把 Bridge token 以 Windows DPAPI 密文写入它自己的
  v5 data root。
- Renderer 快照只含 `hasApiKey` / `remotePaired`，不含任何 Secret。
- Omnia Authorization 仍只在 Connector 进程内存中。

Migration 单调、事务化，不读写 v4 数据库或路径。
