# 待处理项目：新建与关联默认文档准备

状态：Pending / Feature DoR Blocker  
登记日期：2026-07-30  
影响范围：仅阻塞第四个首批 Feature“新建与关联”的实现、真实 canary 和开放；不阻塞 Shell Baseline、录制、删除元素或删除聊天记录

2026-08-01 补充：用户将先继续整理现有 Phase 1 字段工作簿，随后由 Codex 基于该工作簿
设计模板母版。本轮只登记任务、不制作 Excel，执行清单见
[Phase 1 模板母版设计待办](PHASE1_TEMPLATE_MASTER_WORKBOOK_TODO.md)。

## 1. 当前事实

- v5 尚未准备好“新建与关联”可以正式使用的默认文档。
- 当前没有经过业务批准、版本化、验证并发布的 `TemplateVersion` 可供该 Feature 绑定。
- v4 的模板、参考工作簿或历史文件只能作为候选输入；在来源、许可、字段合同、默认规则、兼容性和真实验证完成前，不能直接复制为 v5 默认文档。
- 示例文件、mock、临时手工工作簿或 AI 生成文件不能替代正式默认文档，也不能用于宣称 Feature 可用。

## 2. 项目目标

为“新建与关联”的首个窄 canary 准备并发布唯一、真实、可审计的默认文档，使以下场景成立：

1. 用户资料全部采用合法默认值时，后台仍能创建 Run 专属不可变 `TemplateInstance`，`PatchSet=[]`；
2. 用户提供差异资料时，只修改合同允许的最小区域；
3. Generic Application、Generic Database、两个 GRA core 和唯一 DB → APP 关系所需的非默认业务字段能够被明确补充和验证；
4. 文档通过结构、业务、视觉、安全和兼容验证后，才允许形成 Omnia 计划；
5. 模板验证通过不替代 Omnia mutation 的实时预检和用户确认。
6. 经验证创建结果可以按已发布域 Schema 把 RAIT、Factors Considered、对象/GRA/关系身份和 provenance 写入 Agent Managed Content Registry，供 Phase 2 使用。

## 3. 必须准备的输入

| 输入 | 当前状态 | 提供/确认责任 |
|---|---|---|
| 候选默认文档或官方来源 | 未提供 | 用户/业务负责人 |
| 文件类型和业务用途 | 待确认 | 业务负责人 |
| 模板来源、版权和使用许可 | 待确认 | 业务负责人/法务或授权人 |
| Generic APP/DB 字段合同 | 待冻结 | 业务负责人 + Feature owner |
| 哪些字段可默认、哪些必须由用户提供 | 待冻结 | 业务负责人 |
| 保护区域、允许 Patch 的稳定 selector | 待冻结 | 模板维护人 + Feature owner |
| APP RAIT、Factors Considered、名称/唯一 ID规则 | 待冻结 | 业务负责人 |
| Managed Content 类型 Schema、Phase 2 必需字段和 provenance 映射 | 待冻结 | 业务负责人 + Feature/Phase 2 owner |
| 适用 Feature/Scenario/Omnia 版本 | 待验证 | Feature/Integration owner |
| 模板请求者、发布者和紧急撤销人 | 发布规则已定，具体版本待指定 | 用户本人发布，或 Codex 持单次、精确 TemplateVersion/digest 授权发布；用户保留撤销决定 |

在这些输入未到位前，只能继续做合同和治理设计，不能由开发人员猜测模板内容。

## 4. 项目产物

1. 一份不含客户数据、账号、Cookie、Key 或历史项目残留的候选默认文档；
2. 对应 `ScenarioVersion`，定义输入 Schema、字段语义、默认规则和选择规则；
3. 对应 `TemplateVersion`，包含原始字节、file/semantic digest、兼容范围和生效状态；
4. `defaultable / required / protected / patchable` 字段与区域清单；
5. 结构、业务、视觉和安全 Validator 及版本/digest；
6. 一组脱敏测试 fixture：
   - 全默认：`PatchSet=[]`；
   - 最小差异：只产生白名单 Patch；
   - 缺失必填：失败关闭；
   - 冲突/越界/结构损坏：失败关闭；
7. 来源、许可、owner、维护人、requestedBy、授权 publisher、authorizationRef、变更说明和撤销/回滚规则；
8. 签名、validation 与发布 Evidence，以及只供获批非生产环境使用的真实 canary 计划。
9. `ManagedObject/ManagedRelation` 类型 Schema 与模板字段、Omnia 读回字段、Phase 2 查询字段的映射。

## 5. 工作步骤

```text
取得候选来源
  → 清除客户/秘密/历史残留
  → 冻结字段与默认语义
  → 定义保护区域和 Patch selector
  → 生成 validator 与 fixture
  → 结构/业务/视觉/安全验证
  → 用户批准/授权发布
  → 发布不可变 TemplateVersion
  → 绑定 Feature/Scenario 兼容范围
  → 进入“新建与关联”真实 canary
```

已发布版本禁止原地修改。修改必须产生新版本；发现严重业务、安全或许可问题时标记 `Revoked`，新 Run 禁止使用，历史 Run 仍保留其冻结版本和 Evidence。

Codex 只有在持有用户针对具体 TemplateVersion/digest 签发的单次、防重放授权时才能执行发布，不得因其创建、修改或校验文件而自授权。首版不强制第二人审批。详见 [ADR-0029](../adr/0029-user-or-authorized-codex-template-publication.md)。

## 6. 明确非目标

- 本项目不授权开始“新建与关联”业务开发；
- 不一次准备完整 v4 Phase 1、Phase 2、Controls 或 EMS 模板；
- 不为 OS、Tool、SAP、Risk/Control、多 APP 或批外引用提前准备模板；
- 不让 AI 决定默认业务值、对象 ID、关系或保护区域；
- 不把模板主文件直接作为某个 Run 的可写输出；
- 不因默认文档完成而跳过 Omnia 实时预检、确认、幂等或读回。

## 7. 关闭条件

本项目只有同时满足以下条件才能标记 `Completed`：

- [ ] 候选默认文档由明确业务负责人提供或书面认可；
- [ ] 来源、许可、维护人、requestedBy、授权 publisher、authorizationRef 和撤销责任完整；
- [ ] `ScenarioVersion/TemplateVersion/validator` 均有不可变版本与 digest；
- [ ] 默认字段、必填字段、保护区域和 Patch 白名单无歧义；
- [ ] 全默认实例可验证生成，且 `PatchSet=[]`；
- [ ] 最小差异实例只修改白名单 target；
- [ ] 缺失、冲突、损坏、越界和不兼容测试全部失败关闭；
- [ ] 模板不含客户数据或 Secret，安全扫描通过；
- [ ] 与目标 Feature/Omnia 版本的兼容性经过真实验证；
- [ ] 用户批准/授权、签名、validation 和发布 Evidence 完整，并已发布唯一可选的 `TemplateVersion`；
- [ ] canary Workspace、测试对象、保留和清理 owner 已确定。
- [ ] RAIT、Factors Considered、对象/GRA/关系的 Managed Content Schema、provenance 和 Phase 2 查询合同已由双方 owner 批准。

任一条件未满足时，“新建与关联”必须保持 `DoR blocked`，菜单不得因存在临时文件而开放。
