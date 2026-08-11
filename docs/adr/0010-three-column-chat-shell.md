# ADR-0010：三列主界面保留聊天

状态：Accepted  
日期：2026-07-30  
决策来源：用户产品决策

更新说明：三列与第三列保留聊天的决定继续有效；第一列/第二列职责和顶部会话栏已由 [ADR-0032](0032-shell-layout-and-settings-surfaces.md) 更新；第三列通过固定 `Comments` + Feature 标签实现，见 [ADR-0034](0034-tabbed-feature-host-and-detachable-surfaces.md)。

## Context

v5 已决定删除“+ Agent”，并把第二列从 Agent/用户列表改为三级功能树。尚未决定第三列是否继续使用聊天，还是完全改成结构化功能工作区。

## Decision

主界面保持三列：

1. 第一列为应用 Rail 和系统入口；
2. 第二列为后台驱动的一级/二级/三级 Feature 树；
3. 第三列保留聊天与交付工作区。

用户选择 Feature 后，后台建立持久 `FeatureContext`。第三列固定 `Comments` 继续提供聊天、上传、真实进度、确认、结果和 Artifact 交付，Feature 默认显示为同区域 docked 标签，并可主动弹出/最小化为受控独立窗口；不能删除聊天，也不新增永久第四列。

“+ Agent”、Agent profile 和用户可创建 Agent Room 不再进入 v5 产品信息架构。

## Consequences

正面：

- 保留用户熟悉的自然语言协作与文件交付；
- 第二列功能树提供确定性入口，聊天提供上下文和解释；
- 首批 Feature 可以共享同一个 Delivery Surface。

成本：

- 必须严格区分聊天消息、FeatureContext、Run 和业务状态，聊天文字不能直接获得写权限；
- 删除聊天记录需要处理 Run、Artifact、Evidence 的引用和保留边界；
- 结构化高风险确认不能只靠自然语言消息，仍需真实后台 action 和明确 UI。

## Verification

- 选择/切换 Feature 后第三列聊天保持可用；
- 刷新、重启和多窗口从后台恢复 FeatureContext；
- 自然语言提示不能绕过 Feature 权限、预检或确认；
- 第三列所有进度和终态来自 Run/Event；
- 删除聊天记录不会删除 Feature、配置或必须保留的 Evidence。
