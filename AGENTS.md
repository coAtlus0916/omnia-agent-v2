# Omnia Agent v5 项目规则

这是 Omnia Agent v5 的唯一开发工作区。任何 Codex/Agent 开始工作前，必须先读取本文件和 [开发入口](docs/development/AGENT_START_HERE.md)。

## 不可违反的实现规则

- 不得交付“看起来能用”的假 MVP：禁止用 mock、sample、演示数据、硬编码数据或无后端入口冒充真实功能。按钮、菜单、筛选、搜索、统计、导出、详情和确认动作都必须连接真实 backend、worker、数据库状态或 Connector 状态；没有真实闭环就隐藏、禁用或明确标记 `coming soon`。
- 按四 Plane 分工实现：前台（Renderer/Surface）只负责交互、文件接收和状态展示；中台（Feature Worker/业务编排）负责规则和运行；后台（Core Store、Managed Content、模板、Evidence、Documentation Registry）负责持久化与版本；Connector 只负责 Transport、Session、Gate 和 Operation host。
- Feature 必须是可独立安装、升级、回滚和测试的官方签名包。包内必须带自己的前/中/后/Connector 实现映射、合同、测试和文档；安装或升级时把该版本文档投影到 v5 文档登记簿。Feature 不能把业务分支塞进 Shell 或 Connector Core。
- Connector Core 只处理连接、会话、能力、传输、Gate 和签名 Operation 装载/执行，不写具体业务流程。Omnia 写入必须经过签名 Operation，并遵守预检、用户确认、幂等键、写后读回、`uncertain` 和只读 `reconcile`；不能靠重放猜测外部结果。
- Local 与 Remote 必须使用相同的业务合同和 Operation 语义；目标 Transport 不可用时明确失败，不得静默 fallback。Remote 可在线升级，但优先升级 Operation/Feature，尽量不改 Connector Core。
- v4 只作为证据、接口和行为参考；不得在 v5 运行时依赖或修改 v4 工作区。需要复用的 v4 资产必须先复制到 v5，再在 v5 命名空间内重构和测试。
- 开发和本地便携测试不增加 Windows 强隔离认证、管理员安装或人工逐次 SHA/Hash 门槛。构建、签名、digest、验签和发布清单由项目工具自动完成；正式发布仍只接受官方签名包。
- 便携 `data/` 与发布/更新目录隔离。不得把用户数据、密钥、日志、旧项目状态或 v4 更新通道混入 v5 产物；v4 更新通道必须保持不变。
- 没有在目标 Omnia、目标 Pack 或授权环境完成 canary 的能力，必须明确写成“未实机验证/待 canary”，不得宣称已完成。Nova 专有协议当前未校验。

## 协作与交付

- 工作树可能同时有其他 Agent 的修改；只改任务范围内的文件，不回滚、覆盖或重置已有修改。
- 文件编辑使用 `apply_patch`；不要用破坏性命令清理工作树。
- 功能实现、状态文档、Feature 随包文档和测试必须同一变更更新。完成前运行与变更相关的测试，必要时运行项目 `npm run check`，并在报告中区分自动化证据、便携冒烟和真实 Omnia canary。
- 文档冲突按以下顺序处理：用户最新确认的要求 → 本文件 → 最新发布/验收记录 → 架构与公共合同 → Feature 设计 → v4 研究/历史快照。发现冲突先记录，不得自行把未验证内容写成已交付。
