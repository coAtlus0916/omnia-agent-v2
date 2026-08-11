# ADR-0012：首批三个 Feature

状态：Superseded（范围由 ADR-0018、导航由 ADR-0020、开发顺序由 ADR-0021 替代；历史记录保留）  
日期：2026-07-30  
决策来源：用户产品决策

## Context

v5 需要用首批真实 Feature 验证微内核、三级导航、三列聊天、后台唯一事实、模块隔离和 Connector Gate。此前未决定从 v4 的哪些能力开始迁移。

## Decision

首批范围固定为“其他”下的：

1. 删除元素；
2. 删除聊天记录；
3. 录制。

“删除元素”是“删除安全锁内元素”的新用户可见名称；安全锁仍是强制服务端和 Connector 边界。

当前建议二级分组：

- 其他 → 元素管理 → 删除元素；
- 其他 → 会话管理 → 删除聊天记录；
- 其他 → 诊断与取证 → 录制。

三项均按统一 Feature Package 标准独立开发、部署、升级和回滚，不打成一个共享业务 Worker。

内部实现顺序建议为“删除聊天记录 → 录制 → 删除元素”，用本地数据、Connector 采集、高风险 mutation 逐级验证平台；这是一项 Proposed 的实施顺序，不改变 Accepted 的首批范围。

## Consequences

- 首批范围不会引入 Phase 1、Phase 2、Controls 或 EMS 的业务迁移；
- 删除聊天记录成为后台事务/引用/恢复的验证切片；
- 录制成为 Transport、长运行状态、Artifact 和 Evidence 的验证切片；
- 删除元素成为安全锁、关系解除、写入和 `uncertain` 的验证切片；
- 三项必须共享合同和平台机制，但业务代码、数据和发布生命周期保持隔离。

## Verification

- 功能树只在三个 Feature 真实可用时展示相应叶子；
- Feature A 崩溃或升级不影响另外两个；
- 三项在 Local/Remote 下使用同一合同；
- 删除元素无法越过安全锁；
- 删除聊天记录无法越权删除业务数据；
- 录制结果绑定真实 Connector/Session/Engagement 并通过完整性验证。
