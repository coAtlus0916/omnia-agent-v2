# Omnia Agent v5 Remote Connector 0.3.6 发布记录

日期：2026-08-03
版本 / sequence：`0.3.6 / 9`
配套 Bridge：`0.4.2`
状态：不可变历史候选；干净安装通过，但发现已有 0.3.5 时手工 `install` 不会推进 managed `current`，因此不得作为公司电脑手工升级包；由 0.3.7 / sequence 10 取代

> 0.3.6 文件、摘要和签名证据保留，不覆盖重建。它没有外部部署。当前可升级候选见 [0.3.7 发布记录](REMOTE_CONNECTOR_0_3_7_RELEASE.md)。

## 发布目的与边界

0.3.6 是支撑 `omnia.create-associate@0.1.0` 回传 Gate 的 Connector patch，不把 Excel 解析或 Phase 1 分支放入 Connector Core。新增能力限于：

- `signed_json` 固定签名 Operation handler；
- mutation permit 与精确 binding/engagement/tenant/Pack authority 绑定；
- Workstation Session 暴露可审计 canonical authority identity；
- mutation 响应丢失进入 `uncertain`，不自动重放，随后只读 reconcile；
- 仍只有 Remote Transport，无 Local Connector 或 fallback。

Feature 的获取、处理、转换和计划生成仍由 Feature Worker/Core Store 承担。Connector 不接收任意 Excel，也不自行解释表格业务。

## 不可变产物

- ZIP：`remote-connector/releases/0.3.6/Omnia-Agent-v5-Remote-Connector-v0.3.6-Portable.zip`
- size：`37301644`
- SHA-256：`149a7636d57671b5c1b880ba3887d2a0a4907f47a41364edaa6ccda26d97ab65`
- stable manifest：`remote-connector/public/stable.json`
- release sequence：`9`
- key：`v5-remote-connector-release-2026-01` / Ed25519

`0.3.5 / sequence 8` 与更早目录保持不可变。生成脚本只更新仓库内候选 `public/stable.json`；本任务没有运行 `deploy:remote-connector`，因此不能把本地 stable 文件描述为公司电脑已经收到在线升级。

## 已执行验证

| 命令 | 结果 | 边界 |
|---|---|---|
| `npm run check` | exit `0`；主测试 `121`（`120 passed / 1 skipped / 0 failed`），build 与 independence 通过 | 自动化与本机构建，不代替真实 Omnia |
| `npm run verify:remote-connector` | exit `0` | ZIP inventory、Ed25519 signature、SHA-256、size、version、sequence 均通过 |
| `npm run smoke:remote-connector` | exit `0` | 隔离 install/data root 真实启停；`0.3.6`、`unpaired`；v4 install root inventory 未变化 |
| `npx tsx --test tests/workstation-omnia-session.test.ts` | `13/13 passed` | authority/Session Core 自动化 |
| `npx tsx --test tests/bridge-e2e.test.ts` | `14/14 passed` | 0.3.6 pairing/binding/restart/heartbeat 自动化；同时保留 0.3.4/0.3.5 协议兼容断言 |

## 升级与恢复

公司电脑手工升级时解压 ZIP 并运行 `InstallRemoteConnector.cmd`，安装器把 0.3.6 写入独立版本目录，通过 signed manifest 选择 current。Connector 数据、DPAPI credential 和 binding 位于安装版本目录之外；正常同一 Windows 用户升级不要求重新输入链接码。若 protected credential 无法解密或 Bridge 已撤销 binding，则必须显示 `repair_required` 并重新配对，不得复制 token 或启用 Local fallback。

Supervisor 在线升级只有在外部 stable manifest 已正式发布且当前没有 active/uncertain Operation 时才可激活；candidate/probation 失败恢复 previous。

## 证据分层

- 自动化：通过。
- Windows 隔离便携冒烟：通过。
- 公司电脑安装/绑定保持：未执行。
- 真实 Omnia Pack canary：**未实机验证/待 canary**。
