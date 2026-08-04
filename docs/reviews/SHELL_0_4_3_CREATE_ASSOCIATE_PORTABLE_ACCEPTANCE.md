# Shell 0.4.3 新建与关联便携验收

日期：2026-08-03
候选：Shell `0.4.3`、Bridge `0.4.2`、Remote Connector `0.3.7 / sequence 10`
内置 Feature：`omnia.recording@0.1.1`、`omnia.create-associate@0.1.0`
状态：自动化、Windows Shell 便携、0.4.2→0.4.3 升级保持和 Connector 隔离冒烟通过；组织代码签名、外部部署、公司电脑真实 Pack canary未完成

## 交付结论

Shell 0.4.3 的干净 data root 会从随包的官方签名 `.ofp` 自动安装“录制”和“新建与关联”。新建与关联 Surface 在 Remote 未连接时可进入，真实文件导入动作可用；回传动作在没有已验证计划/确认/capability 时保持禁用。Shell 包没有 Local Connector 子进程，也没有 fallback。

## 不可变产物

| 产物 | 大小 | SHA-256 / 状态 |
|---|---:|---|
| `artifacts/omnia-agent-v5-portable-0.4.3.zip` | `145363440` | `5394cf52d9675c753baa499f7a32b3be5ba6e68958b6bbc0962368a200552ac1` |
| `resources/app/builtins/create-associate-0.1.0.ofp` | 由 release manifest 约束 | `af6a49b2f4e154051b2c0db3b7b049a9e416cbb8af4382396c41450202ee2029` |
| `bridge/releases/0.4.2/release-manifest.json` | `2405` | `cb791a294c0f4e160d944b108c1816b74e3a55a7bbe66d978fac5a76f10858a1` |
| Remote Connector 0.3.7 ZIP | `37302231` | `3f7c1e9f5b2d176ee078a74c1eb6f83c27d4da74b4b9e2bbdf5af31e460f1a5d`；Ed25519 manifest 验签通过 |

Shell `releases/0.4.3/release-manifest.json` 与 Bridge manifest 均明确为 `signed=false / organization_code_signing_required_before_distribution`。它们是可本地运行的便携候选，不应描述为已完成组织签名的正式分发包。Feature/Operation 包和 Connector update manifest 使用项目官方 Ed25519 合同并已验签。

## 已执行测试

| 命令 | 结果 | 证据边界 |
|---|---|---|
| `npx tsx --test tests/recording-feature.test.ts tests/create-associate-feature.test.ts` | `13/13 passed` | 内置 Feature、V8、离线处理/转换、Return Store/Operation 自动化 |
| `npx tsx --test tests/workstation-omnia-session.test.ts` | `13/13 passed` | Connector authority 与 Session Core 自动化 |
| `npx tsx --test tests/bridge-e2e.test.ts` | `14/14 passed` | pairing/binding/restart/heartbeat 自动化 |
| `npm run check` | exit `0`；主测试 `121`（`120 passed / 1 skipped / 0 failed`） | lint、typecheck、全量测试、build、v4 independence |
| `npm run verify:remote-connector` | exit `0` | 0.3.7 ZIP/signature/hash/size/sequence |
| `npm run smoke:remote-connector` | exit `0` | 隔离 Windows Connector 真实进程启停；未连接 Omnia |
| `npm run smoke:remote-connector-upgrade` | exit `0` | 0.3.6→0.3.7 推进 current/previous/sequence、保留 data；active Operation 时拒绝切换 |
| `npm run acceptance:portable-0.4.3` | exit `0` | 最终 Shell 包干净启动；Remote-only；create-associate 离线可用、Return 初始禁用、无 delete 假入口 |
| `npm run acceptance:upgrade-0.4.3` | exit `0` | 0.4.2→0.4.3 保留聊天、缩放、布局、后装 delete-elements 和 data；自动安装 create-associate |

证据位于：

- `acceptance/shell-0.4.3-portable/portable-smoke-report.json`
- `acceptance/shell-0.4.3-portable/create-associate-clean-root.png`
- `acceptance/shell-0.4.3-upgrade/upgrade-preservation-report.json`

## 使用与升级结论

- 新用户：解压整个 `omnia-agent-v5-portable-0.4.3.zip`，从解压根的 `releases/0.4.3/Omnia Agent v5.exe` 启动；不要只复制 EXE。
- 0.4.2 便携用户：保留原产品根 `data/`，加入完整 `releases/0.4.3`，再把根目录 `current` 原子切到 `releases/0.4.3`。验收脚本已证明此路径不覆盖用户数据。最稳妥的人工方式是先备份整个旧便携根，再用新包中的 release/current 合并升级。
- 公司电脑 Connector：先用旧包 `StopRemoteConnector.cmd` 并等待停止，再用 0.3.7 ZIP 运行 `InstallRemoteConnector.cmd`、`StartRemoteConnector.cmd`；不要删除既有 Connector data root。正常同 Windows 用户升级复用 binding；active/uncertain Operation 会阻止切换，只有 credential 不可恢复或 binding 被撤销才需新链接码。

## 未完成项

- Shell/Bridge 组织代码签名：未完成。
- Bridge 0.4.2 外部部署：未执行。
- Connector 0.3.7 stable 外部发布和公司电脑升级：未执行。
- 真实 Omnia Pack / Workspace canary：**未实机验证/待 canary**。
- 未经用户另行授权，不执行任何生产 mutation。
