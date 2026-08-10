# 录制版本

## 0.4.19 / sequence 32

- 最低 Shell 版本提高到 0.4.15；旧 Shell 不具备持久化 Operation handoff ledger 与三阶段资源交接，必须在安装前失败关闭。
- 签名 Operation manifest 首次声明稳定 `omnia.operation-resource-owner/v1`：owner family 为 `omnia.page-observation.current-pack`、compatibility epoch 为 1、能力仅 `omnia.page-observation.current-pack.v1`，并精确列出 0.4.16/0.4.17/0.4.18 三个 Operation digest。三代 ABI fingerprint 相同；0.4.19 的 handler、Operation descriptors 与 policy 字节保持 0.4.18 ABI 不变。
- PackageManager 在升级时同时验证旧/新官方签名、同 Feature/package family、稳定 owner identity 或精确 legacy digest；source owner 不允许在 target 中移除。候选与独立 SQLite handoff ledger 在同一事务暂存，ledger 精确区分 Feature/Operation digest，并在非终态期间封锁新的 install、rollback、disable 与 head mutation。新 Worker 先通过 exact health 和本地投影准备；Connector prepare 后旧 digest 与旧 Core head 仍权威；同 token commit 只让新旧 exact registration 并存；随后 Core 才以旧 head exact CAS 切到新版本，并在成功后 finalize 旧注册。Core CAS 前失败进入 durable `abort_pending` 并以同 token 幂等 abort；Core CAS 后只 roll-forward finalize。重启时按 ledger phase 恢复，不从最新 candidate 或 Worker health 猜状态。
- 不认识 `resourceOwner` 的旧 Connector 必须在注册阶段失败关闭；失败时 0.4.18 activation head、Worker、recordingId、observationId、streamId 与 frozen bytes 均保持不变。兼容 Connector 只接管 stopped、complete、零 omission 且 finalized 的同 binding 证据；active/failed/partial 流绝不迁移。
- 热升级先向 Connector 精确注册并 commit 当前 source Operation，target prepare 才能继续；这只证明当前 source provenance。缺少创建时不可变 owner receipt 的历史 orphan 不会由 Worker health 自动 claim，原 quarantine 与字节必须保留，等待用户明确授权的独立法证恢复。
- 0.4.18/sequence 31 候选保持不可变；本版本只生成唯一不可变 `.ofp/.ofop` 候选，不安装、不发布、不重启 Shell/Pack/Edge/Connector。

## 0.4.18 / sequence 31

- 可审计恢复被升级器错误收口的完整 frozen recording：Core 只接受末事件为 `recording.terminal_projection_reconciled`、保留证据且未重放 mutation、无 result Artifact、无 intent/command 的 failed predecessor，并以跨版本 predecessor lineage 为唯一键事务化返回同一 successor Processing Run。
- 对尚无 stream digest 的旧计划，`retry-finalization` 先只读验证 stopped/complete/no-omission/eventCount/stoppedAt，再读取 offset 0 固定块取得 size/digest/chunk count，并以旧计划 revision 0 原子 CAS 固化；崩溃重入不会重复 successor、stop 或 recordingId。
- release CPython 3.13.14 以单 SQLite 事务把同 recordingId 的 stale stopping session 接管到 successor，保留时间、metadata、事件与目录，并写不可变 lineage digest 审计；第三 Run、不同 lineage、无审计 successor、finalized 或 artifact-bearing session 均失败关闭。
- 升级 terminal reconciler 不再关闭具备 recordingId/runId/observationId/streamId/stoppedAt/eventCount 的 retryable `finalization_failed`；包明确声明从 0.4.16/0.4.17 的 `frozen_input_finalize` 兼容。0.4.17/sequence 30 保持不可变。

## 0.4.17 / sequence 30

