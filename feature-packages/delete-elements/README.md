# 删除元素 Feature 包目录说明

当前版本：`0.1.5 / sequence 6`
当前状态：独立官方签名 Feature，随 Shell 0.4.12 内置并自动安装/升级，不要求用户运行单独安装包。

## 目录

```text
delete-elements/
├─ candidates/                 # 已生成的不可变 .ofp 候选
└─ source/
   ├─ middle/worker.cjs        # 当前候选 Worker 状态机源
   ├─ connector-capability/    # 签名 Operation handler 源
   └─ docs/                    # 当前候选随包文档源
```

## 0.1.5 当前实现

0.1.0/0.1.1 是不可变历史候选，仍保持禁用。0.1.2 已补齐：

- 通用 Feature Worker 子进程、双向 RPC 与 action/message-card 路由；
- 私有 plan/evidence、Core Managed Content 和持久 Event ports；
- Local Connector 对 `.ofop` 再验签并加载受限 handler；
- 权威重抓取、单选、计划、右侧唯一确认、二次预检、一次性 permit、单次软删除、读回和刷新。

0.1.5 将 0.1.4 的真实 Section 全局关联锁纳入 Shell 0.4.12 builtin 自动安装/升级：删除目标仍需命中显式 Workspace，关联 Workspace 可以落入保存时冻结的真实 Section 成员集合。Remote Operation host 已接通且不存在 Local fallback，最终现场删除仍待在授权 Pack 上完成。

## 发布规则

打包脚本只生成 0.1.5，不重写历史候选。0.1.5 正式冻结后，任何代码或文档变化必须
提升 Feature patch 版本和 publisher sequence；不能用不同字节覆盖已发布版本。

开发与安装遵循：

- 不把 Windows 隔离认证作为安装、启用或本地测试门槛；
- 用真实依赖原因报告不可用，例如 Connector 未连接、安全锁无效或 Remote host 未发布；
- 不把 HTTP fixture/合同测试等同于目标 Pack 实机验证；
- 由构建器自动签名/digest，安装器自动验证，不要求开发者手工计算 SHA。

完整层级和部署状态见
[v5 Shell 与 Feature 包总览](../../docs/implementation/FEATURE_PACKAGE_CATALOG.md)。
