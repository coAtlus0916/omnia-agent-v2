# ADR-0035：Remote-only Connector 与一次性链接码配对

状态：Accepted
日期：2026-08-03
决策来源：用户正式产品决定
Supersedes：ADR-0003 与 ADR-0008 中关于 Local Transport、Local/Remote 双模式、模式切换和 Local 首次默认值的部分

## Context

v5 曾在 Shell 内同时维护 Local Connector 子进程和 Remote Bridge Transport。公司电脑 Remote Worker 又复用了名为 `LocalConnector` 的 Edge/CDP Session 实现，导致“产品 Transport 模式”和“Connector 所在工作站的 Omnia Session Core”混在同一个名称与部署边界中。

产品现在只维护 Remote Connector。删除的是 Shell 内置 Local Transport 产品链，不是公司电脑 Remote Connector 持有受控 Edge、CDP、Authorization、Pack identity 和签名 OperationHost 所必需的 Session Core。

旧的 waiting discovery 会向未认证 Shell 暴露候选设备，并允许单候选自动认领。这不符合首次配对必须由用户明确传递一次性链接码的边界，也无法表达正常重启与凭据撤销之间的差异。

## Decision

### 1. 唯一正式链路

```text
Shell Renderer
  → Shell Main/Core（Remote binding owner）
  → RemoteConnectorTransport
  → v5 Bridge
  → Remote Connector Worker（公司电脑）
  → WorkstationOmniaSession
  → 受控 Edge/CDP + 签名 OperationHost
```

- Shell 只实例化 Remote Transport，不打包、不启动也不探测本地 Connector 子进程。
- 产品不再存在 `local|remote` active mode、Transport 切换、Local 标签或 Local fallback。
- Remote 不可用时返回明确的离线、不兼容、超时或修复状态；不得在 Shell 所在电脑启动另一个 Connector 猜测继续。
- Shell 不直接访问 Edge、CDP、Authorization、Omnia API 或 Connector profile。

### 2. 工作站 Omnia Session Core

原 `LocalConnector` 重命名并收敛为产品模式无关的 `WorkstationOmniaSession`。它是 Remote Connector Worker 内部的 Integration Plane 组件，不是可由 Shell 选择的 Local 产品模式。

它继续负责：

- 独立受控 Edge profile、动态 CDP 端口、精确 profile/port/process identity 和 instance lock；
- 唯一受信 Omnia target、登录 Session、Authorization 捕获、Engagement/Pack identity；
- 权威 Pack hierarchy 与 Workspace light read；
- 签名 OperationHost、录制和标准 Evidence；
- Connector 退出时不关闭用户正在使用的受控 Edge。

Remote Worker 是该 Core 的唯一正式宿主。Connector Core 仍禁止 Feature 业务编排、任意 HTTP 和模板/AI 逻辑。

### 3. 首次链接码

配对方向沿用 v4 已验证流程：Shell/服务端为一次配对会话生成短期一次性链接码并在顶部 Connect 引导中展示；用户把该码输入公司电脑 Remote Connector。Connector 消费成功并以候选凭据打开 WSS 后只进入 ready；Shell 通过同一配对会话的受保护 polling secret 取得候选身份与 Shell 角色凭据，先持久 stage，再通过 proof-bound commit 完成激活。

链接码必须：

- 使用密码学安全随机源，具备足够熵；
- 绑定唯一 pairing session、产品、协议和 Shell→Connector 角色方向；
- 最长十分钟有效且只能成功消费一次；
- Bridge 只保存 hash，不写日志，不作为长期凭据；
- 错误、过期或重复消费返回相同的非枚举错误；
- 匿名调用者不能列出等待设备、电脑名称或完整 Connector ID。

配对完成后：

- Remote Connector 使用 Windows DPAPI CurrentUser 保存其长期设备凭据；
- Shell 使用 Electron `safeStorage` 包装的实例加密保存 Shell binding credential；
- Bridge 保存可撤销的 `pairId + generation + lifecycle`；
- Shell 数据库只保存非敏感 Connector identity、协议、generation 和受保护 credential 引用/密文。

