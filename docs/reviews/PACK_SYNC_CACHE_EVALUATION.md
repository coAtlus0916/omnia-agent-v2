# Pack 连接历史、轻/重抓取与 Sync 降级评估

状态：Accepted Product Direction / Technical Details Pending Prototype  
日期：2026-07-30  
范围：产品与架构评估，不授权开发，不改变删除安全合同  
规范决定：[ADR-0025](../adr/0025-authoritative-light-heavy-workspace-reads.md)

## 1. 收敛结论

不再把“首次完整 Sync Pack”作为默认用户流程。Workspace 读取按用途分成：

| Profile | 权威范围 | 主要场景 |
|---|---|---|
| 轻抓取 `workspace_light_read` | 当前 Pack 的 Section/部分 identity + 实时显示名称 + 直接 Workspace identity/名称/状态/最小 capability | 安全锁、Workspace 选择、连接后导航 |
| 重抓取 `workspace_heavy_read` | 上述层级 + 用户选定 Workspace 下、当前 Feature capability 声明的必要元素/关系/锁摘要 | 删除、新建元素、关联、编辑底稿 |

轻抓取是默认实时路径；重抓取按选定范围延迟执行。两者都必须使用 Omnia 权威 identity，禁止按 `TEST`、`20000`、`IT`、`IT Elements` 或其他显示名称推断分类。

Pack 连接历史仍有价值，但 Sync 降级为带新鲜度的可选性能优化。系统可以保存历史 observation，不能要求用户先爬完整 Pack，也不能让缓存直接授权 mutation。

## 2. 为什么改变原 Sync 方向

v4 的 Workspace 列表与按 Workspace 延迟读取通常不是主要性能瓶颈；曾经的高成本更多来自复用完整备份/深度目录和不必要的大响应。把安全锁浏览与元素深读分开后，没有理由在首次连接默认枚举整个 Pack。

原设计还存在更严重的问题：v4 用显示名称猜业务归属，并把 `IT Elements` 等名称固化。缓存或全量 Sync 不能修复错误分类，反而会把错误保存得更久。v5 必须先修正 authority identity，再讨论缓存收益。

## 3. 权威身份模型

每条记录至少绑定：

```text
authority/environment identity
  + tenant identity
  + engagement/pack immutable identity
  + section/part immutable identity
  + workspace immutable identity
  + object type + external identity（重抓取时）
```

同时保存显示字段：

- `sectionDisplayName/workspaceDisplayName/objectDisplayName`；
- `observedAt`；
- `sourceOperation/schemaVersion/capabilityVersion`；
- `coverage/freshness/sourceConsistency`。

显示名称只用于界面。Section 改名不得改变 identity、分类或 operation 选择；不同 Pack 中的同名 Workspace 不能共享记录。

若 Omnia 当前合同不能给出权威 Section/父级 identity：

- 返回 `authority_hierarchy_unavailable`；
- UI 显示“无法取得权威层级/未分类”；
- 依赖层级的 Feature 失败关闭；
- 禁止退回名称正则或默认归入“其他/IT 审计”。

## 4. 轻抓取

### 4.1 必需输出

- 当前 Session/authority/tenant/Pack 冻结身份；
- Section/部分 immutable ID、实时名称、顺序、访问状态；
- 直接 Workspace immutable ID、实时名称、状态；
- 每个 Workspace 的最小 capability/可访问摘要；
- capturedAt、页数、计数、coverage、错误和 Evidence。

### 4.2 明确禁止

- Workspace 下元素正文或全关系图；
- 从 Workspace 名称推断所属 Section；
- 把 Section 显示名当 capability ID；
- 任意 DOM/网页爬虫或原始响应长期保存。

### 4.3 用户体验

- 成功连接并验证 Pack 后自动执行或按 Feature 需要执行一次轻抓取；
- 安全锁/Workspace 选择直接使用该权威结果；
- 用户可以点击“刷新工作区”，这会创建真实只读轻抓取 Run；
- 刷新失败保留 previous observation，但显示 stale/failed，不冒充刷新成功。

