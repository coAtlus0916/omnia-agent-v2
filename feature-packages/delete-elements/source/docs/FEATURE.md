# 删除元素 Feature __FEATURE_VERSION__

状态：官方签名独立 Feature，随 Shell 0.4.12 内置并自动安装/升级；Connector 只执行包内签名 Operation。

## 用户交互

菜单使用两级 `其他 > 删除元素`。工作台以声明式 `selectionBrowser` 展示 Omnia 权威 Section → Workspace → 元素类型目录；搜索只过滤当前 snapshot，折叠不改变后台事实。Information 支持 checkbox 多选和“全选当前可选结果”，选择通过 `runtime.set-selection` 写入持久 Surface；禁用类型和阻塞项显示真实原因。确认、进度和终态只通过 Comments Agent 消息卡交付。不提供底部删除篮、二次弹层或伪造目标数据。计划进入终态后请求 Shell 执行权威刷新。

## 安全不变量

- 只接受 Connector 权威重抓取返回的对象身份；名称仅用于展示。
- 删除目标必须命中显式 Workspace 锁；全局锁只把 Omnia 返回的真实 Section GUID 展开为关联 Workspace 范围，不允许名称分类或伪造 Section。
- 计划冻结 Connector ID、会话 generation、Pack ID、安全锁完整快照、Workspace IDs、对象类型/ID、WorkItem ID、并发时间戳、blocker signature 和 plan digest。
- 用户确认后，在每个写操作前再次执行 scope read 与 preflight；任何身份、关系、Workspace、并发信息或安全锁变化都会阻止提交。
- `commit_attempted` 只在实际调用 mutation 前持久化。
- 提交点出现 timeout、EOF、502/503/504 或响应丢失时，绝不重放写操作；状态转为 `uncertain`，只允许只读 reconcile。
- 写后必须由独立 GET 读回确认；确认删除后写入 managed-content tombstone，并请求权威刷新。

## 当前对象范围

当前候选只开放 Information 无 blocker 的多目标 direct delete；每个目标独立产生持久 Command、receipt、readback 和 tombstone，批次不能把部分成功伪装成整体成功。Application、Database、Operating System、Tool、Workpaper、GRA、Control、Documentation 和 Deficiency 可作为真实目录类型节点显示，但必须禁用并说明：0.2.0 尚无同时覆盖权威目录、实时 preflight、delete/disassociate 和独立 readback 的签名 Operation。关系解除也未进入开放范围。

## 验证边界

安装后首次启动 Shell 会验证 Worker 健康与嵌套 Operation 签名，再将当前版本切为 active。初始 Surface 明确处于依赖读取状态；只有 Remote Connector、当前 Pack、安全锁和对应签名 Operation 都有效时才开放 action。最终确认会取得并消费一次性 mutation permit。不存在 Local fallback。本轮未使用用户 Omnia 登录；源码实现、构建或签名包生成均不等同于目标 Pack 实机删除已完成，现场仍需在授权 Pack 对最小 Information 批次执行 canary。

## 版本说明

__VERSION_NOTE__
