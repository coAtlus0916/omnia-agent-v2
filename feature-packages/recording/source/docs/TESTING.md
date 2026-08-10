# 录制验收合同

定向回归命令为 `npx tsx --test tests/recording-feature.test.ts`。测试不使用 Connector 录制专用命令 mock：源码合同检查验证只调用通用 PageObservation；进程测试从当前候选解包并真实启动发布目录内置 CPython 3.13.14；候选合同测试运行包内 self-test，并只安装到隔离临时产品根。Worker 全链向量使用超过现场失败样本 9.4 MiB 的真实 NDJSON，严格按 128 KiB/offset/EOF 返回，验证每个后台 action 最多八个读取、一个 1 MiB Core append、持久 pending append、Worker 重启续同 transfer、Shell transfer 丢失后同流重开、单 transfer 不重复 chunk index、摘要漂移失败关闭；飞行中的 append 在 port 返回前不得推进 checkpoint。真实 Store 向量验证 `storeRevision` 原子加一、陈旧写冲突和 CAS-managed 计划拒绝 `savePlan` 覆盖。同时覆盖开始、暂停、继续、停止立即返回、首次 Artifact commit 失败、同 recordingId/frozen stream 固化恢复和真实 Artifact 导出。

真实 canary 必须验证：

1. 入口依赖真实 Remote Connector；旧 Connector 或 capability 缺失时不显示假成功。
2. start 后出现真实 observationId/streamId；pause/resume 保持同一 identity。
3. 用户操作当前 Pack/GRA 时，事件和网络计数来自真实 status/Artifact。
4. stop 后状态完整、无 omission；Managed Stream 分块与最终摘要一致。
5. Python 能重建真实 GRA/Risk/Control/settings/RAIT；缺证据时目录明确 incomplete，不伪造。
6. Core succeeded 且 Artifact committed 后才能下载；下载 JSON 摘要等于 Core 记录。
7. 固化失败后只允许在同 Connector 进程重读原 stopped stream；不重放 stop。
8. Connector 断线、页面关闭、切换 Pack/Engagement、预算耗尽和 response body 缺失都失败关闭。
9. Artifact、日志和 UI 不包含 Cookie、Authorization、密码、Token 或 Secret。
10. stop 必须等待已经接收的 response body 分段写完；超时必须产生 omission，不能先写完整终态。
11. 旧录制固化失败、录制失败、流不完整或已有 Artifact 后，“重新开始录制”必须紧邻“停止”、关闭旧 Run 并创建全新 recordingId；Worker 重启必须自动恢复这一投影并继续中断的 `finalizing`，不能要求用户先刷新。Core 已 failed 时不得显示不可执行的“重试固化”。
12. 超过 500 条事件必须分批写入 SQLite；验收向量至少覆盖 5,002 条事件，不能存在固定 8 行或单批上限。
13. 至少 9.4 MiB 的 stopped frozen stream 必须按固定 128 KiB 分块续跑；单 action 读取不超过 8 个 offset、Core append 不超过 1 MiB。Worker 重启沿 transferId/offset 继续；Shell transfer 丢失时同 frozen identity 安全重开。内容、摘要、nextOffset、EOF、availableBytes、streamDigest 或既有块 identity 任一漂移都失败关闭。
14. 播放器导出只绑定当前 recordingId 的 committed Artifact；当前失败或新建录制不得因历史 Artifact 存在而启用该动作，Connector 离线不影响已提交 Artifact 的本地 Save As。
15. 升级错误收口恢复必须覆盖旧计划无 storeRevision/stream digest、Core failed rev2、stale stopping Python session：只读 probe 后 revision 0→1 CAS 切换唯一 successor，保留同 recordingId/observationId/streamId/1046 events/stoppedAt，不重复 stop。并发、Core 后崩溃、Python 后崩溃和 CAS 后崩溃重入均不得产生第二 successor。
16. successor 拒绝普通 failed Run、已有 result Artifact、任意 intent/command、第三方 Feature、不同 lineage 或跨 successor generation 冲突；Python 拒绝第三 owner、无审计 successor、finalized/artifact-bearing session 与时间/身份漂移。未来 0.4.16/0.4.17 processing 升级必须保留 retryable plan，不产生 terminal reconciliation event。
17. 0.4.18→0.4.19 热升级必须覆盖两种 Connector：旧 Connector 拒绝未知 owner claim 时不得注册新包、切 activation head、停止旧 Worker、调用 stop 或删除 frozen 流；兼容 Connector 只在 exact legacy digest、同 ABI fingerprint、递增 sequence 与 stable binding scope 下接管，并继续以同 recordingId/observationId/streamId status/readChunk 生成 Artifact。故障注入至少覆盖 Surface 准备失败（register 零调用）、prepare/TTL 失败（旧 head/Worker 可读）、commit 响应丢失（同 token 恢复且新旧注册并存）、commit 后 Core head CAS mismatch（进入 durable `abort_pending`，同 token abort 后旧 head/digest 仍可调用、新 supervisor 退出）与 Core CAS 后 finalize 响应丢失（新 head 可调用、重启先恢复 exact committed token 再 roll-forward finalize、单 activation event）。fixture 必须故意使用不同的 Feature 与 Operation digest，并断言 replaced set 精确等于 source Operation digest。
18. Core handoff ledger 必须在重启后恢复 `staged/prepared/committed/abort_pending/finalize_pending` 的精确 source/target/token/generation。任一非终态 phase 都要拒绝安装第三版本、rollback、disable 与 head mutation；source-owner→no-owner 必须在 staging 前拒绝。历史 unknown-owner orphan 不得从 Worker health 自动 claim，测试必须证明其仍在 quarantine 且 registration 不携带 Feature 私有恢复 attestation。

当前进程级证据（源码态，非公司 Pack canary）：

- 通用 PageObservation：延迟 response body 在 stop 前完成分段、敏感字段已脱敏、旧 owner stream 已释放。
- 发布内置 CPython 3.13.14：真实 NDJSON 完成 SQLite 摄取、GRA/Risk/Control/settings/RAIT 重建、JSON Artifact 和精确 24 小时清理边界。
- 批量摄取：5,002 条事件、5,000 条交互跨至少 11 个批次完成摄取和导出。
- Worker 状态机：首份固化失败后“停止”右侧重新开始启用、普通开始禁用；旧 Run 收口后第二份获得全新 identity，并完成 pause/resume/stop/Artifact 投影。
- Worker 全链：外部 open/pause/resume/stop 前均已持久化；超过 9.4 MiB 的真实多块 NDJSON 以 8 路/1 MiB 有界批次续跑，覆盖 Worker/Shell restart、pending append 与同 transfer 无重复；首次 Artifact commit 失败后当前 recordingId 与已提交输入不丢失，retry 不重放 stop；export 只绑定当前 committed Artifact 且不调用 Connector。
- 失败摄取：第 501 条序列错误时保留前 500 条已验证 SQLite 行，并在 stoppedAt + 24h 精确清理。
