# Shell 0.4.2 Remote-only UI/Connector 回归验收

日期：2026-08-03
候选：Shell `0.4.2`、Bridge `0.4.1`、Remote Connector `0.3.5 / sequence 8`
Feature：recording `0.1.1` 保持不可变内置 patch；delete-elements `0.1.2` 保持独立后装
状态：自动化、Electron UI 与 Windows 便携验收通过；公司电脑真实 Remote Pack canary **未通过/待 canary**

版本控制基线：工作区已建立 Git 基线 `1737c0aa7bb5afe2b35cbfefd85c02c6b890d15b`（`chore: establish Omnia Agent v5 0.4.1 baseline`）。本批 0.4.2 变更在该基线上叠加；验收期间工作树同时含多个 Agent 的任务内修改，未使用 reset、checkout 或 clean。

## 验收范围

本记录只认可真实状态、真实 Electron/native view、真实 package/迁移和真实 Bridge/Remote Worker 代码路径。fixture 只能作为明确标注的自动化输入，不能代替公司电脑 Omnia Session、真实 Pack 名称或 mutation canary。

## Remote-only 架构检查

| 验收项 | 预期证据 | 当前结论 |
|---|---|---|
| Shell 不实例化 Local | Main import/process/package inventory；运行进程观察 | 通过；Main 只构造 `RemoteConnectorTransport`，0.4.2 包无 `connector.cjs` |
| 无 Local fallback | Remote 断线/不兼容/in-flight 失败路径；架构扫描 | 通过；断线、协议不兼容与 response-lost 均 fail closed，不切换 transport |
| Session Core 仅在 Remote Worker | `WorkstationOmniaSession` import graph 与包成员 | 通过；Shell 包不含 Session Core，Remote Worker 是唯一宿主 |
| Settings 无 Connector 页 | 真实 UI 菜单和 IPC allowlist | 通过；真实导航只有“AI 设置”“安全锁”，配对只在顶部 Connect 流程 |
| 旧 Local DB 迁移为 unpaired | Migration 9 真实旧库升级 | 通过；旧 Local snapshot 不投影为 Remote，审计记录保留 |
| 旧有效 Remote binding 保持 | 加密 credential 迁移 + 实时重新验证 | 通过；可解密 binding 保留，损坏凭据进入 `repair_required` |

## 配对、在线与 Pack 状态自动化

必须覆盖：

- 链接码首次成功、单次使用、错误、过期、重复消费、匿名不可发现；
- Shell/Connector/Bridge 重启不重新配对；revoked 进入 repair；重新配对 candidate 失败保留旧 active，成功撤销 previous generation；
- Bridge 在线但 Connector 离线、heartbeat 清理半开 socket、协议/版本不兼容、state envelope 和在途断线；
- 延迟登录、延迟 Pack、Authorization/hierarchy 延迟后自动 connected，不第二次点击；
- target closed、multiple target、SSO/new tab、refresh、cancel、timeout 和 Pack identity 漂移；
- 日志与诊断不含链接码、poll secret、token、DPAPI/safeStorage 密文。

已执行的自动化证据：

| 命令 | 结果 | 证据边界 |
|---|---|---|
| `npm run typecheck` | exit `0` | TypeScript 静态检查通过；不等于运行时或真实 Connector canary |
| `npx tsx --test tests/bridge-e2e.test.ts tests/database.test.ts tests/shell-service.test.ts tests/remote-only-transport.test.ts tests/workstation-omnia-session.test.ts` | Remote-only 定向自动化通过 | 覆盖 Bridge 配对/在线、Migration、Shell service、Remote-only Transport 和 Workstation Session Core；fixture 结果不替代公司电脑 Omnia canary |
| `npm run check` | exit `0`；主测试 `107`（`106 passed / 1 skipped / 0 failed`），build 通过，independence `1/1 passed` | lint、typecheck、全量自动化、构建和进程/包独立性门禁；skip 是需要真实嵌入安装器拒绝环境的 wrapper 用例，不等于公司电脑 canary |
| `npm run acceptance:ui-regression` | exit `0`；16 张截图和 `automation-report.json` | 真实 Electron、签名 Feature、WebContentsView manager snapshot 与实际几何证据 |
| `npm run verify:remote-connector` | exit `0`；Ed25519 签名、SHA-256、size、sequence 全部通过 | 验证最终 `0.3.5 / sequence 8` ZIP 和 stable manifest |
| `npm run smoke:remote-connector` | exit `0`；隔离 install/data root 启停，状态 `unpaired`，v4 root 未改变 | Windows 本地 Remote Connector 进程冒烟；不等于公司电脑 Omnia canary |
| `npm run acceptance:portable-0.4.2` | exit `0` | 最终 Shell ZIP 的干净 data root、Remote-only、无 Local 子进程、Settings 菜单检查 |
| `npm run acceptance:upgrade-0.4.2` | exit `0` | 0.4.1→0.4.2 保留 delete-elements、chat、attachments、Evidence、documents、registry、布局与缩放 |

