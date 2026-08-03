# Omnia Agent v5 Remote Connector 0.1.0 发布与共存记录

> **历史快照（2026-07-31）**：本文记录 Remote Connector 0.1.0/后续 0.2.0 当时的发布边界。当前状态以 [Remote Connector 0.3.4 发布记录](REMOTE_CONNECTOR_0_3_4_RELEASE.md) 和 [Feature 包总览](FEATURE_PACKAGE_CATALOG.md) 为准；不要用本文的“Bridge 尚未部署/无业务 Operation”描述判断今天的实现。

状态：`Published update/bootstrap baseline`  
发布日期：`2026-07-31`  
产品身份：`omnia-agent-v5-remote-connector`  
平台：`win32-x64`

## 1. 交付结论

v5 Remote Connector 已作为独立便携包发布，并建立了独立的 labcaspian 自动更新通道：

- 便携包：[Omnia-Agent-v5-Remote-Connector-v0.1.0-Portable.zip](https://download.labcaspian.com/files/v5-remote-connector/releases/0.1.0/Omnia-Agent-v5-Remote-Connector-v0.1.0-Portable.zip)
- 稳定更新清单：[stable.json](https://download.labcaspian.com/files/v5-remote-connector/stable.json)
- 版本：`0.1.0`
- 发布序列：`1`
- 大小：`34,120,577 bytes`
- SHA-256：`ff83da04d5b9446ead4a4063fa2e1a4b6ff394807ea66fea0f3a53c611110c72`
- 签名 Key ID：`v5-remote-connector-release-2026-01`

这是 Remote Connector 的安装、监督、签名更新、安全切换和回滚基线。Remote Bridge 的配对、命令传输和 Omnia 远程业务链路尚未部署，因此 Worker 会真实报告 `bridgeState=unconfigured`；本发布不把远程业务能力伪装成可用。

## 2. 与 v4 的隔离边界

| 边界 | v4 | v5 Remote Connector |
|---|---|---|
| 产品身份 | `omnia-agent-v4` / 既有 Connector | `omnia-agent-v5-remote-connector` |
| Windows 安装根 | `%LOCALAPPDATA%\OmniaAgentConnector` | `%LOCALAPPDATA%\OmniaAgentV5RemoteConnector` |
| Windows 数据根 | `%APPDATA%\OmniaAgentConnector` | `%APPDATA%\OmniaAgentV5RemoteConnector` |
| 更新清单 | `/downloads/connector-stable.json` | `/files/v5-remote-connector/stable.json` |
| 服务器发布根 | `/opt/omnia-agent/current` 及既有下载目录 | `/opt/omnia-agent-v5-remote-connector`、`/var/www/omnia-download/files/v5-remote-connector` |
| 本地进程控制 | v4 自有机制 | v5 数据根内独占锁、请求文件和自己启动的 Worker |

v5 路径解析器会明确拒绝使用两个 v4 根目录。停止、更新或回滚只针对 v5 Supervisor 启动的 Worker，不按通用 `node.exe` 名称杀进程，不读取 v4 状态，也不改写 v4 清单。

发布前后，服务器 v4 稳定清单 SHA-256 均为：

```text
6e2130c27da3302877500539739ea8606ae514f999ec49da09826e516bfe9786
```

发布后 v4 在线健康检查仍返回 `ok=true`、`app=omnia-agent-v4`、`version=0.7.14`。

## 3. 安装和状态

解压到任意便携目录后：

1. 双击 `StartRemoteConnector.cmd`：复制经过签名清单验证的版本到独立安装根，并启动最小 Supervisor；
2. 双击 `StatusRemoteConnector.cmd`：查看 managed state 和真实 Worker 状态；
3. 双击 `CheckForUpdates.cmd`：触发一次检查；已有 Supervisor 时只向自己的 v5 数据根写入请求；
4. 双击 `StopRemoteConnector.cmd`：只请求停止 v5 Supervisor/Worker。

首次启动不会停止、升级、导入或配对 v4 Connector。

## 4. 自动更新合同

Supervisor 每六小时检查一次固定的 v5 `stable.json`，并支持手工触发。更新必须同时通过：

- HTTPS 与固定 v5 发布路径；
- 精确的 schema、product、channel、platform 和 Key ID；
- Ed25519 清单签名；
- 单调发布序列和 semver；
- 签名声明的文件大小与 SHA-256；
- 解压后精确文件清单、逐文件大小/SHA-256 和便携包签名；
- 无符号链接、无额外文件、无跨目录路径。

候选版本安装到非 active 位置。只有 Worker 心跳新鲜、`activeOperations=0` 且 `uncertainOperations=0` 时才允许切换；候选先做独立健康探测，再经过持续 probation。失败时恢复 previous、保留防降级序列并阻止重复激活同一坏版本。

当前 `0.1.0` Worker 尚无业务 Operation，因此活动和 uncertain 计数都是真实的零，不代表未来业务链路已经实现。

## 5. 服务器发布策略

- `stable.json`：`Cache-Control: no-store`，避免客户端或 CDN 固定旧更新指针；
- 不可变版本包：`Cache-Control: public, max-age=31536000, immutable`；
- 发布脚本先验证本地签名、大小和 SHA-256，再写不可变版本目录，最后原子替换 stable；
- 服务器发布私钥不存在；私钥只保留在工作站外的离线签名目录；
- 发布脚本在变更前后核对 v4 稳定清单 digest，任何变化都会失败。

## 6. 已完成验证

- 官方签名更新清单和便携清单验证通过；
- 版本 ZIP 大小与 SHA-256 在本地、服务器端和在线清单一致；
- 篡改便携文件后验证失败；
- 实际 Supervisor/Worker 在临时 v5 根中启动、写入心跳、检查更新并停止；
- Worker 真实报告 `bridgeState=unconfigured`；
- 测试前后 v4 安装根文件清单未变化；
- 在线 stable 内容与本地已签名清单逐字节一致；
- 源站与 Cloudflare 路径均可取得版本包；
- v4 在线健康和稳定清单未受影响。

## 7. 仍未开放的能力

以下内容不在本发布中：

- Remote Bridge 用户/设备配对；
- 远程命令、进度、Artifact 和 reconcile 传输；
- Omnia Session 绑定和业务 Operation；
- v5 Shell 设置页的 Local/Remote 切换；
- Windows 开机自启动、组织代码签名和受控设备 rollout。

这些能力完成真实后端、身份、安全合同和 canary 前，前台必须保持禁用或显示“未配置”。

## Bridge/WSS Worker 实施增量（2026-07-31）

本轮 Bridge/WSS Worker 作为后续不可变升级候选发布为 `0.2.0 / sequence 2`；不会覆盖上文
已经发布的 `0.1.0 / sequence 1` 包、摘要或服务器版本目录。

Remote Connector 仍使用独立 v5 Supervisor、版本目录、Ed25519 签名更新、单调 sequence、
SHA-256、候选 probation 和回滚。它不触碰 v4。

本轮 Worker 已从 `bridgeState=unconfigured` 升级为真实 outbound WSS 客户端：

- 首次运行 `PairRemoteConnector.cmd`，交互使用角色绑定、10 分钟、一次性 Connector code 配对；
- 成功后把 token 以 Windows DPAPI 密文保存到独立 v5 data root；
- Worker 重启后从持久配置读取 Bridge URL/token，一次性码不进入 Supervisor/Worker 环境；
- 使用与 Local 完全相同的只读 Connector operation 合同；
- Bridge 断开、deadline 和 Connector 中途离线均显式失败；
- 不增加 mutation operation，不传送 Omnia Authorization/Cookie。

发布包仍由 `npm run package:remote-connector` 生成并要求仓库外 v5 签名私钥。
Bridge 服务由 `npm run package:bridge` 单独打包。两者的部署合同见
`V5_BRIDGE_DEPLOYMENT.md`。

`0.2.0 / sequence 2` 已发布到：

- stable：`https://download.labcaspian.com/files/v5-remote-connector/stable.json`
- ZIP：`https://download.labcaspian.com/files/v5-remote-connector/releases/0.2.0/Omnia-Agent-v5-Remote-Connector-v0.2.0-Portable.zip`

ZIP 为 `37,282,502` 字节，SHA-256：
`0738bb27d8368e7267b9348bcb20b06a8d82184f571a453d76c50d0fc370b51f`。
stable 使用 `no-store`，版本 ZIP 使用 immutable 缓存；Ed25519 清单 sequence 为 2。

生产 Bridge/WSS canary 已关闭；真实 Omnia Pack canary 和组织级 Windows 代码签名仍未关闭。
