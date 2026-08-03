# 删除元素 Feature 包目录说明

当前版本：`0.1.2 / sequence 3`  
当前状态：独立官方签名包；Shell 0.4.0 的 Local 运行时已接通并可自动激活。

## 目录

```text
delete-elements/
├─ candidates/                 # 已生成的不可变 .ofp 候选
└─ source/
   ├─ middle/worker.cjs        # 当前候选 Worker 状态机源
   ├─ connector-capability/    # 签名 Operation handler 源
   └─ docs/                    # 当前候选随包文档源
```

## 0.1.2 当前实现

0.1.0/0.1.1 是不可变历史候选，仍保持禁用。0.1.2 已补齐：

- 通用 Feature Worker 子进程、双向 RPC 与 action/message-card 路由；
- 私有 plan/evidence、Core Managed Content 和持久 Event ports；
- Local Connector 对 `.ofop` 再验签并加载受限 handler；
- 权威重抓取、单选、计划、右侧唯一确认、二次预检、一次性 permit、单次软删除、读回和刷新。

Remote Operation host 尚未发布，Remote 模式准确禁用且不回退。本轮未使用用户 Omnia 登录，
因此最终现场删除仍待在授权 Pack 上完成；自动化测试不冒充实机 mutation。

## 发布规则

打包脚本只生成 0.1.2，不重写 0.1.0/0.1.1。0.1.2 正式冻结后，任何代码或文档变化必须
提升 Feature patch 版本和 publisher sequence；不能用不同字节覆盖已发布版本。

开发与安装遵循：

- 不把 Windows 隔离认证作为安装、启用或本地测试门槛；
- 用真实依赖原因报告不可用，例如 Connector 未连接、安全锁无效或 Remote host 未发布；
- 不把 HTTP fixture/合同测试等同于目标 Pack 实机验证；
- 由构建器自动签名/digest，安装器自动验证，不要求开发者手工计算 SHA。

完整层级和部署状态见
[v5 Shell 与 Feature 包总览](../../docs/implementation/FEATURE_PACKAGE_CATALOG.md)。
