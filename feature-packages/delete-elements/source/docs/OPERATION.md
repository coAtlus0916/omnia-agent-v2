# 删除元素 Connector Operation __FEATURE_VERSION__

Operation 包只声明有限 route 和参数，不提供自由 HTTP。Connector handler 是无状态执行器；完整删除图由 Worker 编排。

## Operation 组

- 权威目录：scope、Information collection、Application/Infrastructure/ITTool search、对象 detail、Facet mapping、blocking relationships。
- Information：preflight、softdelete、detail reconcile。
- APP/DB/OS/TOOL：IT Element preflight、softdelete、detail reconcile。
- 派生 GRA：detail/Work Item relationship/delete validator/Control cascade preflight、softdelete、detail reconcile。
- DB/OS–APP 关系：两侧 search 与对象 detail preflight、单条 disassociate、两侧 search reconcile。

四类 preflight 分别只向对应 mutation 发出一次性 permit。每个图步骤在 mutation 紧前重新预检；mutation payload 来自 Core 冻结命令，而不是前端或 Connector 自由拼装。

## 严格读回

- IT Element 与 GRA：精确 ID、类型、Workspace 和回收站标记必须一致。
- 关系：Application 视图与 Infrastructure 视图都必须证明关系不存在且状态一致。
- GRA：确认与提交前 Control ID、Work Item ID、更新时间快照必须完全相同。

如果 mutation 返回不确定状态，Operation 不会自动重试。Worker 只可调用签名 reconcile，并把 readback receipt 交给 Core 决定是否完成该 intent。
