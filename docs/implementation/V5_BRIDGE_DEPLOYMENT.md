# v5 Bridge 与 Remote Connector 部署合同

v5 Bridge 公开于 `https://agent.labcaspian.com/v5-bridge/`，内部只监听独立
`127.0.0.1:18785`，容器与安装根分别为 `omnia-agent-v5-bridge` 和
`/opt/omnia-agent-v5-bridge`。Bridge 发布包位于 `bridge/releases/0.4.0/`。

## 正常首次路径

1. 公司电脑双击最终 portable 内的 `StartRemoteConnector.cmd`。
2. Worker 向 v5 Bridge 注册 2 分钟、单次使用的 waiting lease；状态为 `waiting_matching`。
3. Omnia Agent 设置选择 Remote，点击“查找并匹配 Remote Connector”。单候选直接绑定；多候选
   必须按电脑名称和 Connector ID 选择，未选择时失败关闭。
4. Bridge 冻结 product、protocol、Connector device、matching session 和 pair identity，分别签发
   Shell/Connector 角色 token。Connector token 由 DPAPI 保存，Shell token 由 `safeStorage` 保存。
5. 回到首页点击 Connect；status/refresh/keepalive/workspace/recording/官方 Operation 均走同一
   Remote transport，不会 fallback Local。

`create-pairing.sh` 和 `PairRemoteConnector.cmd` 只用于管理员诊断旧式双 code 流程，不属于正常路径。

## 命令与更新可靠性

- Bridge deadline 取 Shell 签约 deadline，最大 185 秒；录制 stop/catalog 的 180 秒合同不会被提前截断。
- request owner 同时绑定 pairId；同 ID 在途不重复分发，取消会移除 owner 并丢弃迟到结果。
- 仅 health/status 可有界并发；connect/refresh/workspace/recording/Operation register/invoke 使用互斥 lane。
- Remote 与 Local 共用 `ConnectorRequest/Response`、真实 `LocalConnector` 和签名 `OperationHost`。
- Supervisor 只从 v5 stable 下载，验证 product/key/signature/hash/size/sequence/minimum Supervisor；
  active/uncertain operation 会阻断激活，candidate/probation 失败恢复 previous 并记录坏 sequence。

## 生产状态与隔离

2026-08-03 已部署 Bridge `0.4.0` 与 Remote Connector `0.3.4 / sequence 7`。公开 canary 完成
waiting discovery、双角色匹配、DPAPI 持久化、WSS 和真实 `status` 往返。v4 stable manifest 部署
前后 SHA-256 均为 `6e2130c27da3302877500539739ea8606ae514f999ec49da09826e516bfe9786`。

v5 不复用或修改 v4 endpoint、room/token/state、device credential、签名清单、安装/数据目录、
Supervisor、更新通道或进程。生产 canary 未使用用户 Omnia 登录，`connectedToOmnia=false` 是真实
结果；真实 Pack、workspace、录制和 mutation Operation 仍需公司电脑授权环境最终 canary。