- 将固化从单次 120 秒内的整流双遍读取，改为按 Surface stateVersion 自动续跑的有界批次；每次最多读取八个 128 KiB 子块并执行一个至多 1 MiB 的 Core append。
- Feature 精确计划通过 Core `compareAndSwapPlan` 在 SQLite `BEGIN IMMEDIATE` 中持久化单调 `storeRevision`、frozen size/digest、逐块摘要、transferId、next stream/Core chunk、received bytes 与 pending append；陈旧 revision 明确失败，CAS-managed 行禁止被 `savePlan` 覆盖。Core append/commit 继续负责严格有序和整流 SHA-256。
- Worker 重启沿同 transfer 继续；Shell 重启或 append 响应不确定时不盲重放同 chunk，先 abort/release，再对同一 frozen identity 重开 transfer。全程不重复 stop、不创建新 recordingId；任何流/块漂移失败关闭。
- Python 处理与真实 Artifact 仍使用发布目录内置 CPython 3.13.14 和既有 Core handle。Connector、Bridge、Core、Shell 与 Renderer 均未修改。

## 0.4.16 / sequence 29

- Worker startup recovery now projects `complete=true` together with `omissionCount=0`; a real complete Core Artifact is no longer mislabeled incomplete.
- Retains the 0.4.15 bounded eight-read finalization, two-pass digest validation, and real Artifact Save As. Connector, Bridge, Core, and Renderer remain unchanged.

## 0.4.15 / sequence 28

- 固定 128 KiB Managed Stream 的两遍读取改为最多 8 路有界并发；每个窗口仍按 offset 顺序累计摘要、核对 chunk identity 并写入既有 1 MiB Core transfer，保持内存有界与双遍 fail-close。
- 加入超过现场 9.4 MiB 失败样本的真实多块回归，验证并发峰值、每 offset 两遍精确读取、digest/size/chunk/EOF 漂移拒绝以及发布内置 CPython 3.13.14 完成固化。
- 恢复真实 `export-recording` Surface 动作，仅当前 recordingId 已有 committed Core Artifact 时启用，并使用通用 Save As；失败/新录制不会误绑定历史 Artifact。
- 0.4.14 候选保持不可变；Connector、Bridge、Core 与 Renderer 均无修改。

## 0.4.14 / sequence 27

- 固化重试只在当前 Feature 版本明确读到 Core Run 为 processing/uncertain 时启用；缺失或跨代不可读一律 fail-close。
- 跨代旧 Run 已由 Core 终态收口时保留 frozen stream/SQLite 证据，只启用真实可执行的“重新开始录制”。
- 0.4.13 候选保持不可变，Connector/Bridge 继续无录制业务。

## 0.4.13 / sequence 26

- 真实录制历史补齐声明式 Surface 要求的 scopeId、disabledReason 与 concurrencyToken，并使用只读“录制历史”scope。
- Worker 启动恢复与状态刷新不再因历史 item 合同不完整而被 Shell 拒绝；历史数据仍来自 release Python SQLite staging。
- 0.4.12 候选保持不可变，Connector/Bridge 继续无录制业务。

## 0.4.12 / sequence 25

- Worker `health` 从 Core Run 与 Feature 私有计划恢复真实 Surface，不再在升级/重启后先显示静态 idle 并要求手动刷新。
- 上一代 Worker 若在 `finalizing` 中断，启动恢复保留 frozen stream、事件计数和摘要证据，明确收敛为 `finalization_failed`；不再次 stop、不创建新 identity。
- Core Run 已经 failed 时仅启用“重新开始录制”，不再显示必然失败的“重试固化”。
- 0.4.11 候选保持不可变；0.4.12 继续保持 Connector/Bridge 无录制业务。

## 0.4.11 / sequence 24

- 在“停止”右侧增加真实 `restart-recording` 动作；固化失败、录制失败、流不完整或已有 Artifact 时启用。
- 重新开始先以 Core 状态转换收口旧 Processing Run，保留旧冻结流与 SQLite staging 24 小时，再创建新的 recordingId、Run 和 observation；不重放旧 stop。
- `stop_confirmed/finalizing` 期间禁用重新开始，普通 `start-recording` 仅负责首次开始、继续和不确定 open 的同 identity 恢复。
- Connector/Bridge 保持通用 PageObservation 传输边界，没有加入录制业务。

