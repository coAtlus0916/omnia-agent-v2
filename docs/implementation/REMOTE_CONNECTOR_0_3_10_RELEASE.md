# Remote Connector 0.3.10 发布说明

状态日期：2026-08-04
Sequence：13
基线：0.3.9 / sequence 12

发布状态：已发布到 v5 stable 通道；公开 manifest 与 archive 已读回匹配，部署过程确认 v4 stable manifest 未改变。公司电脑自动激活与真实 Pack 安全锁仍待现场读回。

## 变更

`WorkstationOmniaSession.workspaceLightRead` 不再要求每个 Workspace 都存在 Section/parentSectionId。授权目录仍只接受当前 Pack 实际返回的精确 Workspace Facet ID；Section 映射仅在真实、无歧义且指向已返回 Section 时保留，否则返回空父级供 Shell 未分组展示。零 Workspace 继续失败关闭，且不存在名称推断、Local fallback 或任意 URL/method/body。

该修改只调整公共 Session 目录语义，不把安全锁或业务分支写入 Connector Core。Shell/Core 继续拥有安全锁 observation、CAS 和目标校验。

## 现场验证边界

候选包和 stable manifest 的生成/验签不等于目标公司电脑已激活。需在真实登录 Pack 上读回 Workspace 目录，保存至少一个精确 Facet ID，并确认 mutation action 前 Core/Gate 校验同一 Pack 和安全锁版本。
