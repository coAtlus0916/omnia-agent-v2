# Omnia Agent v5 Remote Connector 0.3.7 发布记录

日期：2026-08-03
版本 / sequence：`0.3.7 / 10`
配套 Bridge：`0.4.3`（0.4.2 为历史本地候选；0.4.3 增加 Shell 所需的公开 pairing capability health）
状态：本地签名候选；干净启动和 0.3.6→0.3.7 隔离手工升级通过；未外部部署、未安装到公司电脑、真实 Pack canary 未完成

## 目的

0.3.7 继承 0.3.6 的签名固定 Operation、精确 authority identity 与 uncertain/reconcile Gate，并修正便携包在已有旧版本时只复制、不推进 managed `current` 的手工升级缺口。0.3.6 保持不可变且未外部部署，不作为升级交付。

手工激活新版本时：

- 先验证 Supervisor 已停止；
- `activeOperations` 或 `uncertainOperations` 非零时拒绝切换；
- 原子推进 `current=0.3.7`、`previous=0.3.6`、`highestSequence=10`；
- 保留安装目录之外的 `%APPDATA%\OmniaAgentV5RemoteConnector`、DPAPI credential 与 binding；
- 不接触 v4 目录，不提供 Local fallback。

## 不可变产物

- ZIP：`remote-connector/releases/0.3.7/Omnia-Agent-v5-Remote-Connector-v0.3.7-Portable.zip`
- size：`37302231`
- SHA-256：`3f7c1e9f5b2d176ee078a74c1eb6f83c27d4da74b4b9e2bbdf5af31e460f1a5d`
- stable manifest：`remote-connector/public/stable.json`
- key：`v5-remote-connector-release-2026-01` / Ed25519

只生成了仓库内 release/public 候选，没有运行 `deploy:remote-connector`。

## 验证

| 命令 | 结果 |
|---|---|
| `npm run lint` | exit `0` |
| `npx tsx --test tests/workstation-omnia-session.test.ts tests/bridge-e2e.test.ts` | `27/27 passed` |
| `npm run verify:remote-connector` | exit `0`；signature/hash/size/version/sequence 通过 |
| `npm run smoke:remote-connector` | exit `0`；0.3.7 隔离启停，v4 root 未变化 |
| `npm run smoke:remote-connector-upgrade` | exit `0`；0.3.6→0.3.7 current/previous/sequence 正确、data 保留、active Operation 阻断有效 |

## 公司电脑手工升级顺序

1. 保留 `%LOCALAPPDATA%\OmniaAgentV5RemoteConnector` 与 `%APPDATA%\OmniaAgentV5RemoteConnector`，不要删除或改名。
2. 用当前旧包运行 `StopRemoteConnector.cmd`，再用 `StatusRemoteConnector.cmd` 确认停止。
3. 解压 0.3.7 ZIP 到新目录，运行 `InstallRemoteConnector.cmd`。
4. 运行新包的 `StartRemoteConnector.cmd`，再运行 `StatusRemoteConnector.cmd`，确认 `managed.current=0.3.7`、runtime version 为 `0.3.7`。
5. 正常绑定应直接复用，不输入新链接码；只有状态明确为 `repair_required` 时，才从 Shell 顶部 Connect 重新配对。

自动化证明的是隔离 Windows 环境，不是公司电脑现场或真实 Omnia Pack。Bridge 0.4.3 与 Connector 0.3.7 必须先完成真实配对和只读 Pack canary；未经授权不执行 Omnia mutation。
