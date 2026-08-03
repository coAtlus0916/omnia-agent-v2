# Feature 随包文档模板

状态：Required Template / Design Only  
用途：未来每个真实 Feature Package 的 `docs/` 文档集使用同一结构。本文是开发前模板，不代表任何 Feature 已安装或已实现。

## 1. 文档身份

| 字段 | 必填内容 |
|---|---|
| Feature ID | 与 `feature.json.featureId` 完全一致 |
| Feature version | 与包版本完全一致 |
| Documentation version | 必须等于 Feature version |
| Package manifest digest | 构建后填写并由安装器校验 |
| Documentation digest | 构建后填写并由安装器校验 |
| Default locale / locales | 实际包含且通过校验的语言 |
| Owner / reviewers | Feature、数据、安全、测试和文档责任人 |

不得填写客户正文、Secret、Cookie、Authorization、真实生产 ID、绝对生产路径或私钥位置。

## 2. `overview.md`

必须回答：

1. 用户问题、可验证成果和稳定 Feature 名称；
2. 已实现 capability 清单；
3. 范围与非目标；
4. 输入、输出和真实依赖；
5. 已知限制、禁用条件和未开放能力；
6. 二级或三级导航路径，以及对应真实 route/action；
7. 是否依赖 Template、AI、Connector；不依赖时写明原因。

不能用 `planned`、设计意图或未来路线冒充当前已安装能力。

## 3. `implementation-map.json` / `implementation-map.md`

每个 `capabilityId` 恰好填写四行：

| capabilityId | plane | responsibility | entrypoint | actionOrContractIds | dataOwner | effect | dependencies | testIds | status | reason |
|---|---|---|---|---|---|---|---|---|---|---|
| `<required>` | `delivery` | `<required>` | `<route/view/action or null>` | `<IDs>` | `<owner or null>` | `<effect>` | `<versioned IDs>` | `<test IDs>` | `implemented/not_applicable/deprecated` | `<required for not_applicable>` |
| `<same>` | `execution` | `<required>` | `<worker/step/validator or null>` | `<IDs>` | `<owner or null>` | `<effect>` | `<versioned IDs>` | `<test IDs>` | `implemented/not_applicable/deprecated` | `<required for not_applicable>` |
| `<same>` | `control_data` | `<required>` | `<service/repository or null>` | `<IDs>` | `<owner or null>` | `<effect>` | `<versioned IDs>` | `<test IDs>` | `implemented/not_applicable/deprecated` | `<required for not_applicable>` |
| `<same>` | `integration` | `<required>` | `<capability/operation or null>` | `<IDs>` | `<owner or null>` | `<effect>` | `<versioned IDs>` | `<test IDs>` | `implemented/not_applicable/deprecated` | `<required for not_applicable>` |

检查要求：

- UI action、schema、event、repository command、migration、Template binding、Connector capability/operation 和测试 ID 与包内容双向一致；
- 一个 Feature 有多个 capability 时逐个填写，不能用一份笼统架构图代替；
- `not_applicable` 只能用于确实不参与的 Plane，并写出可评审原因；
- 人类可读 Markdown 与机器 JSON 必须由同一来源生成或通过等价性校验。

## 4. `planes/delivery.md`

- 菜单、route、view/surface 和布局；
- 真实 action 与前置状态；
- 上传、状态订阅、刷新/重启恢复；
- loading/empty/disabled/denied/error/uncertain；
- 用户确认、结果交付和可访问性；
- 不在 Delivery 中进行的解析、AI、DB 和 Omnia 操作。

## 5. `planes/execution.md`

- Worker runtime/entry 与 Step 划分；
- 输入 Artifact 和输出合同；
- 算法、规则、Patch/Plan、Validator；
- AI capability 请求及失败关闭；
- CPU/内存/时间/并发限制；
- 取消、崩溃、重启和确定性；
- 禁止的跨 Feature、DB、Secret、网络和 Connector 访问。

## 6. `planes/control-data.md`

