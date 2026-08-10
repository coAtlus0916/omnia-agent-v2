# Remote-only 升级迁移说明

当前目标版本：Shell `0.4.3`、Bridge `0.4.2`、Remote Connector `0.3.7 / sequence 10`。本页主体保留 0.4.2 完成 Remote-only 迁移时的数据库与回滚合同；0.4.3 不恢复 Local，也不改变其失败关闭边界。
日期：2026-08-03
状态：代码与自动化验收随本次升级收口；公司电脑真实 Pack canary 未通过/待 canary

## 用户可见变化

- Shell 不再提供 Local Connector，也不再显示 Local/Remote 模式切换。
- 设置中删除完整 Connector 子菜单；AI、安全锁和其他有真实后端的设置保持。
- 顶部 Connect 是首次配对、连接 Pack、诊断、重新配对和解除绑定的唯一入口。
- 未配对时，Shell 展示一次性链接码；用户在公司电脑 Remote Connector 输入。配对完成后正常启动、重启和断线恢复不再需要链接码。
- Remote/Bridge/公司电脑不可用时明确失败，不会在 Shell 电脑上启动 Local fallback。

## 数据库升级

Migration 9、10、11 是前向、事务化、幂等迁移。Migration 9 新增 Remote-only binding/state/audit 存储并停止把旧 `connection_settings.mode` 作为产品事实读取；Migration 10 在迁移证据落入审计表后删除旧 `connection_settings` 表；Migration 11 增加不含链接码的可恢复 pairing handoff 和 fail-closed revocation pending。

迁移矩阵：

| 旧状态 | 新状态 | 数据处理 |
|---|---|---|
| `mode=remote` 且 Shell credential 可解密、Pair ID 非空 | Remote binding candidate/active migration | 迁移非敏感 identity、generation 和受保护 credential；启动后必须经 Bridge/Connector 实时验证，不能因 token 存在直接显示 connected |
| `mode=remote` 但 credential 不可恢复、已撤销或协议不兼容 | `repair_required` | 保留审计摘要，不回显密文；用户从 Connect 发起新配对 |
| `mode=local` | `unpaired` | 不迁移 Local snapshot、profile、port、lock 或 Session；首次点击 Connect 进入链接码引导 |
| 旧记录缺失 | `unpaired` | 建立默认 Remote-only 状态 |

Migration 9 的审计 decision 分别使用 `fresh_remote_unpaired`、`migrated_remote_binding_pending_live_validation` 和 `local_retired_remote_unpaired`。旧 `connection_settings` 只在 Migration 9 事务中作为迁移来源；Migration 10 随后删除该表，审计证据保存在 `connector_migration_audit`。0.4.2 运行时不再更新 active mode。`connection_state` 中旧 Local 快照不能转换成 Remote 在线或 Pack connected。

迁移明确不修改：

- `chat_sessions`、`chat_messages`、`chat_attachments`；
- Feature Registry、Feature activation、Feature 私有 Store 和已安装 `.ofp`；
- Managed Content、Workspace observation、安全锁、Evidence 和 Documentation Registry；
- UserViewPreference、LayoutPreference 与 Settings splitter；
- `data/` 根之外或 v4 工作区的任何文件。

## Secret 与 Bridge binding

- 一次性链接码只存在于交互流程，绝不写 Core DB、stdout/stderr、日志或诊断。Migration 11 仅把 polling secret 以实例密钥加密写入短期 pending 表，用于崩溃恢复；不进入 Renderer、日志、导出或长期设备 credential，完成/过期/取消即清除。
- Shell 长期 credential 继续使用 Electron `safeStorage` 包装的实例密钥保护；Renderer 只读取 `paired/repair_required` 等非敏感状态。
- Remote Connector 的设备 credential 使用 Windows DPAPI CurrentUser 并保存在它自己的 Remote data root。
- Bridge 持久化 `pairId/generation/lifecycle/connector identity/protocol` 和 credential verifier，不保存 Omnia Authorization、Cookie 或 AI Key。
- Shell 在显示链接码前保存加密 poll secret、session expiry 与 expected old binding CAS 身份，但绝不保存链接码；成功、过期或身份冲突后清除 pending。
- 主动解除绑定先进入持久 `repair_required`/revocation pending，断网时不投影 bound；后台重试获 200/204 或确认旧 credential 已不可用后才清除身份并转 `revoked`。
- 复制便携 `data/` 到另一 Windows 用户或设备后，无法解密的 binding 进入 `repair_required`，不得降级明文或 fallback Local。

## 删除的旧运行资产

0.4.2 Windows Shell release 不再包含或启动：

- Shell `connector.cjs` 本地子进程；
- LocalConnectorAdapter；
- ConnectorTransportRouter；
- Shell data root 下的本地 Connector Edge profile、browser port state 和 instance lock；
- Local mode IPC、模式保存 action、waiting discovery 和候选设备自动认领。

这些删除不清理旧用户 `data/`。历史 Local profile/port/lock 若存在，仅作为不再读取的旧文件保留；发布/升级脚本不得递归删除用户数据。受控后续清理需要独立、可恢复、可审计的 data maintenance action，当前没有该 action 就不展示清理按钮。

## 回滚

- release `0.4.1`、`0.4.2` 与 `0.4.3` 目录保持不可变并列，升级只切换 active release，不覆盖 `data/`；0.4.2→0.4.3 便携升级保持已由自动化验收。
- Migration 10 删除旧 mode 表；回滚只能切换不可变 release，不能把 0.4.2 数据库降级交给旧 Shell 写入。Migration 9 已在 `connector_migration_audit` 保留必要审计摘要，但 0.4.2 创建或提升的 Remote binding generation 不应由旧 Shell 管理或降级。
- 回滚不得恢复 Local fallback，也不得把旧 Local snapshot 当成已连接。若旧二进制仍具有 Local 产品语义，只能作为历史 release 证据，不能作为 Remote-only 正式产品继续发布。
- Feature 包版本和 activation head 不随 Shell Transport 迁移重置。录制和删除元素继续按其独立签名包版本与 rollback 规则运行。

## 验证

- Migration 在空库、旧 Local、旧有效 Remote、旧损坏 Remote 和重复启动上通过。
- `schema_migrations` 对 Migration 9、10、11 各只记录一次，失败时事务回滚且旧用户数据完整。
- 升级前后聊天、附件、Feature activation、Feature Store、Evidence、Documentation 和 LayoutPreference digest/计数保持。
- Shell 包清单与进程观测证明没有本地 Connector 子进程、Edge profile 创建或 Local IPC。
- 已有有效 Remote binding 升级后无需链接码；旧 Local 用户进入真实 unpaired。
- 公司电脑真实 Pack canary 未通过/待 canary，不能用迁移自动化代替。
