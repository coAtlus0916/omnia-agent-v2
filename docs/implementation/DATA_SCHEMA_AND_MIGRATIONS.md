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

## Migration 9：Remote-only binding 与旧 mode 退役（Shell 0.4.2）

Migration 9 前向、事务化、幂等地增加 Remote binding/pairing/audit 状态。当前实现的精确表名和列以 `src/main/database.ts` 的 migration 与测试为准，但所有权和迁移语义固定如下：

| 数据 | Owner / 规则 |
|---|---|
| Remote binding | Core；保存 Pair ID、Connector identity/version/platform、protocol、generation、lifecycle、last verified time 和加密 credential，不保存明文 token |
| Pairing state | Core；保存当前短期 session、expiry、expected old binding 和实例加密 polling secret 以支持崩溃恢复；一次性链接码绝不入库，poll secret 不成为长期设备凭据且完成/过期/取消即清除 |
| Binding audit | Core 追加式；记录 migrate/pair/activate/replace/revoke/repair，不含 token、链接码或密文 |
| Bridge binding | Bridge 独立持久 store；保存 active/candidate/revoked generation 与 credential verifier，不进入 Shell Core DB |

旧 `connection_settings.mode` 从本 migration 起不再是产品运行语义：

- 旧 `remote` 且 credential 可恢复时迁移为 Remote binding，仍须启动后实时验证 Bridge、Connector 和 protocol；数据库中有 token 不等于 connected。
- 旧 `local` 迁移为 Remote `unpaired`，不复制 Local `connection_state`、Edge profile、port state 或 instance lock。
- credential 解密失败、已撤销或身份/协议不兼容时迁为 `repair_required`，不降级明文、不 fallback Local。
- Migration 9 的审计 decision 明确区分 `fresh_remote_unpaired`、`migrated_remote_binding_pending_live_validation` 与 `local_retired_remote_unpaired`，避免把全新安装误记为 Local 退役。
- Migration 10 在 Migration 9 已把必要来源写入加密审计后删除旧 `connection_settings` 表；0.4.2 不再保留、更新或读取 active mode，也不向 Renderer 暴露 mode switch。

Migration 9 不修改聊天、附件、Feature/Documentation Registry、Feature Store、Managed Content、Evidence、Workspace/Safety、AI 设置或 LayoutPreference。升级/回滚只切换 release；`data/` 不被覆盖或清空。完整矩阵见 [Remote-only 迁移说明](REMOTE_ONLY_MIGRATION.md)。

## Migration 11：可恢复配对与解除绑定（Shell 0.4.2）

Migration 11 增加 `remote_pairing_pending`、`remote_revocation_pending` 与 append-only `remote_binding_events`。前者在任何 Bridge await 前先保存 `creating` reservation，Bridge 返回后再持久化 session ID、加密 poll secret、expiry、expected old binding CAS 身份以及两阶段 commit/cleanup 状态；绝不保存一次性链接码。Shell 崩溃或重启后可继续 poll ready/active candidate，并在 old pair/generation/lifecycle 仍匹配时完成本地 binding 持久化。若普通、尚未 stage 的 pairing poll proof 损坏，不能用本地 code expiry 推断 Bridge 一小时 recovery TTL 已结束，也不能删除 pending 解锁 transport；Core 将其转为无限期 `manual_reconcile_required` tombstone，只保留 session hash 等非敏感审计定位，等待 Bridge 管理员确认 candidate 已取消、recovery TTL 已过或已 revoke 后再清理。已知 candidate cleanup token 损坏使用 `manual_cleanup_required`；解绑 token 双份均不可恢复使用 `manual_revoke_required`，三者都持续阻断生命周期和 transport。事件表记录 pairing reservation/start、activation/replacement、repair、revoke pending/completed 和损坏 pending 的非敏感顺序证据，不保存 code、secret、token 或密文。

解除绑定先以事务写入 `remote_revocation_pending` 并把 public lifecycle 置为 `repair_required`，同时保留受保护旧 credential 供后台重试。网络失败不得继续投影 `bound` 或 Connected；Bridge 返回成功，或对这次明确解除请求返回 401/403（旧凭据已不可用）后，Core 才原子清除身份并转为 `revoked`。普通 Transport 的 401/403 不等同于用户解除，仍进入 `repair_required`。
