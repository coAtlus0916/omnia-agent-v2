# 录制运维

排障顺序：Core Processing Run → Feature plan → PageObservation status → Managed Stream digest/offset → Python staging → output Artifact。

Connector 离线时不要改录制 Feature 来“修连接”。连接、更新、凭据、Bridge 和重连属于平台链路。录制只会在 `remote_connector` 依赖可用时启用需要 Connector 的动作。

常见失败：

- `OBSERVATION_INCOMPLETE`：存在 omission、目标漂移、页面关闭或预算耗尽。
- `EVENT_SEQUENCE_INVALID`：NDJSON 序列或 observation identity 漂移。
- `RESPONSE_SEGMENT_*`：JSON response body 分段缺失、冲突或摘要错误。
- `HANDLE.*`：Core 受管输入/输出长度或摘要不一致。
- `pending_capture_drain_timeout`：stop 已开始，但此前接收的响应正文在 5 秒内未排空；流会带 omission 并失败关闭。

固化失败时，用户可以先使用“重试固化”重读同一 stopped stream，也可以点击“停止”右侧的“重新开始录制”。后者会显式关闭旧 Run，并保留旧 Feature SQLite 行至其 24 小时清理时间，再创建全新的 recordingId/Run/observation；不能让失败 Run 永久占用当前入口。停止已确认且仍在后台固化时，该按钮必须禁用。

正常固化会以多次后台 action 推进，每次最多读取 1 MiB；`finalizing.nextStreamChunkIndex/receivedBytes` 应持续增加。Worker 重启后保持同一 transferId 继续。若 Shell 重启后出现 `Python input transfer is unavailable` 或 pending append 次序无法证明，Feature 会记录 `recording_transfer_reopened`，释放旧 handle 并对同一 stream digest 重开 transfer；这是安全恢复，不是重新 stop。若 streamDigest、size 或任一已持久块摘要变化，必须保持 `finalization_failed`，不要清库或换 recordingId。

摄取中途失败时不要删除 Feature Store 或重新生成 recordingId。已验证行会保留并显示真实计数；在同一 Connector 进程仍持有冻结流时使用“重试固化”，Python 会逐行核对并继续。导出只读 committed Core Artifact，不依赖 Connector 在线，也不依赖上一份录制。

任何错误都不得通过伪造计数、跳过摘要或生成空 Artifact 处理。
