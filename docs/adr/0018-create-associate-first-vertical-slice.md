# ADR-0018：新建与关联作为首条四 Plane 纵向切片

状态：Superseded in part by ADR-0021（开发顺序与“首条切片”定位被替代；首批范围和 canary 合同保留）  
日期：2026-07-30  
决策者：用户  
Supersedes：ADR-0012 中“首批只有三个 Feature”的范围结论；ADR-0012 的其他历史决定保留

## Context

首批范围原为删除元素、删除聊天记录和录制。用户决定加入“新建与关联”，并用它验证 Delivery、Execution、Control & Data、Integration 四个模块是否真正打通。

v4 已有 Phase 1 的官方模板、静态/实时校验、用户确认、Creator 执行和写后读取经验，但其业务编排跨 Server、Workflow、Toolkit 和 Connector 长分支分散。直接搬迁会把 v4 耦合带入 v5。

“能点通四层”不是充分验收。若使用 mock、历史响应、单个巨型 Connector 命令或只验证创建不验证关联，无法证明 v5 架构成立。

## Decision

1. 首批范围扩展为四个 Feature：新建与关联、删除元素、删除聊天记录、录制。
2. “新建与关联”位于当前建议路径“其他 → 元素管理 → 新建与关联”。
3. 它是第一条实现和验收的真实纵向切片。
4. 第一条 canary 使用用户批准的非生产 Workspace，创建一个新的 Generic Application、一个新的 Generic Database 及两个 GRA core，并双边读回证明唯一的 Database → Application 关系。
5. Risk/Control 后处理、OS、Tool、SAP ECC、批外引用、多 APP、解除和替换关系不进入第一条 canary；后续逐类通过合同和真实 canary 后开放。
6. 四 Plane 共享统一 `traceId`，但按版本化合同和权限隔离：
   - Delivery 只接收/交付；
   - Execution 只生成确定性计划；
   - Control & Data 持久化、确认、编排和保留证据；
   - Integration 只执行小型签名 Operation 和读回。
7. Connector Core 不出现 Phase 1 或新建与关联业务分支，不提供通用 HTTP/脚本或工作簿执行入口。
8. 两个 IT Element、两个 GRA core 与唯一必需关系都经实时读回后，第一条 canary 才成功。
9. 已创建但必需关联失败时，Run 明确为失败并保留部分效果证据；不得显示整体成功，也不得自动删除或自动重放。
10. Local/Remote 使用同一 Feature、Command、确认、幂等和 Evidence 合同，分别完成真实 canary。

## Consequences

- 四 Plane 可以用一条用户可见的真实业务 Run 验收，不需要先做假入口。
- 第一条切片已经包含 Omnia mutation，必须比纯本地切片更早完成安全、确认、幂等、read-back 和 `uncertain` 合同。
- 完整 Feature 的类型覆盖会逐步扩大；未验证类型必须隐藏或禁用。
- 删除聊天记录不再是第一条实现切片，但仍是验证本地数据生命周期的首批 Feature。
- Connector 需要可扩展的 Operation Module，但核心结构不随 Feature 增加而改变。
- canary 会留下真实 Omnia 对象；清理必须走独立删除计划，不能成为隐式补偿。

## Alternatives

### 先做删除聊天记录

外部风险较低，但不能验证 Connector、Omnia mutation、读回和跨 Plane 远程路径，因此不满足用户本次目标。

### 一次迁移完整 v4 Phase 1

覆盖看似完整，但会把对象类型、模板规则和 Connector 业务分支一起搬入，无法证明隔离架构，也扩大首次 canary 风险。

### 用 mock Connector 打通

只能验证界面/消息流，不能证明身份绑定、幂等、实际 effect、读回和 `uncertain`，与真实功能原则冲突。

## Verification

- 详细门槛见[新建与关联 Feature](../product/CREATE_AND_ASSOCIATE_FEATURE.md)；
- 同一 `traceId` 能查询四 Plane 的持久证据；
- canary 必须使用真实非生产 Omnia、真实 Connector 和发布模板；
- 创建、关联、读回任一缺失则不通过；
- Local/Remote 合同测试相同，并各有一次真实路径证据；
- Feature Worker 或 Operation Module 升级失败不影响另外三个首批 Feature；
- Connector Core 静态检查不含 Feature 名称或多步业务分支。
