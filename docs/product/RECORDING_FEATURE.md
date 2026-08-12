# Feature 设计：录制

状态：实现候选，待真实 Pack canary

录制用于观察当前已经连接并绑定的 Omnia Pack 页面。用户界面像播放器：开始、暂停/继续、停止、导出。它自动采集当前页面中允许的交互、页面快照和只读 JSON response evidence，不再要求单独点击“采集 Risk/Control”。

## 用户可见规则

- 开始前必须有真实 Remote Connector 和当前 Pack binding。
- 暂停/继续使用同一录制身份；停止后自动固化。
- 只有 Core 中真实 succeeded Run + committed Artifact 才显示导出可用。
- 目标漂移、页面关闭、断线、遗漏、预算耗尽或摘要错误必须明确失败，不显示假成功。
- GRA/Risk/Control/settings/RAIT 来自 Feature 对真实只读证据的重建；证据不全时必须标记 incomplete。

## 架构原则

- Surface 不采集数据、不伪造计数。
- Feature Worker 拥有录制业务、Run、offset 和恢复决策。
- 每次开始、暂停、继续、停止都先写入 Feature 私有持久状态；响应不确定时只通过真实 status 收敛，不盲目重放控制。
- 摄取或 Artifact commit 失败时保留当前 recordingId 和已验证 SQLite 行；同一冻结输入恢复时不重放 stop。
- 升级误把可恢复固化收口为 failed 时，只允许对原 frozen stream 创建带 predecessor lineage 的唯一 successor Processing Run；不回退旧 Run、不新建 recordingId、不再次 stop。
- Python 使用发布包内 3.13.14 runtime，处理 NDJSON、目录重建、SQLite 24 小时暂存和 JSON 输出。
- Core 拥有 Run、受管 handle 与 Artifact。
- Connector 仅提供通用当前 Pack 页面观测、固定脱敏与 Managed Stream，不包含“录制”业务。
- 导出只读取当前 committed Core Artifact，不要求 Connector 在线，也不把上一份录制作为输入。

## 安全与限制

仅允许当前 binding 的 Omnia origin/Engagement。Cookie、Authorization、密码、Token、Secret 在 Connector 源头剥离。单流最大 64 MiB、最多 100,000 事件、单 JSON response body 最大 1 MiB。普通 Artifact 要求终态完整且 omissionCount 为 0。

当前只支持同一 Connector 进程内对 stopped stream 重试固化，不支持跨 Connector 进程断点恢复，也没有 Local Transport fallback。

## 上线验收

- 当前 Pack 中真实 start/pause/resume/stop 状态正确。
- 打开并操作 GRA 后，导出包含真实事件和重建的 Risk/Control/settings/RAIT。
- 断线、切 Pack、关页面和缺失 response evidence 均失败关闭。
- Artifact 与 Core 记录的长度、SHA-256 一致，且不含凭据。
- 录制功能不修改 Connector 更新、凭据、Bridge 或重连链路。
