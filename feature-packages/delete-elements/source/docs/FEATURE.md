# 删除元素 Feature __FEATURE_VERSION__

状态：官方签名独立 Feature，随 Shell builtin 自动安装/升级；Connector 只执行签名 Operation，Worker 负责删除图编排。

## 用户交互

工作台使用声明式 `selectionBrowser` 展示 Omnia 权威 Section → Workspace → 元素类型。支持当前权威快照搜索、折叠、checkbox 多选和批量选择；计划、确认、进度与终态只通过 Comments 消息卡交付。

Information 与零 blocker TOOL 可直接纳入计划。APP、DB、OS 必须以能闭合依赖图的批次选择：关联的 APP 与 DB/OS 两端均须显式选中。Worker 在确认卡出现前展开派生 GRA 与 DB/OS–APP 关系，显示图步骤数量；不会把未知 blocker 隐藏或自动忽略。

## 删除图

固定顺序为：

1. 逐条解除 DB/OS–APP 关系，优先使用每个 Infrastructure 独立的 tab-602 并发令牌，写后从两侧读回。
2. 删除派生 GRA，并冻结 GRA Control 级联快照。
3. 删除 DB、OS、TOOL、Information。
4. 最后删除 APP。

每一步都是独立 Core intent/command/receipt/readback。GRA 和 IT Element 必须由独立 GET 证明进入回收站后才写 tombstone；关系必须由 Application 与 Infrastructure 两个查询视图共同证明不存在。

## 安全不变量

- 只接受 Connector 权威目录返回的不可变 ID；名称仅用于展示。
- 所有目标必须命中显式 Workspace 锁；关系两端及 GRA 均必须留在安全联合范围。
- 计划冻结 Connector、session generation、Pack、Workspace、对象、Work Item、blocker、并发令牌、GRA Control 级联和 plan digest。
- 用户确认前重验整张图；每个 mutation 前再次实时预检并取得该步骤的一次性 permit。
- 身份、Workspace、关系、级联、并发或安全锁漂移时不提交写入。
- timeout、断线或响应丢失后不重放 mutation，只允许只读 reconcile。
- 没有真实 Operation/readback 的类型保持禁用，不提供假按钮。

## 版本说明

__VERSION_NOTE__
