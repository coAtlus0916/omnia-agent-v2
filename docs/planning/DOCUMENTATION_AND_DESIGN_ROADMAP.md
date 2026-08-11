# 文档与设计收敛路线

状态：In Progress  
日期：2026-07-30

本路线最初用于把 Omnia Agent v5 从“重构构想”推进到“具备可执行开发基线”。Shell 和首个 Feature 候选已经在后续授权中实现，因此“当前阶段只产出文档、不创建产品代码”的描述属于历史阶段边界，不再作为当前开发门禁。

2026-08-01 更新：后续采用 [Feature 快速开发、安装与测试指导](../development/FEATURE_FAST_ITERATION_GUIDE.md)。Windows 强隔离认证不再阻碍 Feature 安装/启用；签名和 digest 由工具自动完成，开发者不逐次人工核对 SHA。D5/D6 中未完成的原型可按具体 Feature 风险执行，但不再构成统一的“开发前全部完成”门槛。

## 1. 总体门禁

```mermaid
flowchart LR
    A["D0 v4 事实审计"] --> B["D1 产品范围收敛"]
    B --> C["D2 首批 Feature 详细设计"]
    C --> D["D3 公共合同与数据模型"]
    D --> E["D4 安全、部署与运维设计"]
    E --> F["D5 有界技术原型"]
    F --> G["D6 开发前第二次验收"]
    G --> H["用户明确批准开发"]
```

没有通过当前阶段退出门槛，不提前进入下一阶段；“未来需要原型”不等于当前已经获准编写原型代码。

## 2. 阶段状态

| 阶段 | 状态 | 主要产物 | 退出门槛 |
|---|---|---|---|
| D0 v4 事实审计 | Complete | v4 全面审计、资产/风险矩阵 | 事实有代码/测试/文档证据，优缺点和不可迁移项明确 |
| D1 产品范围收敛 | In Progress | PRD、首批范围、Accepted ADR、开放决策说明 | 首批 Feature、UI、Remote、删除语义、菜单和迁移边界获确认 |
| D2 Feature 详细设计 | In Progress | 新建与关联、删除元素、删除聊天记录、录制设计 | 每项 owner、状态机、数据、权限、失败/恢复、验收完整 |
| D3 公共合同与数据模型 | Draft | contracts、Feature Package、Store/Template | 四个 Feature 不靠私有旁路，公共版本/幂等/错误语义一致 |
| D4 安全、部署与运维 | Draft | 威胁模型、Bridge、sandbox、备份/恢复、发布 | 高风险边界有可测试控制和失败关闭规则 |
| D5 有界技术原型 | Optional / Risk-based | 每项独立的原型问题、fixture、指标、通过/失败阈值、退出和 ADR 回填 | 随具体 Feature 风险执行，不作为统一安装门槛 |
| D6 第二次文档验收 | Superseded as universal gate | 覆盖矩阵、冲突扫描、剩余风险 | 可用于候选/发布复核，不再阻止开发完成后立即安装测试 |

## 3. D1：产品范围待办