## 0.4.8 / sequence 21

- Page Observation 的 GET JSON 响应正文接受 RFC JSON 顶层标量，并继续执行 UTF-8、完整分段、size、SHA-256 与有限 JSON 校验；`false`、`"Higher"` 等合法响应不再导致整条 frozen stream 固化失败。
- 同一 stopped frozen stream 的 recordingId、runId、size、digest 与 chunk count 保持不变，可在升级后原地重试，不再次 stop、不丢弃已经摄取的事件。

## 0.4.5 / sequence 18

- 冻结 NDJSON 通过 Core 受管 `begin/append/commitPythonInputTransfer` 有界分块交付，Processing Run 持久化 frozen-input size/digest/chunk identity。
- 固化重试必须与首次已验证 frozen stream 的 size/digest/chunk count 完全一致，漂移时 fail-close。
- 移除只刷新 Surface 的伪导出 action；唯一下载入口是 committed Core Artifact 卡片。
- 0.4.4 候选保持不可变，0.4.5 使源码、Worker、合同和签名候选恢复一致。

## 0.4.4 / sequence 17

- 停止动作只等待 Page Observation stop，立即显示“已停止/正在固化”，固化改为后台动作。
- 固化失败可从同一 stopped frozen stream 原地重试，不再次 stop、不创建新 recordingId。
- 冻结流在转交 release CPython 前执行两次 size/digest/chunk 校验；Core Artifact 提交与 Run 完成使用事务和 CAS revision。

## 0.4.3 / sequence 16

- 新 recordingId 的 Core 当前计划先落库，Python 私有状态随后落库，两者都成功后才调用 observation open。
- Python 摄取失败保留已验证的当前事件/目录行和真实计数；同一冻结输入可以幂等继续，终态证据仍在 stoppedAt 后精确保留 24 小时。
- 增加 Worker 全链测试：开始、暂停、继续、停止、首次 Artifact commit 失败、同 recordingId 固化恢复、无 Connector 导出、再开始新 recordingId。
- 0.4.2 及更早候选保持历史不可变；0.4.3 待真实公司 Pack canary。

## 0.4.2 / sequence 15

- open/pause/resume/stop 之前先持久化 `starting/pausing/resuming/stopping`；Feature 私有 Store 失败时不发外部控制。
- 控制响应不确定时保存 uncertain 计划，并通过通用 status 收敛；已确认 stopped 后直接固化，不重放 stop。
- 定向测试真实启动发布目录内置 CPython 3.13.14，验证 GRA/Risk/Control/settings/RAIT 导出和 24 小时清理边界。
- 0.4.1 及更早候选保持历史不可变；0.4.2 明确关闭缺少 observation identity 的历史终态 Run，并让重试固化直接绑定当前播放器 recordingId。候选在定向回归后一次性生成，之后由根任务安装并执行真实 Pack canary。

## 0.4.0 / sequence 13

- 删除 Connector 专用 `recording_command`、`RecordingService`、录制状态目录与 gzip 导出。
- 迁移到通用 PageObservation / ManagedStream SDK。
- Feature Worker 独占 recordingId、Processing Run、offset、摘要和最终化重试。
- Python 直接校验冻结 NDJSON，从通用 response evidence 重建目录并写入 24 小时 SQLite staging。
- Python 拆为授权校验、事件分批摄取、目录行构造和流式导出单职责函数；修复新录制空元数据误删已摄取事件的问题。
- Python sidecar 增加 `-B` 进程级隔离，避免 `-E` 忽略环境变量后向签名 Feature 根写入字节码缓存。
- stop 等待已接收响应正文写入；排空超时以 omission 失败关闭。
- 同进程固化失败仍可重试；用户选择重新开始时关闭旧 Run 并保留 24 小时 staging，不再阻塞新 recordingId。
- 需要 Connector 的 Surface action 明确声明 `remote_connector` 依赖。
- 不声明旧 gzip recording 的跨版本恢复兼容性。

0.3.x 候选保持历史不可变，不覆盖、不重签。
