# ADR-0025：权威轻抓取与有界重抓取

状态：Accepted  
日期：2026-07-30  
决策者：用户

## Context

v4 的 Workspace 分类曾根据 `TEST`、`20xxx`、`IT` 等显示名称推断业务归属，并把 `IT Elements` 等标签固定在代码和 Connector 合同中。这会把同名 Workspace 分错组，也会在 Pack 已改名后继续显示旧名称。

另一方面，不同 Feature 的读取目的并不相同。安全锁浏览只需要知道 Pack 中真实的部分/Section 及其 Workspace；删除、新建元素、编辑底稿等能力还需要读取选定 Workspace 下与本次操作有关的元素。若所有场景都先做全 Pack 深度 Sync，会增加延迟、隐私、分页和缓存一致性成本。

## Decision

1. Workspace 读取统一分为两种权威 profile：
   - `workspace_light_read`（轻抓取）：读取当前 Pack 的权威部分/Section identity、实时显示名称、层级顺序，以及其直接 Workspace identity、显示名称、状态和最小 capability 摘要。用于安全锁、Workspace 选择、连接后导航和轻量刷新。
   - `workspace_heavy_read`（重抓取）：在同一权威 Section/Workspace identity 基础上，读取用户已选范围内、当前 Feature capability 明确声明需要的元素 identity、类型、最小显示字段、关系/锁摘要和分页 Evidence。用于删除元素、新建元素、关联和编辑底稿等需要元素目录的场景。
2. 分类、权限、路由和 operation 选择禁止依赖 `TEST`、`20000`、`IT`、`IT Elements` 或任何其他显示名称/正则。显示名称只用于展示；身份与归属必须来自 Omnia 的权威 Section/Workspace 字段和不可变 ID。
3. 若当前 Omnia 读取合同不能提供可信 Section/父级 identity，该记录标为 `unclassified/authority_hierarchy_unavailable`，相关依赖层级的 Feature 失败关闭。系统不得退回名称猜测。未来手工映射如确有需要，必须另立合同并按 `authority + tenant + pack + workspace` 隔离，不能污染权威来源。
4. 重抓取必须有界：
   - scope 冻结为当前 authority/tenant、Pack、用户选择的 Workspace 集合、Feature/capability 和声明对象类型；
   - 请求和结果必须显式保存 `Section → Workspace` 父子映射；每个 Workspace 携带权威 `parentSectionId`，不得靠数组顺序或名称重建；
   - 支持分页、限流、deadline、取消、checkpoint、计数和 progress；
   - 每次请求必须具有 `maxWorkspaces/maxObjects/maxRelations/maxPages/maxBytes/maxDuration` 硬预算；有效值取官方签名 capability、平台策略与请求三者的最小值，用户选择不能放大；
   - 触达预算返回明确 partial/limit 状态、coverage 和 checkpoint，不得静默截断并声称完整；
   - Connector Operation 使用 endpoint/type allowlist，不做任意网页爬虫、DOM 抓取、全包无界 dump 或原始响应长期镜像；
   - `full` 只表示声明范围完整，不表示整个 Pack 所有正文、关系和对象均已抓取。
5. 轻抓取是进入依赖 Workspace 的 Feature 前的默认实时读取。重抓取仅在具体 Feature 需要元素目录时触发，可按选定 Workspace 延迟加载；二者都不是 mutation 授权。
6. PackRegistry 可保存最小连接历史；读取结果可以作为带 `capturedAt/source/coverage/schema/capability/freshness` 的历史 observation 复用，但 Sync 降级为可选的性能优化，不再作为首次连接或 Feature 进入的默认前置流程。
   observation 还必须绑定 principal、最近访问检查时间/revision 和 authorization Evidence；当前 Session 无法重新证明 Pack 访问时，只能展示脱敏 Pack 历史，不得展示缓存的 Section、Workspace 或元素详情。
7. Feature 内“刷新”创建真实只读 Run：
   - 轻刷新重读 Section + Workspace；
   - 重刷新只重读当前选定 Workspace 与 capability scope；
   - partial/failed candidate 不替换上一份成功 observation，UI 必须显示其采集时间和陈旧状态。
8. 删除等 mutation 继续执行两次窄范围实时检查：生成计划时读取所选目标与锁/关系/并发状态；提交前由 Connector Gate 再预检。历史轻/重抓取结果不能直接授权 mutation。
9. LocalTransport 与 RemoteBridgeTransport 使用完全相同的 profile、scope、分页、Evidence、错误和取消合同；Remote Bridge 不解释或长期保存正文。
10. 录制是独立的详细采集能力，不等同于 Workspace 重抓取。录制沿用 v4 的详细范围语义，并额外遵守源头 Secret 剔除、完整性证明和 Local/Remote 等价合同。

## Consequences

- 安全锁和 Workspace 导航可使用轻抓取快速恢复，不需要先枚举元素。
- 删除、新建和编辑只为用户已选择的 Workspace 读取必要元素，降低全 Pack 枚举成本和隐私面。
- Pack 改名、同名 Workspace 和不同 Pack 的相同显示名不会再改变分类或复用错误映射。
- 需要验证 Omnia 在目标版本中提供的 Section/父级 identity、分页和一致性能力；缺失时相关层级功能必须明确不可用。
- 快照缓存仍可存在，但从主产品流程降级为带新鲜度的观察和性能优化。

## Alternatives

### 所有功能统一执行全 Pack Sync

拒绝。安全锁等场景不需要元素正文或全关系图；全量读取扩大延迟、分页一致性、容量和隐私成本。

### 继续用名称和编号推断 Section

拒绝。显示名称可变且不唯一，已在 v4 产生可重复的错误分类。

### 仅在 mutation 最后一刻读取

拒绝。用户会基于陈旧目录确认错误计划。生成计划和提交前需要两次窄范围实时检查。

## Verification

- 相同名 `TEST` 位于不同 Section/Pack 时按权威 identity 分开，不共享分类；
- Section 改名后轻抓取展示新名称，operation/capability identity 不受显示名影响；
- 无父级 identity 时返回 `authority_hierarchy_unavailable`，不落入“其他”或任意默认分类；
- 轻抓取响应不包含 Workspace 下元素正文；
- 重抓取只能访问冻结 Pack/Workspace/type scope，分页、取消、限流、partial 和 progress 可恢复；
- Workspace 都有权威 `parentSectionId`，硬预算无法由用户或 Feature 提高；任一预算超限不会返回伪完整成功；
- 大 Pack 不执行默认全包无界 dump；
- Local/Remote 对同一 fixture 产生等价 Section/Workspace/coverage/digest；
- 删除计划和 mutation 前实时检查都能使陈旧目标/锁/关系/并发状态失败关闭；
- UI 能区分实时结果、历史 observation、partial 和 stale。
- principal/权限撤销或 Session 不可验证时，缓存业务名称不再展示。
