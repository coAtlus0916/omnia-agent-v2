# Bridge 0.4.6 发布记录

状态：源码已实现；按用户要求未运行单元测试、全量检查、构建、打包或部署。生产环境是否已切换、公司电脑 Connector 是否恢复以及真实 Pack 校验结果，必须由后续发布与现场 canary 证明。

## 修复范围

- Bridge 的命令路由、在线计数与状态投影只以 WebSocket `OPEN` 和最近一次 `pong` 未超过 stale timeout 为新鲜条件。heartbeat 发出 `ping` 前设置的探测中 `isAlive=false` 不再把健康连接短暂判为离线；超过 stale timeout 的半开连接仍会终止并通知 Shell。
- Shell 不再把单次命令级 `REMOTE.CONNECTOR_OFFLINE` / `REMOTE.CONNECTOR_DISCONNECTED` 结果永久写入 Connector 在线状态。持久在线状态继续由 Bridge `state` envelope 负责。
- `health`、`status`、`connect` 是有界只读/连接探测，即使 Shell 当前投影为离线也可穿透到 Bridge。任何真实 Connector 响应都会把在线投影恢复，其他读写 Operation 在离线时仍失败关闭，不存在 Local fallback。

## 四 Plane 与边界

- Frontend：无新入口、无假状态；现有 Shell 状态继续消费 Main 的真实 Connector snapshot。
- Middle/Core：仅修复 Remote Transport 的在线状态恢复与探测门禁，不改变 Feature 业务逻辑或持久数据合同。
- Backend/Bridge：修复 heartbeat RTT 窗口内的路由新鲜度判断；binding、generation、命令 deadline 和 mutation uncertain 语义保持不变。
- Connector：公司电脑 Worker 无代码变化，仍只响应现有固定操作合同；本轮不新增任意 HTTP、脚本或 Local fallback。

## 待发布验证

1. 从冻结源码构建并生成唯一 Bridge `0.4.6` 候选，再按现有部署合同原位升级。
2. 公开 health 必须返回 `version=0.4.6`、正确 build identity/protocol，并观察 Connector 自动恢复在线。
3. 在 heartbeat RTT 窗口连续执行 `status` / `connect`，不得出现瞬时离线；停止 Connector 超过 stale timeout 后必须真实离线。
4. 使用目标公司电脑和真实 Pack 重跑 Workspace 读取与新建/关联校验；未完成前不得声明真实 Omnia canary 通过。
