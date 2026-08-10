# 通用传输迁移状态

原 `recording_command` 架构债务已移除。当前链路为：

`Surface → Feature Worker → signed Operation → PageObservationHost/ManagedStreamHost → Core input handle → Feature Python/SQLite → Core output Artifact → Surface`

Connector 只保留平台通用页面观测和流原语；不再保存 recordingId 业务目录、不再分类 GRA endpoint、不再拼目录、不再生成 gzip、不再实现录制专用导出分块。

剩余限制不是隐藏债务：Managed Stream 生命周期绑定当前 Connector 进程，因此不支持 Connector 进程退出后的恢复。Core partial Python input transfer 也是 Shell 进程内状态；Worker 重启可续同 transfer，Shell 重启则只能在冻结流仍在线时，对已绑定的同一 size/digest 安全重开 transfer。该恢复从 offset 0 单遍重传，但不重复 stop、不换 recordingId。
