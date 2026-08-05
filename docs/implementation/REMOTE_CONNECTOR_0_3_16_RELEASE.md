# Remote Connector 0.3.16 发布记录

日期：2026-08-05；sequence：19。

本版修复 Remote Command Gate 的独占命令与后台只读探活竞态。此前 `operation_invoke`、`recording_command` 等独占命令到达时，只要 `health/status` 恰好正在运行，Gate 就会立即返回 `CONNECTOR.BUSY`；这会让尚未分发到 Operation Host 的 mutation 在上游提交边界之后被误判为不确定。

Gate 现在使用有界 FIFO 等待队列：

- 全局运行并发上限仍为 4，独占命令仍严格单飞，不会同时执行两个独占请求；
- 独占请求等待先到达的短只读请求结束，排队后会阻止后来的 `health/status` 插队；
- 队列最多 64 项，每项最多等待 30 秒且不超过 Bridge 下发的原始 deadline；
- queued request 的取消和 deadline 会原子移出队列，dispatch 异常或完成后始终释放运行槽；
- request ID 在 queued/running 两种状态下都执行重复拒绝。

已生成并验证官方签名自动升级候选：

- ZIP：`remote-connector/releases/0.3.16/Omnia-Agent-v5-Remote-Connector-v0.3.16-Portable.zip`
- SHA-256：`a0b9b7863fb19de9a96ec278ae0a8f94cd3695455f9f3e53bd14b44bdefa4dfa`
- size：`37308229`

发布使用既有 stable 自动升级通道；当前只完成本地不可变候选和 stable manifest 生成，尚未公开部署，也未确认公司电脑自动激活或真实 Omnia canary。这些状态不能由源码和静态构建结果代替。
