# 删除元素实现映射 __FEATURE_VERSION__

| Plane | 包内实现 | 输入 | 输出/持久化 | 失败边界 |
|---|---|---|---|---|
| 前台 | `frontend/surface.json` + Shell 通用 `selectionBrowser` Renderer | 真实 Section/Workspace/元素类型 scopes 与权威重抓取 items | 折叠、snapshot 搜索、结果/可选计数、checkbox 多选、持久 selection、禁选原因、sticky footer | 不按 featureId 写分支；计划/确认/进度/终态只在 Comments 消息卡 |
| 中台 | `middle/worker.cjs` | 窄 Connector/Store/Event ports | 计划、证据、动态 surface、消息卡终态 | 独立子进程；不直接访问网络/文件系统；提交后失败统一 uncertain |
| 后台 | 私有 migration + 平台通用 Store ports | 结构化 plan/evidence/managed-content/event | 私库计划/证据、Core current/change、持久刷新事件 | Feature 不能访问任意 Core 表；重启可恢复计划和消息卡 |
| Connector | `connector-capability/operation.ofop` 内 `operation/handler.cjs` | 官方签名 invocation | scope/heavy-read/preflight/direct/reconcile | handler 只能调用声明 step；Core 不接收自由 URL/method/headers/body；permit 一次消费 |

## 中台状态机

`createPlan(multiple targets) → pending_confirmation → confirm|cancel → executing → completed|failed|cancelled|uncertain`

`uncertain → reconcile(read-only) → completed|uncertain`

状态机冻结身份、安全锁、真实 Section GUID 及其精确 Workspace 成员展开，对第二次 preflight 做 digest 比较，在提交前保存 checkpoint。目标必须命中显式 Workspace 锁；当前只允许零 blocker Information，其他真实类型节点失败关闭。多目标按独立持久命令串行执行，成功读回后逐目标写 managed-content tombstone，终态发出 `workspace.authoritative_refresh_requested`。

## 安装与文档

代码、Operation、migration、SBOM 与本文档属于同一 Ed25519 envelope。安装器先验证全成员，再写 immutable package，最后以一个数据库事务切换 activation head、Feature Registry 与 Documentation Registry。文档另投影到便携根的 `data/documentation/features/<featureId>/<version>/<digest>/`，由 activation head 指向同版本路径。