`smoke:remote-connector` 首轮在 Windows 临时目录清理处遇到 `EPERM`，随后暴露旧 smoke 期望仍写成 `waiting_matching`；已把 harness 改为等待 Supervisor PID 真正退出，并按 Remote-only 干净状态断言 `unpaired`，最终重跑通过。该失败没有修改或覆盖已生成的 0.3.5 不可变包。

## 六项 Shell UI 回归

| 项目 | 验收标准 | 证据状态 |
|---|---|---|
| 全局缩放 | 100/105/115% 下 Shell、Comments、Settings、docked/detached 的真实 DPR、font/bounds 变化；重启保持；无双倍率 | 通过；DPR `1 / 1.05 / 1.15`，manager zoom 与键盘/按钮一致，115% 重启恢复 |
| Comments composer | Feature→Comments 后 textarea、附件、发送可见可点击，manager attached=0 | 通过；展开/收起截图均完整，native snapshot `commentsAttached=0` |
| 菜单收起 | Comments 完整重排；Feature bounds 同步 | 通过；composer 均在内容区，`menuBoundsChanged=true` |
| Feature 导航 | 唯一“其他”，真实 recording/delete-elements 独立包合组 | 通过；`omnia.recording@0.1.1` 与 `omnia.delete-elements@0.1.2` 合并为一个 `other` group |
| Comments/Settings 遮挡 | overlay 时 docked attachment=0；关闭恢复；最多一个 view | 通过；`settingsAttached=0`，`featureAttachedMaximum=1`，返回 Feature 恢复正确 surface |
| Settings 稳定尺寸 | 删除 Connector 子菜单；仅真实设置；外框固定、左右独立滚动、splitter 重启保持 | 通过；AI/安全锁各路径外框稳定，内部滚动，splitter basis `2300` 重启保持 |

## Windows 便携与升级

1. Shell ZIP：`artifacts/omnia-agent-v5-portable-0.4.2.zip`，size `144888482`，SHA-256 `56fad1bcef24bd929d8326e97c61b1692f6df973be7372794921637c73c85825`。`releases/0.4.2/release-manifest.json` 标记 `signed=false`，分发前仍需组织代码签名。
2. Bridge：`bridge/releases/0.4.1`，manifest SHA-256 `2a394aa3c6ab1acedd85baa431013c7bc53e9c55b518ba1b274a1402cec77a01`；manifest 同样标记分发前需组织代码签名。
3. Remote Connector ZIP：size `37300261`，SHA-256 `798917178c56d49222bc90770fb2422ea0f52841e49f2b33329ffce51fab5fde`；Ed25519 stable manifest 验签通过，版本 `0.3.5 / sequence 8`。
4. 干净 Shell data root 只自动安装内置 recording `0.1.1`，符合 delete-elements 独立后装边界；UI 目标 root 真实安装并激活 delete-elements `0.1.2` 后完成双 Feature 回归。Shell 包未包含 `connector.cjs`，也未创建本地 Connector Edge profile/port/instance lock。
5. 0.4.1→0.4.2 升级保持报告证明 delete-elements `0.1.2` activation、chat、attachments、Evidence、documents、documentation registry、layout、settings splitter 和 global scale 未被覆盖。
6. 旧不可变摘要复核未变：Shell 0.4.0 `4fa4f859...7876d`；Shell 0.4.1 `2d8a3f9e...c0b7`；recording 0.1.0 `ee14353f...e75`；recording 0.1.1 `2c269adb...91e`；delete-elements 0.1.2 `4848cc51...6a0a`。

证据文件：`acceptance/shell-0.4.2-ui-regression/automation-report.json` 与 16 张 PNG、`acceptance/shell-0.4.2-portable/portable-smoke-report.json`、`acceptance/shell-0.4.2-portable/clean-data-root.png`、`acceptance/shell-0.4.2-upgrade/upgrade-preservation-report.json`。

## 证据分层

- 自动化测试证据：TypeScript 静态检查、Remote-only 定向套件、全量 `npm run check` 和 Electron UI acceptance 已通过。
- Windows 便携冒烟证据：Shell 0.4.2 干净 data root、Remote Connector 0.3.5 隔离启停及 0.4.1→0.4.2 数据/Feature 保持已通过。
- 公司电脑真实 Remote Pack canary：**未通过/待 canary**。

没有第三类证据时，本候选不得写“正式完成”或“真实 Pack 已交付”。
