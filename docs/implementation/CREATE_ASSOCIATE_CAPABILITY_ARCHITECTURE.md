# 新建与关联：能力架构与新增类型门禁

## 1. 文档状态

本文定义新建与关联 Feature 的强制目标架构和新增元素类型的开发门禁。它不代表当前源码已经完成迁移，也不代表 DCNO、SAP S/4 HANA 或其他新增类型已经通过真实 Omnia canary。

交付状态必须分别记录：

- 源码迁移完成；
- 定向检查通过；
- 候选 Feature/Operation 包生成；
- 已安装冒烟；
- 目标 Pack 的真实创建、关联、评分、设置、Risk-Control 与写后读回 canary 通过。

前四项不能代替最后一项。任何缺失的 live contract 或 canary 必须标为“未实机验证/待 canary”。

## 2. 核心原则：能力唯一，元素参数化

运行时不得为 APP、DB、OS、TOOL、DCNO 分别复制一套 engine，也不得为 SAP ECC、SAP S/4 HANA、Generic 等产品类型复制评分、关联或回传流程。

每种能力只能有一个实现，例如：

- `parse_element`：统一解析元素行并生成规范对象；
- `validate_element`：统一执行必填、枚举、命名、重复和行身份校验；
- `resolve_identity`：统一解析活动对象、回收站对象和 Workspace 身份；
- `build_object_plan`：统一生成元素创建计划；
- `build_settings_plan`：统一生成设置计划；
- `build_relation_plan`：统一生成元素与 APP 等目标的关系计划；
- `derive_rait`：统一计算直接 RAIT 或从关联 APP 继承的 RAIT；
- `build_gra_plan`：统一生成 GRA 计划；
- `build_app_scoring_plan`：统一生成 APP 通用评分计划；
- `build_risk_control_plan`：统一根据受管内容族生成 Risk-Control 关系；
- `build_evaluation_plan`：统一生成提交、完成和读回计划。

函数名可以与上例不同，但一个能力存在多个按元素类型分叉的实现即违反本规范。合法差异必须来自注册表参数、能力标志和受管母版内容，而不是复制函数、复制 DAG 或按产品名称硬编码。

## 3. 签名 kind/capability registry

Feature 包必须提供受签名保护的 `kind/capability registry`，作为元素差异的唯一运行时来源。用户上传文件只能引用已登记的稳定 ID，不能提供 URL、HTTP method、Operation 名称、代码、脚本或任意请求参数。

每个 kind 至少声明：

| 字段 | 含义 |
|---|---|
| `kindId` | 稳定元素类型 ID，例如 APP、DB、OS、TOOL、DCNO |
| `objectFamily` / `contentFamilyId` | Omnia 对象族和受管内容族 |
| `contentAlias` | 模板可接受、但会被规范化的受控别名 |
| `capabilities` | 创建、设置、关系、直接/继承 RAIT、APP 评分、Risk-Control、Evaluation 等能力标志 |
| `dependencies` | 运行阶段依赖，例如 DB/OS/DCNO 关系依赖 APP 身份完成 |
| `stageNodes` | 对统一 DAG 的节点选择，不是新的 DAG 实现 |
| `relationPolicy` | 允许的关系族、基数、是否必需和目标 kind |
| `operationBinding` | 仅引用签名包中固定 allowlist 的 Operation binding |
| `returnSupport` | `supported`、`unsupported` 或 `pending_live_contract` |

注册表、Python 默认定义、Worker schema、Operation alias map 不得各自维护相同的类型事实。构建时应从一个受管来源编译出各层需要的只读投影；发现多处手工清单不一致时不得继续发布。

## 4. 四层职责与唯一数据流

### 4.1 Python：解析、确定性校验、计划 IR

Python 负责：

1. 解析受支持的母版格式；
2. 规范化 row identity、kind、别名、枚举和关系引用；
3. 执行确定性业务校验；
4. 根据签名 registry 和受管母版生成冻结、可审计的计划 IR；
5. 输出错误、警告、来源位置和依赖，不直接操作 Omnia。

计划 IR 应描述“做什么”，而不是携带任意网络请求。至少包含规范元素、能力 ID、依赖、阶段节点、目标身份引用、受管内容引用、幂等材料和来源证据。

### 4.2 Feature Worker：状态机与调度

Worker 负责：

