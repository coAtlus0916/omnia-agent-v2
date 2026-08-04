# 删除元素 Feature 包

当前版本：`0.2.1 / sequence 8`

0.2.1 是不可变官方 Feature 候选，随 Shell builtin 自动安装/升级。Connector 只执行包内签名 Operation；删除图的计划、确认、逐步命令、证据和终态全部由 Worker 与 Core Run 管理。

## 真实功能范围

- 权威目录：Information、APP、DB、OS、TOOL。
- Information：仅零 blocker 时直接 soft delete。
- TOOL：仅零 blocker 时直接 IT Element soft delete。
- APP/DB/OS：允许选择完整批次，计划显式展开其派生 GRA 和批内 DB/OS–APP 关系。
- 图顺序：DB/OS–APP 解关联 → 派生 GRA → DB/OS/TOOL/Information → APP。先完成关系的双向读回，避免 GRA softdelete 可能产生的级联状态变化使显式关系步骤失去可执行身份。
- 每个 GRA、关系和 IT Element 都拥有独立 Core intent、confirmation 下的命令、Operation receipt 和权威 readback；GRA/IT Element 删除成功后分别写入 tombstone。
- GRA 预检冻结真实 Control 级联快照；关系解关联冻结每个 Infrastructure 的 tab-602 并发令牌（缺失时才使用 APP tab-502），写后从 APP 和 Infrastructure 两侧读回。

Workpaper、独立 GRA、Control、Document 和 Deficiency 没有完整独立删除合同，因此保持禁用；不会上线假入口。

## 安全边界

目标必须命中显式 Workspace 安全锁，且所有影响 Workspace 必须在当前安全联合范围内。确认前和每次写入前都重新读取身份、Workspace、blocker、并发状态及 GRA Control 级联。任何漂移都会阻止写入。响应不确定时绝不重放 mutation，只允许只读 reconcile。

## 发布规则

打包脚本只生成 `0.2.1 / sequence 8`，不会覆盖任何历史 `.ofp`。本目录的源码和文档不等于目标 Pack 实机验证；真实授权 Pack 的回归结果必须单独记录。