## 5. 重抓取

### 5.1 冻结 scope

重抓取请求必须冻结：

- authority/tenant/Pack；
- 用户明确选择的 Workspace 集合；
- Feature ID/version 与 capability ID/version；
- 允许的对象/关系类型和字段集合；
- deadline、取消令牌，以及 maxWorkspaces/maxObjects/maxRelations/maxPages/maxBytes/maxDuration 硬预算。

### 5.2 运行边界

- 按稳定 Session API/SDK、endpoint/type allowlist 枚举；
- 分页、限流、checkpoint、进度、可取消；
- `full` 只表示声明 scope 完整，不表示全 Pack 全正文；
- 有效预算取官方签名 capability、平台策略和请求三者最小值；用户选择不能提高上限，超限返回 partial/limit + coverage/checkpoint；
- partial/failed candidate 不替换上一份成功 observation；
- 无 authority snapshot/cursor/watermark 时标 `non_atomic_observation`；
- Connector 不保存业务主数据，结果经标准 Artifact/Evidence 通道回后台；
- Local/Remote 使用同一 contract，Bridge 不解释或长期保存正文。

### 5.3 Feature 示例

| Feature | 重抓取范围 |
|---|---|
| 删除元素 | 选定 Workspace 内可管理类型的最小元素索引、锁和关系阻塞摘要 |
| 新建与关联 | 选定 Workspace 内目标身份、冲突/重用候选、相关 APP/DB/GRA 与 capability |
| 编辑底稿 | 选定 Workspace 下该底稿合同声明的对象/字段，不自动扩展全 Pack |
| 录制 | 不复用该 profile；录制是独立详细采集能力 |

## 6. PackRegistry 与历史 observation

每次成功识别 Pack 可 upsert 最小 `PackRecord`：

- 稳定 environment/tenant/Pack identity 与当前显示名；
- firstSeen/lastSeen、当前访问状态；
- Connector/Transport/Session 的逻辑 observation；
- capability/schema 版本；
- 最近成功轻抓取/重抓取 observation 指针。

不能保存 Cookie、Authorization、原始 Session 或名称推断分类。

任何历史 observation 在展示 Section/Workspace/元素业务名称前，都必须用当前 principal/Session 重新证明当前 Pack 访问；访问撤销、换用户、Session 不可用或无法取得授权 revision 时，只展示脱敏 Pack 连接历史和“重新连接验证”，不展示缓存业务详情。

历史结果采用不可变 observation：

| 对象 | 作用 |
|---|---|
| `WorkspaceLightObservation` | Section + Workspace 的一次权威观察 |
| `WorkspaceHeavyObservation` | 某 Feature/Workspace/type scope 的一次有界观察 |
| `WorkspaceReadRun` | 分页、checkpoint、取消、错误和完成状态 |
| `ReadEvidence` | source、coverage、计数、digest、一致性、principal、accessCheckedAt/revision 和 authorization Evidence |

它们与 Agent Managed Content 分离：

| Workspace observation | Agent Managed Content |
|---|---|
| 外部只读观察，可陈旧/partial | Agent mutation 经读回证明的 current/revision/change |
| 用于浏览、选择、发现、性能优化 | 用于 Phase 2 等下游业务事实 |
| 不能授权 mutation | 也不能替代 mutation 实时 Omnia 预检 |

## 7. Sync 的降级定位

“Sync”如保留，仅是以下能力的组合入口：

- 对指定 Pack 重做轻抓取；
- 用户选择后，对指定 Workspace/capability 执行一个或多个重抓取；
- 生成带 coverage/freshness 的 observation。

首版不要求：