- [x] 首批 Feature：新建与关联、删除元素、删除聊天记录、录制。
- [x] 开发顺序固定为“录制 → 删除元素 → 删除聊天记录 → 新建与关联”；第四项作为首批四 Plane 综合验收。
- [x] 先交付无内置业务 Feature 的真实 Shell Baseline，再把四个首批功能作为独立包逐个安装和验收。
- [x] 每个 Feature 逐 capability 记录四 Plane 实现；签名文档与代码同包 staging，并通过单一 activation record 原子发布到项目 Documentation Registry。
- [x] 后台保存 Agent 创建/修改/删除内容的 current/revision/change/tombstone，并通过版本化查询提供给 Phase 2。
- [x] “删除安全锁内元素”改名“删除元素”，安全锁不取消。
- [x] 三列主界面，第三列保留聊天。
- [x] 功能菜单最多三级，二级或三级均可作为 Feature 叶子。
- [x] Remote 面向全部版本。
- [x] Remote Connector 保留分层在线升级能力，并优先升级 Operation Module。
- [x] Nova 精确协议延后且不宣称支持。
- [x] 删除工作台恢复“选择工作台 + 右上角消息卡”责任分工的设计复核完成。
- [x] 所有一级界面右上角提供统一全局缩放控制。
- [x] 除主 Shell 最小固定 Rail 外，允许调整的相邻长期功能区域使用统一可调整边界。
- [x] 删除模式移除常驻“待删除元素”篮子；底栏显示数量，完整清单在右上角消息卡复核。
- [x] 删除聊天正文立即物理删除、无引用附件清理、必要业务/Evidence 分离保留。
- [x] 删除与录制使用 v4 固定 evidence baseline 和既有测试方法，不要求用户准备专用 Pack。
- [ ] 冻结“新建与关联”canary 的非生产 Workspace、模板版本、APP/DB 测试对象和清理 owner。
- [ ] 完成[“新建与关联”默认文档准备项目](CREATE_ASSOCIATE_DEFAULT_DOCUMENT_PROJECT.md)：来源/许可、默认规则、保护区域、Validator、审批和 `TemplateVersion` 发布。
- [x] Remote Connector 默认由服务器自动下发，自动验证并在真实安全窗口激活；安全阻断不可关闭。
- [x] 冻结 Feature 独立安装、升级、回滚与 Shell-first 交付模型。
- [x] 生产只允许官方签名 Feature/Operation 包；首版不开放第三方或任意离线导入。
- [x] 冻结数据产品边界：同一根分离 releases/data、默认无按年龄自动删除、Secret Windows 保护、更新不覆盖 data。
- [x] 冻结模板发布者：用户本人或持有单次、精确 digest 授权的 Codex；发布服务记录授权/签名/validation/Evidence，首版不强制双人审批，见 ADR-0029。
- [x] 完成 [Phase 1 模板母版](PHASE1_TEMPLATE_MASTER_WORKBOOK_TODO.md) 与最终工作簿；当前继续用户业务整理、默认文档确认和首个 `TemplateVersion` 发布。
- [x] 冻结 v4 首版零迁移；需要时只读按类打捞。
- [x] 冻结普通 ThinkPad 产品范围：普通 Win10/Win11 均可安装、连接和使用；SKU/build/补丁状态用于兼容性记录和风险提示，不作为统一阻断，具体建议配置通过真机测试形成。
- [x] 冻结 Workspace 权威轻/重抓取与 Sync 降级：禁止名称推断，重抓取按 Pack/Workspace/capability 有界。

详细解释见 [剩余评审项说明](../reviews/OPEN_DECISIONS_GUIDE.md)。

## 4. D2：每个 Feature 设计必须回答

每份首批 Feature 详细设计至少包含：

1. 用户目标、明确非目标和稳定名称；
2. 每个 capability 的 Delivery/Execution/Control & Data/Integration 四 Plane 实现映射；不适用项写明原因；
3. 输入、输出、权限和真实依赖；
4. 持久状态机、幂等、取消、超时、重启恢复；
5. 数据 owner、Artifact/Evidence、保留和删除；
6. Connector Operation 的 effect、preflight、confirmation、read-back 和 reconcile；
7. Local/Remote 等价性；
8. UI 的 loading/empty/disabled/error/uncertain；
9. 无 mock 的合同、行为、E2E、故障和安全验收；
10. v4 可复用证据与禁止直接迁移的实现。
11. 是否管理共享业务内容；对象/关系 Schema、adopted baseline、current/revision/change/tombstone、freshness、provenance 和下游查询。

## 5. D3：公共设计冻结顺序

1. Feature Navigation 与 FeatureContext；
2. Run/Step/Event/Error；
3. Confirmation、Plan digest、Idempotency；
4. Connector Command、active lease、capability 和 reconcile；
5. Artifact、Evidence、Retention；
6. Provider Profile 与 Secret；
7. Feature Package manifest、兼容矩阵、安装/升级/回滚；
8. Feature Documentation manifest、实现映射、崩溃安全安装 journal 与 Documentation Registry 原子激活合同；
9. Agent Managed Content 对象/关系、变更状态、Evidence gate 和 Phase 2 查询；
10. Core DB/Module Store 所有权和跨模块 API。
11. Workspace 轻抓取/重抓取、权威 identity、分页/取消/Evidence 和 observation freshness。

Feature 私有合同可以增加字段，但不能重定义公共状态或绕过 Core/Connector Gate。

## 6. D4：安全与运维专题

| 专题 | 必须形成的文档证据 |
|---|---|
| Windows Worker 可选加固 | 权限矩阵、文件/网络/进程边界、超时回收、攻击测试计划；不作为安装/使用认证门槛 |
| Remote Bridge | 信任模型、身份/密钥生命周期、E2E、TTL、重放/限流、故障恢复 |
| Remote Connector 在线升级 | 分层包、更新源、签名/sequence、A/B、安全窗口、probation、回滚、Supervisor bootstrap |
| 数据保护 | Secret、DB/Artifact 加密、日志脱敏、保留、备份/恢复、删除传播 |
| Agent 管理内容 | 类型 Schema、current/revision/change/tombstone、partial/uncertain、漂移、Phase 2 最小化查询 |
| 供应链 | 发布者、签名、SBOM、依赖锁、包验证、canary、回滚 |
| Feature 文档供应链 | 必备类型、digest/链接、四 Plane 漂移、敏感信息、安全渲染、代码/文档 activation record 一致与恢复 |
| Omnia mutation | 最小权限、安全锁、实时预检、确认、写后验证、uncertain/reconcile |
| 录制隐私 | 白名单范围、凭据剔除、业务正文处理、完整性、受控导出 |
| Workspace 读取 | 权威 Section/Workspace identity、轻/重 profile、分页/取消、无名称推断、Local/Remote parity |

