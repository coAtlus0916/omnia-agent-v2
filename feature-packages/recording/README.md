# Omnia Recording Feature

当前源码候选为 `omnia.recording@0.4.19 / sequence 32`，最低要求 Shell 0.4.15。录制使用签名 Operation 调用平台通用 `PageObservation` 与 `ManagedStream` 原语；Connector 不包含录制状态机、业务 URL 分类、GRA 目录拼装或 gzip 导出协议。

Feature Worker 拥有 `recordingId`、Processing Run、观测流 offset、重试与 Core Artifact 完成事实。随包 CPython 3.13.14 校验冻结 NDJSON、在 Feature 私有 SQLite 中暂存 24 小时，并从真实只读 JSON response evidence 重建 GRA/Risk/Control/settings/RAIT。

0.4.3 在 0.4.2 的状态机上进一步保证：新 recordingId 的 Core 当前计划与 Python 私有状态均先于 observation open 持久化；摄取中途失败会保留已验证的 SQLite 行并按同一冻结输入幂等恢复，不再删除当前录制。上一份成功、失败或未导出的录制不会成为下一份录制或当前 Artifact 导出的隐式输入。

0.4.5 把冻结 NDJSON 通过 Core 受管分块交给内置 Python，并将首次验证的 size/digest/chunk identity 绑定到 Processing Run；后续重试若流漂移必须失败。真实导出只通过 committed Core Artifact 下载卡，不再暴露仅刷新 Surface 的伪导出按钮。真实 Pack canary 仍是上线前置条件。

0.4.11 在“停止”右侧增加真实的“重新开始录制”动作。固化失败、录制失败、流不完整或已有 Artifact 时，它会先明确收口旧 Run 并保留 24 小时 SQLite 证据，再创建全新的 recordingId/Run/observation；停止已确认且正在固化时保持禁用，避免与同流重试竞态。

0.4.12 在 Worker 启动时直接从 Core Run 与 Feature 私有计划恢复 Surface；无需先点刷新即可得到真实的重新开始状态。若旧 Worker 在 `finalizing` 中断，新 Worker 会保留 frozen stream 和证据并明确转为 `finalization_failed`，不会继续显示永久禁用的固化中状态。

0.4.13 修正恢复 Surface 的历史列表合同：真实 Python staging 历史使用完整的只读 scope/item 字段，启动恢复和后续状态刷新均可通过 Shell 严格校验；不删除、不伪造历史记录。

0.4.14 对跨代旧 Run fail-close：只有明确读到当前版本 Core Run 为 processing/uncertain 才显示“重试固化”；旧 Run 已由 Core 终态收口或无法由当前版本读取时，只显示真实可执行的“重新开始录制”。

0.4.16 在 0.4.15 的有界并发固化与真实 Artifact 导出基础上，修复 Worker 启动恢复 succeeded Run 时遗漏 `omissionCount=0` 的投影错误；已完整固化的录制不会再误显示“不完整”。

0.4.17 删除单次 120 秒调用中的整流双遍传输：停止仍只完成 PageObservation stop 并立即投影“已停止/正在固化”；后台每次最多读取八个 128 KiB 块并向 Core 追加一个至多 1 MiB 的输入块。Feature 精确计划使用 Core `compareAndSwapPlan` 的 SQLite `BEGIN IMMEDIATE` 原子 CAS 持久化 storeRevision、frozen size/digest、逐块摘要、Core transferId、pending append 与 next offset；`recording-current` 只作普通指针。Worker 重启继续同一 transfer；Shell 重启导致内存 transfer 丢失时，先废弃不确定 transfer，再对同一 frozen stream 重开，不重放 stop、不换 recordingId。最终整流 SHA-256 仍由 Core commit 强制核对，漂移失败关闭。

0.4.18 修复升级器把可恢复 `finalization_failed` 误收口为 Core failed 后的恢复断点。Worker 先以只读 status 和 offset 0 探测冻结流，再由 Core 在 `BEGIN IMMEDIATE` 中验证 predecessor 正是 `recording.terminal_projection_reconciled`、无输出 Artifact、无 intent/command，并幂等创建唯一 successor Processing Run。Python 在单事务中把同 recordingId 的非 finalized staging session 从 predecessor 接管到 successor；随后私有计划以旧 revision 0 CAS 切换并继续 0.4.17 分阶段固化。全程保留 observationId、streamId、eventCount、stoppedAt 与 lineage，不再次 stop 或创建 recordingId。
0.4.19 增加签名 Operation 资源所有权声明，并由 Shell 0.4.15 的通用持久化 handoff ledger 执行 prepare、commit、Core activation-head CAS、finalize；旧 Shell 或旧 Connector 必须在切换前失败关闭。升级不自动认领缺少创建者回执的历史 orphan，原始隔离证据必须保留。
