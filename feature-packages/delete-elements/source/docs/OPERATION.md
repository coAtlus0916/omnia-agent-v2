# 删除元素 Connector Operation __FEATURE_VERSION__

本 Operation 包只声明五个窄操作：权威 scope read、Information heavy catalog read、Information preflight、Information direct soft delete、Information reconcile。Application、Database、Operating System、Tool、Workpaper、GRA、Control、Documentation 和 Deficiency 没有写入 Operation，前台只能显示真实目录节点和禁用原因，不能开放删除。

每个操作列出有限的 method、route template、参数类型与 body parameter。没有自由 URL、自由 header、自由 body、通用 HTTP 或通用 JSON Patch 入口。descriptor 中 mutation 不默认开放：只有当前 Remote binding/Session/Pack 有效、安全锁有效、Comments 消息卡确认通过、第二次权威 preflight 未变化且签名 read Operation 发出一次性 permit 时，Core 才对一个目标的一次 direct Operation 授权；permit 消费后不能重放。多目标由 Feature/Core 以独立 Command 串行编排，Operation 不接收自由批量请求。Remote 失败明确关闭且不存在 Local fallback。