1. 持久化 Run 和阶段状态；
2. 执行一个通用依赖 DAG；
3. 按能力 handler 调度 IR；
4. 维护并发、重试、暂停、失败跳过和失败关闭策略；
5. 将同一后台状态投影到前端进度；
6. 收集 Operation 结果、读回结果和 Evidence。

Worker 不得再次解析 Excel，不得复制 Python 的确定性规则，不得按产品名称维护第二套计划器，也不得为不同 kind 复制整套回传 DAG。

### 4.3 Operation：签名受限 API

Operation 负责：

1. 将受控 binding 与参数转换为固定 Omnia 请求；
2. 校验对象类型、subtype、content、relation 和字段 allowlist；
3. 执行预检、幂等、写入、写后读回、`uncertain` 和 `reconcile`；
4. 返回结构化结果与可审计证据。

Operation 不接受用户提供的 URL、method 或代码，不包含 Excel 解析和产品类型业务分支。没有精确的真实请求/响应/读回合同就不增加 binding。

### 4.4 Connector：只传输

Connector Core 只负责 Transport、Session、Gate 和签名 Operation host。新增元素类型、评分规则、Risk-Control family 或模板内容不得要求修改 Connector Core；若 Feature/Operation 可以热更新，就只更新对应包。

## 5. APP 通用评分与 Risk-Control 的边界

“15 项评分”与“24 条 Risk-Control 关系”不是同一数据集，数量也不要求相等：

- APP 通用评分是 GRA 内的评分维度。所有启用 APP 评分能力的产品类型调用同一个评分模块；15 项治理身份、题目语义以及 Higher/Lower 取值策略均为 APP 通用规则，产品类型不参与评分映射。
- Risk-Control 是 Risk、Control 及其关系的受管内容。产品类型选择对应 `RiskControlFamily`，由统一关系模块创建或关联。
- 产品类型只允许影响 GRA content 选择、Risk-Control family 选择以及受管输入值；不得据此复制 scoring engine、Risk-Control engine 或回传 DAG。
- 如果当前 APP GRA 的真实评分目录缺项、重复、题目语义漂移或允许值范围不可确认，系统必须明确阻断评分步骤；不能把 Risk-Control 条数当作评分项，也不能按产品类型维护或回退到另一套评分规则。

## 6. 推荐的能力参数

以下仅表达架构关系，不代表各类型已完成 live canary：

| Kind | 对象族 | RAIT | 关系 | APP 通用评分 | Risk-Control | 当前门禁说明 |
|---|---|---|---|---|---|---|
| APP | Application | 直接设置 | 可作为其他元素目标 | 是 | 按产品内容族 | 产品类型只选择内容，不复制引擎 |
| DB | Infrastructure/Database | 从关联 APP 继承 | DB → APP | 否 | 按登记能力 | 多 APP 中存在 Higher 时继承 Higher |
| OS | Infrastructure/OperatingSystem | 从关联 APP 继承 | OS → APP | 否 | 按登记能力 | 多 APP 中存在 Higher 时继承 Higher |
| TOOL | ITTool | 按登记能力 | TOOL → APP | 否 | 按登记能力 | 必须使用真实 Operation binding |
| DCNO | Infrastructure/Network | 从关联 APP 继承 | DCNO → APP，至少一个 | 否 | 按登记能力 | 没有真实 Network live contract 时必须 fail-close |

该表是参数模型，不是上线声明。每一行仍需支持矩阵和真实 canary 证明。

## 7. 确定性复核与 AI 复核

`source_files/phase_1_14_复核.py` 只能作为人工审阅参考，禁止：

- 在 Feature Python 中 `import`；
- 通过子进程执行；
- 复制到 Feature/Operation 包；
- 把它作为运行时依赖或安装前提。

其中经确认的确定性规则应逐条改写为 Feature 固有、可版本化的 Python rule，并输出稳定 rule ID、严重级别、行定位和修复提示。例如名称占位符、测试/临时命名、必填、枚举、重复、关系完整性都属于确定性规则。

只有无法由确定性规则判断的 Factors Considered 语义复核可以调用现有统一 AI Provider。AI 输出必须是可追踪的复核结果，不得决定 Operation allowlist，不得绕过阻断规则，也不得新增第二套 Provider 接线。

## 8. 新增或修改元素类型的标准步骤

