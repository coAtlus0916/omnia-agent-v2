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
- Shell 只维护一个 `releases/` 产品根：根内放 `portable-root.json`、`current`、启动脚本和版本外 `data/`，版本字节放在 `releases/<version>/`。不得再生成或维护第二套 `artifacts/` 便携目录或 ZIP；除非用户以后明确重新授权，Shell 发布、启动和用户测试都直接使用 `releases/`。
- 没有在目标 Omnia、目标 Pack 或授权环境完成 canary 的能力，必须明确写成“未实机验证/待 canary”，不得宣称已完成。Nova 专有协议当前未校验。

## 协作与交付

- 工作树可能同时有其他 Agent 的修改；只改任务范围内的文件，不回滚、覆盖或重置已有修改。
- 文件编辑使用 `apply_patch`；不要用破坏性命令清理工作树。
- 功能实现、状态文档、Feature 随包文档和测试必须同一变更更新。完成前运行与变更相关的测试，必要时运行项目 `npm run check`，并在报告中区分自动化证据、便携冒烟和真实 Omnia canary。
- 文档冲突按以下顺序处理：用户最新确认的要求 → 本文件 → 最新发布/验收记录 → 架构与公共合同 → Feature 设计 → v4 研究/历史快照。发现冲突先记录，不得自行把未验证内容写成已交付。

## 开发、验收与发布纪律

- 新 Feature 或基于 v4 经验的任务在编码前必须冻结：支持矩阵、`v4 symbol → v5 落点 → 测试向量 → 采用/重写/拒绝` 复用矩阵、DoR/DoD、明确非目标和文件所有权。v4 研究默认限制在 15–20 分钟；超时应报告证据缺口或拆分任务，不得边开发边无限扩大研究和实现范围。
- 只补当前真实纵切所必需的平台能力。非阻塞的通用平台重构、额外对象类型或额外业务阶段必须另立任务；未实现能力隐藏或真实禁用，不得为了看起来完整而扩大本轮范围。
- 强制顺序为：范围冻结 → 开发与定向测试 → 真实产物/视觉验收 → 一次完整验收 → 冻结源码、版本和清单 → 一次构建 → 按变更 Plane 一次打包与签名 → 最小安装/启动/升级冒烟 → 发布。禁止先落版本或候选包、再回头运行源码业务测试。
- 开发内环不反复签名、压缩或生成发布清单。只有准备可安装候选、验证升级/回滚或正式发布时才签名；签名证明来源和完整性，不替代业务测试与验收。
- 验收通过后产生的候选必须是唯一不可变发布输入。Portable、upgrade、canary 和正式发布复用同一产物，不得重新 build、重新压缩或重复生成内容不同的包；冻结后若业务代码变化，候选立即作废并返回验收阶段。
- 发布阶段不重复执行已经通过的源码 lint、typecheck、业务测试或全量 `npm run check`，只执行目标版本/组件身份、官方签名与 manifest、安装/启动/升级、原子切换和回滚点等最小产物门禁。Feature/Operation 单独变化时只打对应 `.ofp/.ofop`，不得无理由重打 Shell 或 Connector。
- Shell 启动验收必须执行用户实际入口（`releases/Start Omnia Agent v5.cmd` 或 `releases/<version>/Omnia Agent v5.exe`）。只检查入口文件存在、只运行 PowerShell `ResolveOnly`、设置测试环境变量或绕过入口直接启动 EXE，都不得宣称用户入口通过；每个版本仍以用户直接测试结果为准。
- 禁止人工或重复执行全树 before/after SHA/Hash。保留并自动化执行真正的信任边界：官方包生成时的 manifest/digest/signature、外部包进入安装边界时的一次验签、正式 Remote 更新的目标身份与 v4 通道隔离，以及业务 Plan/Request/Response/Read-back/模板来源证据 digest。同一已验签不可变产物应进入内容寻址受管存储并复用验证结果。

## 快速开发经验（强制执行）

- 先读真实代码、运行日志、数据库状态和目标协议，再判断问题；界面文案和按钮存在不等于能力存在。首轮必须画清 `Frontend → Middle → Core/Data → Connector` 的真实调用链和断点，随后只修断掉的纵切。
- 优先复用当前架构已经存在的 Store、Worker Host、Operation Host、Connector Session 和 Artifact 出口。v4 只复用已经实证的状态语义、端点与失败边界；不得复制整套宿主，也不得为了“重做得更干净”引入第二条链路。
- 先冻结最小真实闭环和支持矩阵，再批量修改协议、实现、声明式 Surface 与文档。业务分支留在 Feature Worker/Operation；Shell/Core 只增加可复用合同，禁止按 `featureId` 或按钮名称硬编码业务行为。
- 前端状态必须由同一后台状态机投影；暂停、停止、导出、恢复等动作不能使用 Renderer 本地布尔值冒充成功。失败必须沿 Connector → Middle → Surface/日志原样可见，禁止吞错后返回成功文案。
- 跨进程或 Remote 大结果必须先核对传输上限，并使用现有 Artifact Store 的分块/受管交付闭环。Connector 本机路径不是用户可交付产物；超过平台上限时应明确失败，不得截断后标记完整。
- 开发内环按一个连贯纵切集中修改，完成后只运行一次与改动相称的 typecheck/build 或定向检查。用户明确要求暂停单元测试时，不在内环偷跑测试；打包、签名、发布和真实 Omnia canary 作为独立外环，未执行就明确标注。
- 文档和支持矩阵只在代码纵切闭合后更新，并准确区分“源码已实现”“候选包已生成”“已安装冒烟”“真实 Omnia canary 已通过”。这些状态不得互相替代。
- 每轮结束记录加速收益：复用了哪些稳定边界、删除了哪些重复链路、把多少往返合并为一次批量修改、哪些实机依赖仍留到 canary；下一轮优先复用这些结论。
