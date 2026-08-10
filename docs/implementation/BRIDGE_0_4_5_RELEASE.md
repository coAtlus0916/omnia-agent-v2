# Bridge 0.4.5 发布记录

状态：Linux Docker 候选已部署到生产，公开健康检查报告 `version=0.4.5`、`buildIdentity=bridge-0.4.5`

## 真实能力

Bridge `0.4.5` 向已认证的 Connector WebSocket 发送固定 `omnia.v5.bridge/v1` `update_check` envelope：连接成功时发送一次，在线期间每 60 秒发送一次。该 envelope 不接受远程 URL、版本、脚本、文件路径或命令参数，因此不是远程执行接口。

在线 Connector 的状态投影优先使用当前 WebSocket 握手声明的真实版本，避免 binding 首次配对版本长期冒充运行版本。配对 token、pairId、generation、connectorId 和协议校验保持不变。

## 与 Connector 的闭环

`0.3.11` Worker 收到信号后只写入 Supervisor 的 `update.request`；Supervisor 自行从 pinned stable 通道取得并验证 offer。旧 Worker 安全忽略未知 envelope。升级下载、sequence、安全窗口、probation、previous 回滚和 Remote-only 失败关闭均未下放给 Bridge。

## 验收状态

- 用户明确要求本轮停止单元测试；未运行单元测试。
- `npm run build` 已完成；`bridge/releases/0.4.5/linux-docker` 为本次部署的唯一 Bridge 候选。
- 生产容器 `omnia-agent-v5-bridge` 已重建并通过健康检查；公开健康状态报告 `onlineConnectors=1`。
- 公司电脑上的旧 Worker 是否已经完成第一次切换，必须以其新的 WebSocket 握手版本为准；在线数量不是版本证明。
