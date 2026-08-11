# Shell 0.4.10 发布记录

## 结果

0.4.10 修复安全锁保存与弹窗首次刷新重叠时触发 Remote Connector 受控并发上限的问题。同一完整 Connector/authority/tenant/Pack/engagement identity 的并发 Workspace authority 读取只共享正在进行的 Promise，完成后立即清除；不同 identity 不复用已完成结果。

安全锁弹窗扩大为双栏工作台：左侧由 Core 投影的真实 Omnia Section/Workspace 关系支持搜索、折叠和组内全选，右侧始终显示完整已选 Workspace。Omnia 没有返回 `parentSectionId` 的 Workspace 明确进入“未返回所在部分”，只允许精确 Workspace 锁，不伪造所属关系。

顶部全局安全锁保存真实 Section GUID，并在同一 authority observation 内展开、冻结精确 Workspace Facet ID。删除目标仍必须命中显式 Workspace 锁；删除关联只允许落在显式锁或全局冻结成员内。Section 或成员漂移会使安全锁失效并要求重新保存。

## v4 复用结论

采用 v4 工作台的搜索、折叠、筛选不丢选择和右侧已选列表交互；拒绝 v4 的 Workspace 名称正则分类，因为它不是 Omnia 权威 Section。v5 授权始终使用当前 Pack identity、真实 Section GUID 和精确 Workspace Facet ID。

## 验证边界

源码 typecheck 暴露仓库既存 canary/历史测试类型错误；本轮按用户要求未运行单元测试。Shell build 已通过。目标公司电脑上的真实 Section membership、全局删除关联与写后读回仍需用户 canary，不能以本机构建替代。