- 首次连接必须完成 Sync；
- 后续连接出现“继续使用上次快照 / Sync 全部”的强制二选一；
- 自动后台全 Pack Sync；
- 全关系图、正文、附件、Risk/Control 或 Phase 1/2 镜像；
- 固定缓存天数或数量。

若 D5 基准证明轻抓取足够快且重抓取可按需完成，可以不提供独立 Sync 主入口，仅保留 Feature 内真实刷新和设置中的 Pack 历史管理。

## 8. 删除元素的安全链

```text
打开删除 Feature
  → 轻抓取权威 Section + Workspace
  → 用户选择 Workspace
  → 重抓取该 Workspace 的允许元素目录
  → 用户选择目标
  → 生成计划时实时读取：
       authority/Pack/Section/Workspace identity
       当前安全锁与全局锁
       目标存在性/类型/状态
       阻塞关系
       capability 与并发 token
  → 漂移则清理/阻断选择并重读
  → 冻结 plan + preflight digest
  → 右上角消息卡确认
  → 每项 mutation 前 Gate 再实时预检
  → 解除/删除/写后读回
  → 更新 Managed Content tombstone
  → 强制重抓取受影响 Workspace
```

因此历史 observation 只改善首屏与选择体验；生成计划和提交前的两次窄范围检查不变。

## 9. 录制的关系

录制沿用 v4 的详细抓取目标，而不是轻抓取或 Workspace 重抓取的别名：

- 捕获已绑定 Omnia 页面在 capture policy 内的详细请求/响应/事件；
- 在 Connector 源头剔除 Cookie、Authorization、Token、密码和其他 Secret；
- 生成完整性报告、缺失项、范围、segment 和 digest；
- Local/Remote 使用同一 recording contract；
- 原始正文作为敏感 Artifact，不进入普通日志、Event 或未经批准的 AI。

## 10. 权限、隐私和容量

- 每次连接先验证当前 Pack 访问；拒绝或 Session 不可用时不展示缓存业务详情；
- 轻抓取只保存最小层级；重抓取只保存 capability allowlist 字段；
- 数据位于稳定便携 `data` 根，更新不得覆盖；Secret 不进入 observation；
- 默认不按年龄自动删除，但低磁盘时停止新的重抓取/录制或大 Artifact；
- 用户显式移除 Pack 历史时解析 Run/Evidence/Managed Content 引用，不能假称全部物理删除；
- observation 规模、页大小、并发和磁盘阈值由安全更新期 Win11、受支持 LTSC/有效 ESU Win10 代表性 ThinkPad 的 D5 基准冻结。

## 11. 验收

- [ ] 同名 Workspace 在不同 Section/Pack 下不会共享分类。
- [ ] Section 改名后展示实时名称，不继续写死 `IT Elements`。
- [ ] 无权威父级 identity 时失败关闭，不进行名称推断。
- [ ] 轻抓取不含 Workspace 下元素正文。
- [ ] 重抓取 scope 绑定 Pack/选定 Workspace/Feature capability，并支持分页、取消和 progress。
- [ ] 大 Pack 不执行默认全包 dump。
- [ ] partial/failed 不覆盖 last successful observation。
- [ ] 历史 observation 有 capturedAt/coverage/freshness，不能直接授权 mutation。
- [ ] 删除在计划和提交前均执行实时窄范围检查。
- [ ] Local/Remote 结果与错误语义等价。
- [ ] 录制保持独立详细采集、源头 Secret 剔除和完整性证明。

## 12. 仍需 D5 证明

- 目标 Omnia 版本提供哪些 Section/父级 immutable identity；
- 轻抓取在代表性 Pack 的 P50/P95 延迟与响应大小；
- 重抓取的分页/cursor/watermark、一致性、限流和取消；
- 一个典型与大 Pack 中每个 Feature 的元素规模；
- observation Store 容量、低磁盘和清理行为；
- Local/Remote 大分页结果的 parity 与断线恢复。

这些是工程验证问题，不要求用户选择 API、数据库或分页库。
