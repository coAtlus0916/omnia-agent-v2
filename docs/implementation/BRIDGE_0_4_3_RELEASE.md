# Omnia Agent v5 Bridge 0.4.3 发布记录

日期：2026-08-03
版本：`0.4.3`
协议：`omnia.v5.remote-connector/v2`
配套 Remote Connector：`0.3.7 / sequence 10`

## 目的

0.4.3 保留 0.4.2 的一次性链接码、候选 binding、proof-bound poll/commit/cancel、持久 binding/generation、heartbeat 和 Remote Operation 中继合同，并在公开 `GET /v1/health` 增加非敏感版本、build identity、protocol、startedAt 和 `omnia.v5.bridge-pairing-session/v1` capability。Shell 只有在 health 明确支持该 capability 后才允许创建 pairing reservation/session；旧 Bridge 不再收到不存在路由的试探请求。

## 发布顺序与边界

1. 从冻结源码构建一次，只生成 Bridge 0.4.3 新版本目录；不得覆盖 0.4.2。
2. 部署前保留当前 `/opt/omnia-agent-v5-bridge` 可恢复副本、`.env` 和持久 Docker volume；不得读取或输出 token secret、binding token 或链接码。
3. 部署 Bridge 后先验证公开 health capability，再完成真实 pairing canary。
4. pairing canary 通过后才发布 Connector 0.3.7 ZIP，验证目标 bytes/size/digest，最后原子切 stable。
5. Shell 最后开放连接；不触碰 v4 Bridge、Connector、更新清单或数据。

本记录不把自动化、health 或配对成功写成真实 Omnia Pack canary。没有完成目标 Pack 的只读 `status/refresh/workspace_light_read` 前，状态必须保持“未实机验证/待 canary”。
