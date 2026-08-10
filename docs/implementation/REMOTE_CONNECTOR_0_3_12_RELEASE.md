# Remote Connector 0.3.12 发布记录

日期：2026-08-04；sequence：15。

本版将 Workspace Facet Type 修正为 v4 已验证值 `d0c7e20c-1451-48d2-9dd5-8a6f2a51bfc0`，并新增固定合同 `workspace_authority_read`。Connector 只验证当前会话/Pack、执行两个固定 GET、限制原始响应大小并回传绑定身份；Workspace 过滤、命名、Section 展示关系、空目录判定和安全锁授权全部由 Shell Core 负责。

稳定通道支持 Bridge 0.4.5 的无参数 `update_check`。本记录不宣称目标公司电脑或真实 Pack canary 已通过。
