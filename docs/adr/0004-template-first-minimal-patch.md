# ADR-0004：模板优先、Run 副本与最小 Patch

状态：Accepted  
日期：2026-07-30  
决策来源：v5 已收敛产品与架构约束

## Context

业务输出基于经审核模板。简单地“无输入就直接传模板”会丢失来源和验证，也可能把缺失误当默认；重新生成整份文档会无意改变公式、样式和受保护内容。历史 Run 还必须能证明使用了哪一版模板、哪些差异来自何处。

## Decision

- Scenario、TemplateVersion、TemplateInstance、PatchSet、Provenance 和 ValidationReport 是一等实体。
- 发布模板有 file digest、semantic digest、合同、兼容、可修改/保护区域和 validator；发布后不可原地修改。
- 每个规范化字段区分 explicit value、explicit default、contract default、missing、conflicting、not evaluable。
- `missing` 不能自动等于默认，只有 versioned Scenario 声明的 defaultable 字段可采用默认。
- 全默认也创建 Run 专属不可变 TemplateInstance、空 PatchSet、provenance 和全套验证。
- 有差异时只对白名单稳定 selector 应用最小 Patch；before digest 冲突失败。
- 输出必须通过结构、业务、占位/保护区域和必要视觉验证；失败不交付。
- 写 Omnia 仍需实时预检、独立确认和读回，不能从“模板已验证”推导授权。

semantic digest 的类型专用规范和视觉阈值未在本 ADR 决定，需基准和 fixture。

## Consequences

正面：

- 最大限度保持审核模板的结构和视觉；
- 全默认输出也可审计，不冒充 AI 成果；
- 差异、来源、规则和版本可重放/验证；
- 失败关闭，降低错误文档/写入风险。

成本：

- 每类文档需要稳定 selector、semantic digest 和 validator；
- 需要模板 owner、审批/发布流程和视觉 QA；
- TemplateInstance/Artifact/Provenance 增加存储和版本管理。

## Alternatives

| 方案 | 结论 |
|---|---|
| 无输入直接传模板主文件 | Rejected；无 Run 副本/provenance，可能误写主文件 |
| 缺失一律采用默认 | Rejected；制造未有证据的业务值 |
| 每次完全重建文档 | Rejected；易破坏公式/样式/结构 |
| AI 自由编辑模板 | Rejected；不可证明最小差异和保护区域 |

## Verification

- default/missing/conflict/not_evaluable 决策表测试；
- 全默认输出有 instance/provenance/validation；
- 属性测试证明 Patch 不触及 protected regions；
- file/semantic digest 与 before digest 冲突测试；
- 结构、业务、视觉验证失败时无 final Artifact/Omnia action；
- 历史 Run 可解析当时冻结的全部版本和 digest。