- Run/Step/Event/Lease 状态和恢复；
- Feature Registry 与健康；
- repository command、数据 owner 和 schema；
- 是否读取或产生 Agent Managed Content；entity/relation type、Schema、current/revision/change、freshness 和 provenance；
- Confirmation、Artifact、Evidence；
- Template/Provider/Transport 版本冻结；
- 幂等、并发、`uncertain` 和 reconcile；
- 审计、权限、保留、删除、备份和恢复。

## 7. `planes/integration.md`

- Connector capability/operation ID 和版本范围；
- effect 分类、目标身份和权限；
- preflight、commit point、写后读回/双边验证；
- Local/Remote 合同一致性；
- 超时、断线、partial/uncertain 与只读 reconcile；
- Operation Module 依赖和在线升级；
- 不需要 Integration 时的明确 `not_applicable` 原因。

## 8. `data-and-migrations.md`

- Core 索引与 Feature 私有数据的边界；
- schema version、migration 顺序、checksum 和 dry-run；
- candidate/active/previous 的数据可读条件；
- Artifact 类型、大小、provenance 和 retention；
- 删除传播、Evidence 例外、卸载后的 orphan 策略；
- create/update/delete 对 Managed Content current/revision/change/tombstone 的逐项影响；不适用时写明原因；
- backup/restore 和不可逆 migration 的处理。

## 9. `operations-and-recovery.md`

- 安装、启用、禁用和依赖检查；
- 健康与诊断信号；
- 升级、drain、probation 和 previous；
- Feature/Documentation 从同一 activation record 投影一致的 active/previous；staging/migration/进程步骤由安装 journal 恢复；
- Worker/UI/迁移/文档发布失败的隔离与恢复；
- 卸载和历史 Run 文档保留。

## 10. `testing-and-canary.md`

至少列出：

- unit/property/schema/contract；
- UI action 真实接线；
- 进程、权限和跨 Feature 隔离；
- migration/backup/upgrade/rollback；
- 文档 manifest、链接、digest、敏感信息、安全渲染和双向漂移；
- Local/Remote parity；
- 若有 Omnia effect，受控真实 canary、写后读回、partial/uncertain/reconcile；
- 若管理业务内容，验证 Managed Content 投影、revision、adopted baseline、tombstone、Phase 2 查询和 projection 恢复；
- 每项测试 ID、环境、owner、证据位置和通过条件。

## 11. `changelog.md`

每个版本分别记录：

- 用户可见能力变化；
- action/schema/data/migration/Template/AI/Connector 变化；
- 权限、安全与隐私变化；
- 文档变化；
- upgrade/rollback 影响；
- 已知限制和撤销信息。

文档修正也至少发布 Feature patch 版本并重新签名，不能原地编辑已安装版本。

## 12. 发布前自检

- [ ] 所有必备文件已进入 `documentation.json` allowlist。
- [ ] Feature、文档和 package manifest 版本/digest 一致。
- [ ] 每个 capability 恰好有四 Plane 记录。
- [ ] 实现映射和包内真实 ID 双向一致。
- [ ] symbol/contract catalog 可解析，permission/effect/data owner/migration/canary 可推导字段一致。
- [ ] 涉及 mutation、Secret、跨边界 Artifact、Managed Content、模板发布、Remote 更新或新增权限时，已附独立 architecture/security review Evidence；机器 ID 校验不替代语义审核。
- [ ] Markdown/HTML/URI/路径/符号链接和敏感信息负例通过。
- [ ] Documentation Registry candidate 安装和索引生成通过。
- [ ] 安装 journal 可恢复，代码与文档从单一 activation record 投影一致的 active/previous，升级和回滚通过。
- [ ] 历史 Run 可解析其冻结版本文档。
- [ ] 未安装或未实现能力没有出现在当前实现文档。
- [ ] Agent 管理内容的字段 Schema、变更语义和下游查询已记录；未验证计划值不会写入 current。

规范来源：[Feature Package 标准](../architecture/FEATURE_PACKAGE_STANDARD.md)、[公共合同](../contracts/CONTRACTS.md)、[ADR-0023](../adr/0023-feature-documentation-bundle.md)和 [Agent 管理内容登记簿](../data/AGENT_MANAGED_CONTENT_REGISTRY.md)。
