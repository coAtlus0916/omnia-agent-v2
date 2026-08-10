# Remote Connector 0.3.14 发布记录

日期：2026-08-05；sequence：17。

本版修正安全锁的 Omnia 真实“所在部分”读取。现场只读录制确认 Omnia LiveIndex 使用固定 `POST /engagements/v1/facets/byEngagementIds`，请求体为当前 Engagement ID 的单元数组。目标 Pack 响应返回 17 个 `CustomWorkspaceGroup` 与 193 个 `CustomWorkspace`，每个 Workspace 的真实 `parentId` 指向对应 Group Facet ID。

Connector 不再使用会丢失 `parentId/facetRelationships` 的 `byFacetType` 读取，也不再把数字菜单 Section 当成权威 Group。新 `omnia.workspace-authority-read/v2` 只回传当前 Pack 的原始 Facet 目录；Core 验证 Engagement 身份、Facet 类型、精确 GUID 与 `CustomWorkspace.parentId → CustomWorkspaceGroup.id` 关系，不使用名称、顺序或 v4 规则分组。缺失真实父级的 Workspace 仍可用精确 Facet ID 锁定，但不会进入全局所在部分授权。

Shell 同时兼容 0.3.13 的 v1 响应以完成滚动升级；v1 只保留精确 Workspace Facet ID，不再尝试从菜单或名称构造所在部分。正式 Remote 更新仍使用现有 stable 自动通道，无需用户下载或替换 Connector。
