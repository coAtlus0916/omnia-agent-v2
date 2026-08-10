# 录制 Feature

版本：`omnia.recording@__FEATURE_VERSION__`

录制是当前已绑定 Pack 的只读页面观测功能。用户可以开始、暂停、继续、停止并下载最终 Core Artifact。所有按钮都连接真实 Worker、签名 Operation、通用观测状态或真实 Artifact；没有模拟计数和假下载入口。

## 架构边界

- Surface：只显示 Worker 投影的真实状态、事件计数、目录计数和 Artifact。
- Feature Worker：拥有 recordingId、Processing Run、观测控制、Managed Stream offset、冻结摘要、Python 调度与最终化重试。
- Core：拥有 Run、受管输入/输出 handle、Artifact 与 Feature 私有 Store。
- Connector：只提供固定的当前 Pack 页面观测、源头脱敏和有界 Managed Stream；不理解“录制”、GRA、Risk 或 Control。
- Python：只使用发布包内 CPython 3.13.14，从冻结 NDJSON 解析通用事件，并在 Feature 内按固定只读证据重建目录。

## 生命周期

1. `start-recording` 创建 Core Processing Run 和唯一 recordingId，先保存 Core 当前计划，再把 `starting` 写入 Feature 私有 SQLite；两者都成功后才通过签名 Operation 打开通用 PageObservation。
2. pause/resume/status/stop 始终绑定同一 observationId、streamId、Connector binding 和 Operation package owner。
3. stop 仅接受 `state=stopped`、`complete=true`、`omissionCount=0` 的终态。
4. Worker 将冻结 Managed Stream 拆成可恢复的后台批次：每次 action 最多并发读取八个固定 128 KiB offset，按顺序组成一个不超过 1 MiB 的 Core input transfer 块。每批先用 Core 原子计划 CAS 持久化 frozen identity、逐块摘要、pending append、transferId、next chunk 与 received bytes，再执行 Core 有序追加；只有 append 明确成功后，第二次 CAS 才推进 next offset。Core commit 最终核对整流 size/SHA-256。不存在先完整扫描、再完整重读的双遍长调用。
5. Python 校验 NDJSON 序列、目标 Engagement、response body 分段与摘要；事件和目录进入私有 SQLite。
6. Python 流式生成 JSON 到 Core output handle；只有 Core 提交 Artifact 且 Processing Run succeeded 后 UI 才显示可下载。

停止会先脱离页面监听，再等待已经接收的响应正文任务完成；只有正文分段写完才写 `observation.stopped`。5 秒内未排空会记录 `pending_capture_drain_timeout` omission 并失败关闭，不能把缺正文的流标成完整。

停止后的固化失败必须对同一冻结流重试；不得重放 stop。摄取中途失败保留已经验证并落库的当前 SQLite 行，重试时逐行核对相同内容后继续。用户也可以直接开始新录制：Worker 会先把旧 Processing Run 明确置为 failed、保留其 SQLite 证据至 24 小时到期，再创建新的 recordingId/Run/observation。上一份导出失败不会永久阻塞下一份录制，当前导出只读取当前 recordingId 的 committed Core Artifact。Connector 以通用 durable PageObservation owner 保存完整 frozen stream；冷启动后只能凭签名 stable owner 或 exact legacy digest、Core 权威历史 binding attestation 与当前 stable scope 精确一致接管，不能凭 Feature 自报身份恢复。

Surface 在“停止”右侧固定显示独立的“重新开始录制”。固化失败、录制失败、流不完整或已有 Artifact 时该动作启用，并执行上述真实旧 Run 收口与新 identity 创建；`stop_confirmed/finalizing` 期间禁用，避免后台固化与新录制竞争。普通“开始录制”只负责首次开始、暂停后的继续以及不确定 open 的同 identity 恢复。

播放器的“导出录制记录”是通用 Artifact Save As 的真实入口，仅在当前 recordingId 已获得 committed Core Artifact 后启用。当前录制失败、正在固化或已重新开始时，即使历史列表仍有可下载 Artifact，该动作也保持禁用；历史产物只能通过各自的 Artifact 卡片下载。

Worker 启动时会从 Core Run 和 Feature 私有计划恢复 Surface，不要求用户先点刷新。若上一代 Worker 在 `finalizing` 中断，启动恢复保留 frozen stream、事件计数、逐块摘要与 Core transfer 断点，并继续投影可自动执行的后台固化。若 Shell 重启后 Core 内存 transfer 已不存在，Feature 会废弃该不确定 transfer，并针对同一 frozen identity 重开；不会再次 stop 或创建 recordingId。Core 已终态 failed 时只允许重新开始，不显示不可执行的固化重试。

pause/resume/stop 在调用通用观察控制前分别持久化 `pausing`/`resuming`/`stopping`。响应丢失时记录 uncertain 计划；后续只读 status 证明真实状态后再收敛。若 status 已证明 stopped，则直接固化原冻结流，不能重放 stop。

## 完整性与隐私

观测固定限制为当前 binding 的 Engagement/Pack 与 Omnia allowlist。Authorization、Cookie、密码、Token、Secret 等字段在 Connector 源头剥离；URL query 只保留 UUID、布尔和有界数字。单响应正文最大 1 MiB，单事件最大 96 KiB，单流最大 64 MiB，最多 100,000 个事件。

任一 omission、目标漂移、页面关闭、预算耗尽、响应分段不完整、摘要不一致或事件序列漂移都失败关闭。目录内容来自 Python 对真实 GET response evidence 的重建；Connector 不提供业务摘要。

## 验收状态

0.4.20 保留 0.4.18/0.4.19 的 successor 与 resource-owner handoff，并把 Python 调用固定到 Recording 唯一 bridge/engine。0.4.16/0.4.17/0.4.18 只能由三个 exact legacy Operation digest 接管；0.4.19 已声明稳定 owner，升级到 0.4.20 时必须验证相同 owner identity、相同 ABI fingerprint 与递增 sequence。旧 Connector 拒绝时继续运行旧 activation head，不重复 stop、不换 recordingId、不删除 observation/stream。发布目录内置 CPython 3.13.14 的同 recordingId/observationId/streamId、revision 0 CAS、stale Python session 接管与并发/崩溃幂等向量继续保持。真实上线仍须完成原 frozen stream → handoff/successor → 多轮后台固化 → Core Artifact 下载 canary，并目视核对导出事件与目录。
