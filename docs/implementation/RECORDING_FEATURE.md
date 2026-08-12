# 官方录制 Feature 实现

当前冻结候选为 `omnia.recording@0.4.19 / sequence 32`，最低要求 Shell 0.4.15。源码已从录制专用 Connector 命令迁移到 [ADR-0037](../adr/0037-generic-page-observation-and-managed-stream.md) 定义的通用 PageObservation / ManagedStream 原语。0.4.19 保留 0.4.17 的有界分阶段固化与 0.4.18 的 failed predecessor → 唯一 successor 恢复，并增加签名 Operation 资源所有权声明，由 Core/Shell 通用持久化 handoff ledger 执行 prepare、commit、activation-head CAS、finalize/abort。旧 Shell、旧 Connector 或不匹配的 source digest 在切换前失败关闭；缺少创建者回执的历史 orphan 不自动认领。候选不安装到当前产品根；真实 Pack canary 仍未完成。

## 四层归属

| 层 | 文件 | 责任 |
|---|---|---|
| Delivery | `feature-packages/recording/source/frontend/surface.json` | 播放器式 UI，只显示真实 Worker 状态和 Artifact |
| Execution | `feature-packages/recording/source/middle/worker.cjs` | recordingId、Processing Run、观测控制、流 offset、摘要、最终化 |
| Control/Data | Feature Store ports、`python/recording_store.py` | 受管 handle、Core Artifact、计划、SQLite 24h staging |
| Integration | `src/connector/page-observation-host.ts`、`managed-stream-host.ts`、签名 Operation | 当前 Pack 通用只读观测、源头脱敏、有界 NDJSON 流 |

Connector 不再拥有 `RecordingService`、录制业务状态机、GRA/Risk/Control endpoint 分类、目录拼装、gzip 或录制专用分块命令。Feature Python 的 `gra_catalog.py` 才是业务证据分类与目录重建边界。

## 真实链路

1. Worker 创建 Core Processing Run 与唯一 recordingId，并先把 `starting` 写入 Feature 私有 SQLite 和计划。
2. 只有前置持久化成功后，签名 Operation 才调用 `sdk.pageObservation.open`，返回 observationId 和 streamId。
3. pause/resume/status/stop 始终绑定同一 owner、Connector binding 和当前 Pack。
4. stop 后仅完整且无 omission 的流可进入普通 Artifact 流程。
5. Worker 每个后台 action 最多并发读取八个 128 KiB Managed Stream 块，并按 offset 向 Core 追加一个至多 1 MiB 的 Python input transfer；逐块 identity、EOF、总长度与 stream digest 均持久校验。
6. 发布包内 CPython 3.13.14 校验事件序列和 response segments，在 SQLite 中暂存事件与重建目录，并流式写 Core output handle。
7. 只有 Core commit Artifact 且 Processing Run succeeded 后 UI 才提供下载。

固化失败可对同一 stopped frozen stream 重试，且不得重放 stop。0.4.19 只接受平台 durable owner 与精确签名 handoff 证明；旧的无 owner receipt orphan 仍保持隔离，不把 Feature 私有计划当作所有权证明。

若升级器曾把具备完整 observation identity 的 `finalization_failed` 错误收口为 failed，恢复动作先只读验证 status 与 offset 0，再由 Core 核对 predecessor 最后审计事件、无 Artifact、无 intent/command，并幂等取得唯一 successor。旧 plan 即使没有 storeRevision 或 digest，也先以 revision 0 CAS 写入探测结果，再切换 successor；同 recordingId、observationId、streamId、eventCount 和 stoppedAt 不变。

pause/resume/stop 同样先持久化 `pausing`/`resuming`/`stopping`。若控制响应丢失，Worker 记录 uncertain 计划；后续只读 status 证明 observing/paused/stopped 后再收敛。status 已证明 stopped 时直接固化原冻结流，绝不再次调用 stop。

## v4 复用决定

| v4 精确证据 | 保留行为 | v5 落点 | 决定与验证 |
|---|---|---|---|
| `connector/src/omnia-recorder.js` `start`/`pause` | 同一 recordingId 暂停后继续 | Worker + PageObservation owner | 重写；定向测试覆盖前置持久化和同 identity |
| `connector/src/omnia-recorder.js` `stop` | 排空已接收正文、完整性失败关闭、只释放录制资源 | 通用 PageObservationHost + Worker 终态校验 | 采用行为，不迁移 CDP 实现；Connector 现有测试 + Feature contract |
| `connector/src/omnia-recorder.js` `export` | 停止与导出事实分离 | Python staging → Core output handle → committed Artifact | 重写；发布内置 CPython 进程测试 |
| `tests/omnia-recorder.test.js` 完整性与恢复用例 | omission/digest/序列漂移失败关闭 | ManagedStream 校验 + Python NDJSON 校验 | 采用不变量；拒绝旧目录、锁和 gzip 格式 |
| `tests/omnia-recording-server-contract.test.js` stop/download 状态 | 不完整不得冒充完成 | Worker/Run/Artifact 投影 | 重写；定向测试 + 真实 Pack canary |

明确拒绝迁移 v4 的 Connector 录制器、CDP 业务状态、录制目录、专用 recording command 与 gzip 导出。Connector 只保留既有通用 Operation host、PageObservation 和 ManagedStream。

## 验收

开发阶段执行 `npm run build`、Node 语法检查和 `npx tsx --test tests/recording-feature.test.ts`。定向测试真实启动发布目录内置 CPython 3.13.14，验证状态持久化、GRA/Risk/Control/评分设置/RAIT 重建、JSON 输出和精确 24 小时清理边界；handoff 向量验证旧 Connector 切换前失败关闭、三阶段 ledger 崩溃恢复、旧 activation head 保留和未知 orphan 不自动认领。真实公司 Pack 的 start → GRA 操作 → pause/resume → stop → Artifact 下载与内容目视核对仍是上线门槛。