2026-08-03 两阶段提交澄清：WSS open 不等于 activation。`POST /v1/pairing/sessions/:id/commit` 必须持有同一 poll proof；Bridge 在提交瞬间复核 candidate socket OPEN/fresh 及 pair、generation、device、protocol、version，一致后才 CAS 激活并撤销旧 generation。Remote Worker 只在收到匹配的 `binding_committed` 后提升 candidate credential。ready 使用独立 recovery TTL；Bridge 重启/候选重连不延长 TTL，但允许跨 code expiry 恢复。Shell 的 `creating` reservation、staged token 和 expected old identity 覆盖 stage 前后、commit 响应丢失及 promote 前崩溃；权威 poll 为 matched 时幂等收尾，为 candidate 时才重试 commit。

Shell、Bridge、Remote Connector 的普通重启和正常断线恢复不重新要求链接码。只有用户明确解除绑定、服务端撤销、设备重装或凭据不可恢复时进入 `repair_required` 并要求新码。

### 4. 重新配对与解除绑定

- 诊断、重新配对和解除绑定从 Connect 错误/详情流程进入，不在 Settings 建立 Connector 子菜单。
- 重新配对必须有用户确认，并创建 candidate binding；旧 active binding 在 candidate 完成身份、协议、Bridge 和 Connector 健康验证前继续有效。
- candidate 失败只清理 candidate。candidate ready 不改变 previous；只有 proof-bound commit 成功后才原子激活更高 generation 并撤销 previous generation。
- 解除绑定只撤销 Connector identity/credential，不删除聊天、Feature、Evidence、附件或用户文档。
- UI、日志、诊断和导出不得显示 token、DPAPI 密文、safeStorage 密文或 polling secret。

### 5. Remote Pack Connect 状态机

Bridge 可达、Shell WSS 在线、Connector 在线和 Pack connected 是不同事实。顶部 Connect 状态至少区分：

```text
bridge_connecting
connector_offline
connector_incompatible
browser_starting
waiting_login
waiting_pack
waiting_authorization
identifying_pack
connected
target_closed
multiple_targets
identity_changed
timed_out
cancelled
repair_required
```

用户开始 Connect 后，Core 在最长十分钟内约每 2.5 秒读取真实 status；只在首次需要时发起 browser connect，不在每轮 status polling 中 reload。用户可取消等待，但取消不关闭受控 Edge。

2026-08-03 实现澄清：配对取消使用同一 poll proof 调用 `DELETE /v1/pairing/sessions/:id`。waiting 取消使 code 永久不可消费；candidate 取消先 revoke；若 activation 已先赢则返回 `409 matched`，Shell 不得丢弃新 token，而须完成 binding 保存，或在本地 expected old identity 已变化时持久化 cleanup proof 并撤销未接管 candidate。取消/cleanup 网络失败保留实例加密 pending，不能只清 UI 状态。

begin、poll、cancel、revoke 共用生命周期单飞门禁。begin 先在该门禁内执行公开、只读的 Bridge capability health；该请求不创建或改变远端 pairing session，因此不写 reservation。预检通过后，begin 必须在任何会创建或改变远端 pairing session 状态的 Bridge await 前写入 durable `creating` reservation。损坏的 pairing/revocation pending 不得通过删除记录解除 transport gate：可从同 pair 凭据恢复时继续；否则保留人工 Bridge reconcile/revoke tombstone。特别是普通未 stage pairing 的 poll proof 损坏时，Core 不知道 Bridge 是否已有 ready candidate，必须无限期标记 `manual_reconcile_required`，即使本地 code `expiresAt` 已过也不能清理；UI 只显示 session hash，要求 Bridge 管理员确认 candidate 已取消、recovery TTL 已过或已 revoke 后，才允许人工清 tombstone 并开始新链接。

只有同一受控 target 同时满足受信 Omnia URL、合法 Engagement ID、同 target Authorization、相同 identity 的实时 hierarchy 与 Pack 名称时才进入 `connected`。用户稍后完成登录并打开 Pack 时自动晋升，不要求第二次点击 Connect。刷新是明确的真实 action，不能被 polling 冒充。

### 6. Bridge 在线性