1. **审计同类实现**：限定范围阅读当前 v5 真实调用链和 v4 精确证据，形成 `v4 symbol/evidence → v5 capability → 采用/重写/拒绝` 矩阵。
2. **冻结支持矩阵**：列出解析、校验、计划、Operation、读回、便携冒烟、真实 canary 与入口状态。
3. **确认 live contract**：记录精确对象族、subtype/content、关系类型、请求、响应、写后读回和失败边界。没有证据则标记 `pending_live_contract`。
4. **只改单一注册点**：优先增加 registry 参数和受管母版内容；若必须增加新能力，只增加一个通用能力函数和对应 handler。
5. **编译并校验投影**：确认 Python、Worker 和 Operation 消费同一 registry 投影，不存在重复枚举或分叉 DAG。
6. **定向静态检查**：检查 schema、IR、allowlist、依赖顺序、失败关闭和来源追踪；不得用 mock 成功代替真实状态。
7. **真实 canary**：在授权 Pack 中使用真实文件完成创建、关联、设置、评分/Risk-Control（如适用）、提交和写后读回，并保存真实证据。
8. **入口门禁**：只有真实后端闭环存在时才启用；未完成就隐藏、禁用或明确显示不可用原因。

## 9. 验收门禁

### 9.1 架构门禁

- 一个能力只有一个 Python function/Worker handler/Operation binding 家族；
- 不存在按 kind 或产品名复制的 engine、DAG 或状态机；
- 注册表是类型差异的唯一来源，构建投影一致；
- Python、Worker、Operation、Connector 职责无越界；
- 参考脚本不在依赖图和包成员中。

### 9.2 数据门禁

- 任意行数均按稳定 row identity 处理，不以固定 8 行、特定行号或短样本为边界；
- APP scoring 与 Risk-Control 分开计数、分开校验、分开生成计划；
- 关系目标、RAIT 继承和受管内容引用可追踪到输入与版本；
- 缺内容、缺映射、缺 live contract 时明确阻断，不做静默 fallback。

### 9.3 运行门禁

- 前端按钮与进度来自真实 Run 状态；
- Operation 具备预检、确认、幂等、写后读回和不确定状态处理；
- Remote 离线或会话失效时失败关闭，不改用 Local 假完成；
- canary 覆盖同名冲突、部分失败继续策略、关系写入和最终 Pack 可见性；
- 未执行真实 canary 时不得写“已上线”“已完成”或“稳定可用”。

## 10. 快速开发方法

在不牺牲稳定性的前提下，最快路径是：

1. 先审计同类 v4 证据和当前 v5 调用链，限时确认协议，不做全仓复制；
2. 把类型差异集中到一个签名 registry，把母版差异集中到受管内容；
3. 一次生成通用 IR、一次执行通用 DAG，删除重复计划器和重复 handler；
4. 开发内环只做与纵切相称的静态/定向检查；
5. 源码闭合后再生成一次候选并做真实 canary；
6. Feature/Operation 变更走现有热更新，不重打 Shell，不修改 Connector Core；
7. 每轮记录复用边界、删除的重复链路、剩余 live contract 缺口和 canary 结论。

## 11. 当前迁移说明

0.2.73 / sequence 75 源码候选已经把 APP/DB/OS/TOOL/DCNO 的能力、阶段、派生和关系基数收敛到签名 `kindRegistry`；Python 已负责解析、修订后确定性校验和纯 `capability-plan-ir/v1` 编译，Worker 只增加真实 Remote 身份/预检事实并调度统一 DAG。APP Generic、SAP ECC、SAP S/4 HANA 共用一个 APP scoring 实现，只按受管内容选择 GRA/Risk-Control family。Element ID 与派生 GRA 名称使用同一批次命名空间；DB/OS 的多 APP 继承和 Tool 的单 APP 关系均来自注册表。候选保持 Shell 0.4.14 已发布 `pythonSidecar` schema，不声明未知 `capabilities` 字段；RPC 能力仍由 bridge/engine hello 自检。

当前静态/语法检查不等于可用性声明。受管下载模板、候选包自检、安装冒烟和真实 Pack canary 必须分别记录；其中任何一项未完成，都不能写“已上线”或“稳定可用”。DCNO 仍缺少官方 Network object/GRA/relation/Risk-Control mutation/read-back 合同，因此只开放解析、本地校验和 IR，并在 Operation query/intent 之前 fail-close；不得复用 OS 路径。

在对应源码变更、定向检查、候选生成和真实 Pack canary 全部完成前，新能力仍属于开发中或待验证状态。