## 7. D5：未来原型计划的边界

技术原型只回答无法靠文档证明的问题，不做可交付 UI，也不使用 mock 结果冒充产品。测试 fixture 只产生验证证据，不得注册 Feature、菜单或“已安装”状态：

| 原型问题 | 代表性验证 | 结果进入 |
|---|---|---|
| Core/Worker IPC | 崩溃、背压、身份、版本不兼容、吞吐 | runtime/IPC ADR |
| Store 与恢复 | 并发、磁盘满、重复投递、迁移中断、全局 backup epoch、真实恢复、损坏检测、大 Artifact、Managed Content outbox/revision/tombstone/查询 | storage/backup ADR |
| Windows/Feature UI 可选加固 | 越权文件/网络/进程、解析炸弹、跨 DOM/CSS/store/Bridge、UI 死循环与超时回收；按风险执行 | sandbox ADR；不阻塞安装测试 |
| Remote Bridge | 断网、重连、重复/乱序、TTL、大文件、设备撤销 | Bridge ADR |
| Remote Connector 更新 | 篡改/降级、下载中断、candidate crash、active mutation、probation rollback、不 fallback | 在线升级 ADR/Runbook |
| 包安装与激活 | 每个 journal 阶段崩溃/断电、迁移 checkpoint、代码/文档/schema/data compatibility 绑定、previous-readable 回滚 | installer/storage ADR |
| Managed Content 一致性 | authority identity、whole-object 读回、freshness maxAge/watermark、projection repair、并发漂移 | managed-content/storage ADR |
| UI 密度 | 真实 Windows 缩放、键盘、长标签、大状态列表 | UI NFR 基线 |
| 容量与治理 | 代表性录制、revision、文档版本和可选 snapshot 规模；低磁盘、配额、GC 与导出/删除 | data-governance/NFR ADR |
| Workspace 读取 | 代表性 Pack 的轻抓取延迟/大小；重抓取分页、取消、cursor/watermark、同名/改名/缺父级和 Local/Remote parity | ADR-0025 / NFR 基线 |

原型数据必须是人工构造的测试夹具；不得复制客户数据、生产凭据或原始录制。

每个原型计划必须先写明：唯一问题、明确非目标、fixture 来源、量化阈值、故障注入、失败退出、可删除产物和结果应回填的 ADR。一个原型不得同时替 runtime、Store、sandbox、Bridge 和业务 Feature 做结论；失败不能靠在 Core 中加入业务特例绕过。

## 8. D6：候选/发布复核清单（不作为日常安装门槛）

- [ ] 所有 Accepted 产品决定在 PRD、ADR、合同、Feature 设计中一致。
- [ ] 每个首批 Feature 有一条真实后端到 UI 的计划路径，没有无 owner 的入口。
- [ ] 数据删除、Evidence 保留、备份恢复无自相矛盾。
- [ ] Local/Remote 使用同一 Connector 合同且单 active lease。
- [ ] Remote Bridge 对使用 Remote 的 capability 真实可达；Windows/Feature UI sandbox 证据作为可选加固记录，不要求外部强隔离认证。
- [ ] Feature 独立升级、失败隔离、回滚和兼容策略已冻结。
- [ ] crash-safe staged install、持久 journal、单一 activation record、previous-readable 回滚和逐阶段故障恢复有原型通过证据。
- [ ] 每个 Feature 的四 Plane 实现映射、文档安装门禁和 Documentation Registry 激活记录一致性已冻结。
- [ ] Managed Content authority identity、whole-object/关系级 partial、freshness maxAge/watermark、projection repair、create/update/delete/adopt/uncertain/reconcile 与 Phase 2 查询已冻结。
- [ ] 全局 backup epoch/barrier、引用闭包和真实 restore rehearsal 有通过证据；RPO/RTO 与保留决策已有 owner。
- [ ] DeepSeek/Custom Provider 的真实测试合同明确；Nova 仍隐藏。
- [ ] v4 首版零迁移；未来按类打捞工具保持只读，Secret/配对/在途状态明确禁止迁移。
- [ ] 目标 Windows 与 NFR 阈值已冻结。
- [x] Shell Baseline 已在后续授权中实现；历史 D5 fixture 仍不得冒充用户可见能力。
- [ ] 主 Agent 对具体候选/发布做范围内验收；不要求每个开发改动都走一次全量 Go/No-Go。
- [x] 用户已批准开发，并进一步确认“开发好即可安装测试”的快速路径。