- `RemoteConnectorTransport` 必须消费 Bridge `state` envelope；Shell WSS 在线不能替代 `connectorOnline=true`。
- Shell 和 Connector WebSocket 使用 ping/pong heartbeat；超过明确 freshness 期限的半开 socket 被清理。
- `onlineConnectors` 只统计新鲜、协议兼容且 binding generation 有效的 Connector。
- Bridge health 只返回非敏感 `version/build/release/protocol/startedAt`。
- 双端重连使用有上限的 exponential backoff + jitter。网络恢复后重新验证 Session/hierarchy，不沿用旧 Pack identity 宣称 connected。

### 7. Settings 与 Shell 表面

- 删除整个 Connector Settings 子菜单、Local/Remote 按钮、Bridge URL、候选 Connector ID、waiting discovery、查找/匹配和 Pair ID 展示。
- Settings 保留具有真实 Core action/state 的 AI、安全锁及其他既有页面。
- 首次配对、诊断、重新配对和解除绑定统一从顶部 Connect 流程进入。
- 顶栏只表达 Remote 链路和真实状态，不提供模式切换。

## Data migration

Core 使用前向、幂等 migration：

1. 新建 Remote binding、pairing state 和 audit 结构，敏感 credential 仍由实例加密/`safeStorage` 保护；
2. 旧 `connection_settings.mode=remote` 且 binding credential 可解密时迁移为 active Remote binding，保留 generation/identity 并在启动后实时验证；
3. 旧 `mode=local` 或没有可验证 Remote binding 时迁移为 `unpaired`，不复制 `connection_state` 的 Local snapshot；
4. 旧表保留为只读 migration evidence/legacy 字段，产品运行时不再读写 active mode；
5. migration 不触及聊天、Feature Registry/Store、Managed Content、Evidence、文档、附件和 LayoutPreference。

## Consequences

正面：

- Shell 不再持有 Omnia Session/Edge/CDP 代码或本地子进程生命周期；
- 只有公司电脑 Remote Connector 是 Omnia credential/session owner；
- 首次配对是明确的 possession proof，正常重启不打扰用户；
- 删除双 Transport 路由、切换和 fallback 状态空间。

成本：

- Bridge 和 Remote Connector 成为所有 Omnia 功能的强依赖，需要 heartbeat、持久 binding、撤销和发布运维；
- 未配对或公司电脑离线时，Omnia 能力失败关闭，本地聊天等非 Connector 能力仍可工作；
- 旧 Local 用户升级后必须完成一次 Remote 链接码配对。

## Rejected alternatives

| 方案 | 结论 |
|---|---|
| 隐藏 Local UI 但保留 fallback | Rejected；仍是未审计的第二条执行链 |
| 删除 Edge/CDP Session 实现 | Rejected；Remote Worker 将失去真实 Omnia 能力 |
| 匿名 waiting discovery/唯一候选自动认领 | Rejected；泄露设备身份且缺少 possession proof |
| 每次启动都要求链接码 | Rejected；一次性码不是长期设备凭据 |
| 仅凭数据库存在 token 显示 connected | Rejected；必须验证 Bridge、Connector、Session 和 Pack 实时事实 |
| 在 Settings 保留 Connector 表单 | Rejected；配对与修复属于顶部 Connect 状态机 |

## Verification

- 源码、构建清单、便携包和运行进程中不存在 Shell Local adapter、Transport router、Local IPC、Connector 子进程或 fallback。
- 首次链接码成功，错误/过期/重复消费失败；匿名调用者不能发现 Connector；日志扫描无链接码和 credential。
- Shell、Connector、Bridge 分别重启及网络恢复后复用长期 binding；撤销后进入 `repair_required`。
- 重新配对 candidate 失败保留旧 active；成功后 previous generation 不能认证。
- Bridge 在线而 Connector 离线、heartbeat stale、协议不兼容、在途断线和 state envelope 均产生准确状态。
- 延迟登录、延迟打开 Pack、Authorization/hierarchy 延迟无需第二次 Connect 即进入 connected；target closed、多 target、identity drift、取消和超时失败关闭。
- Settings 不存在 Connector 子菜单，AI/安全锁保持；UI 六项回归继续通过。
- 使用最终 Remote Connector 包完成公司电脑真实 Pack canary；未完成时发布记录必须写“Remote 真实 Pack canary 未通过/待 canary”。
