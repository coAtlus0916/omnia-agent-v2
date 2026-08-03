# Phase 1 模板母版：业务整理与 TemplateVersion 发布待办

状态：**母版制作完成；业务整理和首个 TemplateVersion 发布待继续**  
更新日期：2026-08-03  
最终工作簿：[omnia-agent-phase1-master-v4-based.xlsx](../../outputs/019fb190-b0b1-7fb2-94d1-f3f7cad4a853-sol-rebuild/omnia-agent-phase1-master-v4-based.xlsx)

## 1. 已完成

基于用户提供的 Phase 1 字段工作簿，Sol Agent 已生成一份独立的治理母版。原始下载文件未覆盖，母版不属于 Shell 原装 Feature，也不是运行时用户值数据库。

- 7 个工作表：使用说明、字段母版、Risk-Control 关系、v4 接口证据、规则与枚举、覆盖与质检、原始字段追溯；
- 183 个规范化字段；
- 68 条 Risk-Control 关系，包含 Higher/Lower 目录存在性和是否需要关联的区分；
- 21 条基于 v4 实际源码/接口的证据链；
- 原始工作簿 180/180 字段完成追溯（100%）；
- 公式错误 0；
- 运行时不使用旧的 user_value_or_source 自由列；用户运行时值仍来自上传资料和真实 Connector 读回。

母版的用途是维护标准字段、默认值、场景差异、JSON/API 映射、Risk/Control 关系、校验规则和证据状态；发布前由 Codex/工具编译为版本化运行时模板，不能把 Excel 排版直接当作运行时合同。

## 2. 现在需要用户整理/确认

1. 在字段母版中补齐标准默认值、必填/缺失规则和业务说明；不确定内容写“待确认”或“待验证”，不要猜测。
2. 确认 APP/DB/OS/Tool、GRA、Risk、Control 等字段的场景归属，以及 Higher/Lower 适用差异。
3. 在 Risk-Control 关系表确认 `link_required_higher`、`link_required_lower`；录制抓取完整目录，用户不需要手工重复关联所有 Higher/Lower Control。
4. 确认默认文档、命名、RAIT、Factors Considered、保护区域和允许的模板继承规则。
5. 确认第一个可发布的场景（建议先 Generic APP/DB 的最小切片），并给它分配唯一 `template_version`。

## 3. Codex 后续工作

1. 根据用户整理结果编译母版为版本化 JSON/数据库 TemplateVersion；保留来源、校验和 provenance。
2. 对缺失的 JSON Pointer、request/response/readback、Operation 和真实 v4/当前 Omnia 证据标记 `candidate`/`verified`，不将猜测写成已验证。
3. 为首个 TemplateVersion 生成结构校验、场景继承/override、Higher/Lower 过滤和最小 Patch 测试。
4. 将模板版本纳入新建与关联 Feature 的前台、中台、后台和 Connector Operation 合同；安装 Feature 时同步投影文档。
5. 在授权 Pack 上执行一次只读预检和真实写入 canary；未通过前，新建与关联保持未交付/禁用。

## 4. 设计约束

- 一份母版按数据职责拆 Sheet；APP/DB/OS/Tool、Higher/Lower 等差异用稳定 `scenario_id` 和 override 表达，不复制成大量相互漂移的文件。
- 每个场景、字段、Risk、Control、关系和映射都要有稳定 ID；默认值、缺失、继承和 override 由程序确定性计算。
- `catalog_present_*` 表示 Omnia 目录是否存在；`link_required_*` 表示 Agent 是否应该建立关联，不能由目录存在自动推断。
- 用户上传的资料属于运行时输入；母版只提供标准字段、默认文档和转换规则。极端默认场景可直接使用已发布模板，一般场景只生成必要 Patch。
- Phase 2 只能从后台版本化 Managed Content 查询已读回验证的 current/revision/relation/tombstone，不读取 Feature 私有数据库猜测结果。
- 模板由用户或 Codex 发布；每次发布提升 `TemplateVersion` 和变更记录，旧版本不可变。

## 5. 完成标准

- 用户整理后的母版通过数据验证、枚举、ID 唯一性、场景继承和编译检查；原始工作簿保持不变。
- 至少一个 APP Higher/Lower 场景和一个 Risk-Control 关系可编译为确定性运行时模板。
- 新建与关联 Feature 能在四 Plane 使用同一 TemplateVersion；失败、uncertain、readback、reconcile 和 Managed Content revision 有真实测试。
- 真实 Omnia canary 通过后才将状态从“待 canary”改为“已实测/已交付”。
