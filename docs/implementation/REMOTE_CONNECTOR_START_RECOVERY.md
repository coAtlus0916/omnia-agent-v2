# Remote Connector 启动恢复

`StartRemoteConnector.cmd` 现在是可验证的一键启动入口，而不是仅提交 detached 进程：

- 便携包高于 `managed.current` 时，先拒绝 active/uncertain Operation，再停止健康旧实例并安装、激活便携包；低版本便携包不会降级托管版本。
- bootstrap Supervisor 使用版本和 SHA-256 marker 校验；跨进程 update gate 在锁内重读 marker，禁止旧便携包并发覆盖较新的 Supervisor，替换成功后才原子发布 marker。
- Supervisor lock 包含随机 token，并由独立 heartbeat 文件持续证明 lock owner、Supervisor 版本和 Worker PID。PID 存活不再单独代表实例健康。
- 旧版 lock 仍受兼容保护：Worker 状态新鲜时视为健康；状态陈旧时先发送 stop 请求。活 PID 仅在 Windows 进程启动时间能够证明它晚于 lock（PID 已复用）时才回收，否则拒绝双开并返回失败。
- stale 回收由每个 contender 独立 claim 和确定性最早存活 winner 串行化；dead/PID-reused owner 的残留可安全回收，仍存活或暂停的 owner 不会仅因超时被夺锁。
- Supervisor heartbeat 原子替换遇到 Windows 临时文件占用会有限退避重试；只有连续写失败超过完整 lease 才停止实例。
- CLI 只有在 Supervisor heartbeat、lock token、Supervisor 最低版本、Worker PID、托管版本和 Worker heartbeat 全部匹配且新鲜时才返回成功。已有健康实例幂等成功；超时返回非零并提示检查 `StatusRemoteConnector.cmd` 与 `supervisor.jsonl`。

边界：启动健康不等于 Bridge 已连接；未配对、凭据需修复或网络不可用时，Worker 可以正常存活但 `bridgeState` 会保留对应诊断状态。启动恢复不会绕过 Operation 安全窗口，也不会修改 v4 Connector。
