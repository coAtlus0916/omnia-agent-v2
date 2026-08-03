# 删除元素 Connector Operation __FEATURE_VERSION__

本 Operation 包只声明五个窄操作：权威 scope read、Information heavy catalog read、Information preflight、Information direct soft delete、Information reconcile。

每个操作列出有限的 method、route template、参数类型与 body parameter。没有自由 URL、自由 header、自由 body、通用 HTTP 或通用 JSON Patch 入口。descriptor 中 mutation 不默认开放：只有 Local 已连接、安全锁有效、右侧消息卡确认 action 通过、第二次权威 preflight 未变化且签名 read Operation 发出一次性 permit 时，Core 才对单次 direct Operation 授权；permit 消费后不能重放。Remote Operation host 尚未发布，Remote 模式准确禁用且不回退 Local。
