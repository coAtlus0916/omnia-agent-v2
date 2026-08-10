# Omnia Agent v5 Remote Connector 0.3.5 发布记录

日期：2026-08-03
版本 / sequence：`0.3.5 / 8`
配套 Bridge：`0.4.1`
状态：Remote-only 候选；自动化和便携验收以本页实际记录为准，公司电脑真实 Pack canary 未通过/待 canary

## 发布目的

0.3.5 是 Remote-only 架构收敛版本。它不新增 Feature 业务分支；主要变化是把 Remote Worker 复用的 `LocalConnector` 重构为 `WorkstationOmniaSession`，并把首次连接改为 Shell 生成、公司电脑 Connector 消费的一次性链接码。

0.3.4 / sequence 7 及其发布目录、ZIP、manifest 和历史记录保持不可变。0.3.5 使用新的版本目录和更高 publisher sequence，不覆盖 previous。

## 实现边界

- Remote Worker 是 `WorkstationOmniaSession` 的唯一正式宿主。
- 受控 Edge profile、精确 CDP identity、Authorization、Engagement/Pack、hierarchy、录制和签名 OperationHost 保持。
- Connector 退出不关闭受控 Edge。
- Remote Connector 使用 Windows DPAPI CurrentUser 保存长期设备 credential；一次性链接码不落盘、不写日志。
- 重连使用有界 exponential backoff + jitter；Bridge/网络普通恢复不要求新链接码。
- revoked/不可恢复 credential 进入 `repair_required`，不无限重试。
- Shell 不包含该 Session Core，也不直接访问 Edge/CDP/Omnia。

## 配对与协议

- Bridge 协议：`omnia.v5.remote-connector/v2`。
- Shell 建立短期 pairing session，Bridge 返回链接码、不可回显的 polling secret 和 expiry。
- 用户在公司电脑 Remote Connector 输入链接码；成功消费形成 candidate binding。
- candidate 完成 Connector identity、版本、协议和健康验证后成为 active；重新配对成功时 previous generation 被撤销。
- 匿名 waiting discovery、完整 Connector ID/电脑名称枚举和单候选自动认领不再是产品 API。
- 0.3.4 credential 的兼容迁移只在身份、协议和保护材料均可验证时复用；无法证明时明确 repair，不猜测绑定。

## Pack Connect

Connector 只报告从同一受控 target 观察到的状态。Shell 只有在以下事实同时成立时显示 Connected：

- Bridge 和精确 binding generation 在线；
- Connector 版本/协议兼容；
- CDP/browser ready 且目标为受信 Omnia URL；
- URL 有合法 Engagement ID；
- Authorization 来自同一 target；
- hierarchy 返回相同 Engagement 的 Pack 名称。

状态读取不反复 reload 页面；refresh 是独立用户 action。target closed、多 Pack target、Authorization 等待和 identity drift 使用稳定错误/状态，不折叠为成功。

## 自动化与包证据

以下证据只有命令实际完成后才能标记通过；不得以源码存在代替：

- Remote pairing：首次、单次、过期、错误、重复、重启、撤销、重新配对和 generation。
- Bridge/Transport：state envelope、heartbeat stale、协议不兼容、在途断线和无 Local fallback。
- Pack Connect：延迟登录/Pack/Auth/hierarchy、自动晋升、target/multiple/refresh/cancel/timeout/identity drift。
- Windows portable：最终 0.3.5 包从干净 data root 启动、链接码输入、DPAPI 重启恢复和 package manifest 验证。

当前已执行：

| 命令 | 结果 | 限定 |
|---|---|---|
| `npm run typecheck` | exit `0` | 静态类型检查 |
| `npx tsx --test tests/bridge-e2e.test.ts tests/database.test.ts tests/shell-service.test.ts tests/remote-only-transport.test.ts tests/workstation-omnia-session.test.ts` | Remote-only 定向自动化通过 | 自动化/fixture 证据，不代替 Windows 便携或公司电脑 Omnia canary |
| `npm run check` | exit `0`；主测试 `107`（`106 passed / 1 skipped / 0 failed`），build 通过，independence `1/1 passed` | 全量仓库自动化；skip 是环境依赖的嵌入安装器拒绝 wrapper 用例，不代替 Windows 便携或公司电脑 Omnia canary |
| `npm run verify:remote-connector` | exit `0` | 最终 ZIP、Ed25519 signature、SHA-256、size、version 与 sequence 验证通过 |
| `npm run smoke:remote-connector` | exit `0` | 真实 Windows portable 进程在隔离 install/data root 启停，干净状态 `unpaired`，v4 install root inventory 未变化 |

最终 ZIP：`remote-connector/releases/0.3.5/Omnia-Agent-v5-Remote-Connector-v0.3.5-Portable.zip`，size `37300261`，SHA-256 `798917178c56d49222bc90770fb2422ea0f52841e49f2b33329ffce51fab5fde`。`remote-connector/public/stable.json` 为 `0.3.5 / sequence 8`，签名验签通过。

烟测首次发现 Windows Supervisor lock 文件先消失、进程后退出的短暂窗口，以及旧 harness 仍期待废弃的 `waiting_matching`。harness 已改为等待 PID 退出并断言 Remote-only 干净状态 `unpaired`，最终通过；不可变 0.3.5 ZIP 未被重建或覆盖。

本仓库的最终验收记录见 [Shell 0.4.2 Remote-only UI/Connector 回归验收](../reviews/SHELL_0_4_2_REMOTE_ONLY_ACCEPTANCE.md)。

## 真实 canary

公司电脑真实 Remote Pack canary：**未通过/待 canary**。

未完成以下现场步骤前，不得把 0.3.5 描述为真实 Pack 已交付：真实链接码、身份一致性、受控 Edge 登录、自动识别 Pack、`status/refresh/workspace_light_read`、Shell/Connector/Bridge/网络重启恢复、解除绑定和新 generation 重新配对。见 [Remote Pack canary 记录](../reviews/REMOTE_PACK_CANARY_0_4_2.md)。
