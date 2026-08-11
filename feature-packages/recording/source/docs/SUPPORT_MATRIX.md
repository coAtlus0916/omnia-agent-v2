# 录制支持矩阵

| 能力 | 状态 | 说明 |
|---|---|---|
| 当前 Pack 页面观测 | 已实现 | 通用 `omnia.page-observation.current-pack.v1` |
| 开始/暂停/继续/停止/状态 | 已实现 | 签名 read-only Operation 调用通用 SDK |
| 控制意图前置持久化 | 已实现 | `starting/pausing/resuming/stopping` 先进入 Feature 私有 SQLite 与计划 |
| 控制响应不确定收敛 | 已实现 | 只读 status 核对；stopped 直接固化，不重放 stop |
| Managed NDJSON 传输 | 已实现 | 128 KiB 子块、每 action 最多 8 块/1 MiB、逐批断点、最终 Core SHA-256 |
| 源头脱敏 | 已实现 | Connector 固定策略，不含 Feature 业务 |
| Python staging/导出 | 已实现 | 发布内置 CPython 3.13.14、SQLite 24h、Core Artifact |
| 摄取失败保留当前记录 | 已实现 | 已验证 SQLite 行不删除；同冻结输入逐行幂等核对后继续 |
| GRA/Risk/Control/settings/RAIT 重建 | 已实现 | Feature Python 从观测到的真实 GET JSON evidence 重建 |
| omission 后普通 Artifact | 不支持 | 必须失败关闭 |
| 同 Connector 进程固化重试 | 已实现 | 重读同一 stopped stream，不重放 stop |
| 固化失败后开始新录制 | 已实现 | 关闭旧 Run、保留 24h staging、创建全新 identity |
| 独立重新开始按钮 | 已实现 | 紧邻“停止”；固化失败、录制失败、流不完整或已有 Artifact 时启用，固化进行中禁用 |
| Worker 重启续传 | 已实现 | 从私有计划恢复 transferId/offset/pending append；同 Shell Store 继续同一 transfer |
| Shell 重启传输恢复 | 已实现（安全重开） | Core partial transfer 为进程内状态；丢失时废弃旧 transfer，对同一 frozen identity 从 0 单遍重开，不重复 stop/recordingId |
| 导出与上一份录制隔离 | 已实现 | 只读取当前 recordingId 的 committed Core Artifact；不调用 Connector |
| stop 响应正文排空 | 已实现 | 已接收任务先写分段；5 秒超时产生 omission |
| 大批事件摄取 | 已实现 | SQLite 500 条/4 MiB 分批；进程检查覆盖 5,002 条事件 |
| 跨 Connector 进程恢复 | 不支持 | owner release 会清理观测和流 |
| 本地 Transport fallback | 不支持 | Remote-only，断线不切本地 |
| 真实公司 Pack canary | 待执行 | 构建/自检不能替代现场验收 |
