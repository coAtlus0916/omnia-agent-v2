# 删除元素实现映射 __FEATURE_VERSION__

| Plane | 实现 | 职责 | 禁止事项 |
|---|---|---|---|
| 前台 | `frontend/surface.json` + Shell `selectionBrowser` | 展示真实 Section/Workspace/类型/元素，维护搜索、多选和 Comments 确认入口 | 不推断分组，不伪造对象或完成状态 |
| 中台 | `middle/worker.cjs` | 读取目录，闭合 GRA/关系/IT Element 删除图，按顺序创建 Core 命令并收集证据 | 不直接访问网络，不把业务编排塞进 Connector |
| 后台 | Feature 私有 Store + Core Run/intent/confirmation/command/receipt/tombstone | 持久化冻结计划、每步命令、证据、终态与投影 | 不绕过 confirmation，不把部分成功伪装成整体成功 |
| Connector | `connector-capability/operation/handler.cjs` | 执行有限签名 route：权威读、预检、一次 mutation、独立 readback | 不接受自由 URL/method/body，不持有跨步骤业务状态，不自动重放写入 |

## 状态与图顺序

`createPlan → pending_confirmation → confirm|cancel → executing → completed|failed|uncertain`

`uncertain → reconcile(read-only) → completed|uncertain`

执行顺序固定为 `DB/OS–APP relation → GRA → DB/OS/TOOL/Information → APP`。关系先于 GRA，避免 GRA softdelete 的潜在级联改变显式关系步骤的身份和并发状态。每一步独立持久化 Core command 和 receipt。关系 readback 必须两侧一致不存在；对象 readback 必须命中完全相同的 ID、类型、Workspace 和 recycle-bin 标记。

## 支持矩阵

| 类型 | 目录 | 计划 | mutation | readback |
|---|---:|---:|---:|---:|
| Information | 是 | 零 blocker | softdelete | 独立 detail |
| APP | 是 | 完整批内图 | IT Element softdelete | 独立 detail |
| DB | 是 | 完整批内图 | IT Element softdelete | 独立 detail |
| OS | 是 | 完整批内图 | IT Element softdelete | 独立 detail |
| TOOL | 是 | 零 blocker | IT Element softdelete | 独立 detail |
| 派生 GRA | 由图展开 | Control 级联冻结 | GRA softdelete | 独立 detail |
| DB/OS–APP 关系 | 由图展开 | 两端及 concurrency 冻结 | disassociate | 两侧 search |
| 其他类型 | 仅禁用节点或不展示 | 否 | 否 | 否 |
