# SAP ECC 创建录制与 Phase 1 母版审计

## 1. 结论

最新文件 `omnia-operation-recording-cfd09224-dfc2-4d20-ad4e-8cf77216e999.json` 必须明确按 **v4 recorder evidence** 使用。它不是 v5 Recorder 或 v5 Feature canary，但相比此前两份录制，已经补齐了 SAP ECC GRA 的大部分字段级证据。

本次能够确认：

- Application / SAP ECC 的“IT风险评估（如果测试运行有效性）”真实字段与开关 API；
- 用户从“+文件记录”进入“在此记录”后，实际写入的是 GRA 主 `documentation` 富文本对象，不是文件附件上传；
- 15 个 SAP ECC 评分项的运行时身份和允许分值，其中 14 个适用项完成 Higher 最高分写入与读回，1 个“数据转换”项在本次场景不适用；
- Higher 评价最终提交到 `EvaluationComplete`；
- 母版 18 条 SAP ECC Risk-Control 关系全部可以与运行时 Risk/Control 身份及 Higher 既有关联读回逐条匹配。

仍未确认：

- 最新 SAP ECC 录制本身没有出现 Risk-Control 的校验与关联写请求；但 v4 `gra-creator` 源码和既有 handoff 已提供可复用的 `validateHiddenDataForRiskAssociation` + `controlrisks/associate` 写入合同；
- 最新录制没有单独执行 Lower 场景；产品决策（2026-08-03）是不再要求 Lower 单独录制或 canary，而是复用同一评分、结论、提交和关联合同；
- Database、Operating System、IT Tool 的其他 GRA、RAIT 继承和关系合同；它们不使用本节的 Application 评分体系或 `/documentation` 文字记录。

产品范围已经明确：只有 Phase 1 Application 的“+文件记录”用于进入“在此记录”并填写文字；DB、OS、Tool 不需要此字段。所有类型都不需要也不允许创建、上传或绑定真实附件，附件 API 不再是待补录项目。

因此，V8 可以作为 SAP ECC GRA 字段、Higher 读写证据和 Lower 参数化规则的开发母版。完整“新建与关联”Feature 仍须完成 v5 Operation、真实写后读回和整体 canary，但不得再以“Lower 没有单独录制”为执行阻断理由。

## 2. 输入与产物

输入录制：

- 创建链主录制：`omnia-operation-recording-dfa8eb76-904f-414d-bea5-0a4ed5ac934a.json`
- 无网络证据补录：`omnia-operation-recording-f312280e-282e-4f6e-814b-f3c08114d11d.json`
- 最新 v4 recorder evidence：`omnia-operation-recording-cfd09224-dfc2-4d20-ad4e-8cf77216e999.json`

母版版本：

- V7：保留此前创建链与缺口审计，不覆盖；
- V8：`phase1_系统信息填写V8_SAP_ECC_v4录制证据补充.xlsx`，从 V7 增量另存。

本审计不修改录制器或其他代码。

## 3. 证据等级

| 等级 | 含义 | 使用边界 |
|---|---|---|
| 当前录制已证实 | 当前录制中存在请求、响应和业务读回 | 可进入母版 API 证据；发布执行仍需签名 Operation 与实际 canary |
| 身份/既有关联读回已证实 | 能稳定读取 Risk、Control 及现有关系 | 可用于匹配和预览；没有写请求时不得执行新增关联 |
| 用户规则已确认 / API 待验证 | 业务规则已确定，但当前类型或场景没有写入证据 | 可以治理模板，运行时必须 fail closed |
| 未识别 | 没有可靠规则或接口证据 | 不进入可执行计划 |

## 4. 最新 v4 录制完整性

`cfd09224` 的 recorder metadata 与事件实际情况一致：

- 总事件：1032；
- dropped events：0；
- response body：143 / 143；
- critical endpoints：29 / 29；
- critical 分类：risk-list 3 / 3、control-list 3 / 3、planned-response-list 23 / 23；
- instrumentation errors：0；
- event types：48 interaction、264 request、264 response、264 complete、146 response-body；
- 录制开始：2026-08-03T07:58:58.273Z；停止：2026-08-03T08:01:22.348Z；最后网络完成事件：2026-08-03T08:01:14.650Z。

本文件足以审计实际出现的 API，但“完整性通过”不表示没有执行的业务动作也被证实。例如录制中完全没有 Risk-Control 关联写请求，所以该能力仍然缺证据。

安全扫描方面，正文未发现 `access_token` 赋值或 Bearer 值，但仍包含邮箱类人员信息。本审计与工作簿没有复制邮箱、token 或对象实例 ID；原始录制仍应按敏感 Artifact 管理。

## 5. 创建链既有证据

此前 `dfa8eb76` 已证实：

| 动作 | 证据 | method + endpoint | 主要字段 |
|---|---|---|---|
| 识别 SAP ECC 内容类型 | request-25 / seq83 | `GET /rapr/v0/engagements/{engagementId}/itelement/getITElementCategoryPublicationList` | `key=66176475`、`name=StandardizedAccount_SAP ECC` |
| 创建 IT Element | request-29 / seq134 | `POST /rapr/v0/engagements/{engagementId}/itelement` | request：`name`、`workspaceId`、`description`、`number`、`itElementType`；response：`id`、`workItemId` |
| 设置为相关 | request-132 / seq521 | `PATCH /rapr/v0/engagements/{engagementId}/itelement/{id}` | `/isRelevant=true` 及并发字段 |
| 创建 SAP ECC GRA | request-135 / seq531 | `POST /rapr/v0/engagements/{engagementId}/riskassessments/create` | `inkContentId=66176475`、`typeId=3`、`facetId`、`entityId`、`name` |
| 回读 GRA 身份 | request-142 / seq563、request-146 / seq579 | `GET /rapr/v0/engagements/{engagementId}/riskassessments/{id}` | `inkContentId`、`riskScopes.commonAccountName`、`workItemId`、`referenceNumber` |

该录制在 GRA 弹窗后发生 instrumentation 中断，因此后续评价证据以最新的 `cfd09224` 为准。

## 6. IT 风险评估默认开启

最新录制准确识别出：

- Endpoint：`PATCH /rapr/v0/engagements/{engagementId}/risk-factor-categories/{id}`；
- Request：JSON Patch `/applicable=true`，并包含 concurrency `test`；
- Response：category name 为“IT风险评估（如果测试运行有效性）”，`applicable=true`；
- GET read-back：同路径返回 `applicable=true`；
- 关键事件：request-137 / seq488 PATCH，request-138 / seq492 GET，均为 HTTP 200。

request-134 曾把该 category 设为不适用并清理数据，随后 request-137 重新开启；最终读回状态为 `true`。V8 因此把 `P1.APP.GRA.ENABLE_IT_RISK_ASSESSMENT` 升级为“Application / SAP ECC 已证实”。

产品规则（2026-08-03）已进一步收窄：该 IT 风险因素评分开关只适用于 Application。DB、OS、Tool 不开启此评分分类、不生成评分项，也不调用 `/riskLevel`；这不是待验证能力，而是明确的不适用项。

## 7. risk consideration：只填写“在此记录”文字

录制中的真实语义是：用户从“+文件记录”进入“在此记录”，在富文本编辑器中填写内容，然后保存到 GRA 主文档。

已确认 API：

- Rich Text Editor interaction：seq525–531；
- Endpoint：`PATCH /rapr/v0/engagements/{engagementId}/riskassessments/{id}`；
- Request JSON Patch path：`/documentation`；
- `value.documentation`：RTE JSON，包含 `editorData` / `plainText`；
- `value.workItems=[]`；
- Response：`documentation.documentation` 原样读回；
- 后续 request-179、request-211、request-213/214 中仍保留同一文档；
- 关键写入：request-146 / seq533，HTTP 200。

V8 保留稳定 field ID 以避免破坏既有字段引用：`P1.APP.GRA.RISK_CONSIDERATION_FILE_RECORD` 是可执行的 Application 文字字段；DB、OS、Tool 的同类历史 ID 标记为 `Higher=N / Lower=N / 不适用`。Application 显示名称为“+文件记录｜在此记录（GRA 主文档文字）”；“+文件记录”只是 Omnia 的界面入口，不代表文件 Artifact。

运行规则：

- 值只来自当前元素对应上传资料的 risk consideration；
- 不允许 AI 自由补写；
- 缺失、冲突或 `not_evaluable` 时阻断；
- 写入后精确读回；
- 不得与 `factorsConsidered` 自动混同；
- Feature 不设计真实附件分支；不得创建、上传或绑定附件，也不得用附件 API 替代 `/documentation`。

该文字记录只适用于 Application。DB、OS、Tool 不需要 risk consideration、“在此记录”或 GRA `/documentation` 写入；它们的执行计划必须直接省略这些字段和 Operation。旧稳定字段 ID 可以为兼容历史引用而保留，但必须标记 `不适用`，不能显示成输入项。

## 8. 评分项与 Higher / Lower 规则

### 8.1 元数据

request-180 / seq677 的 `GET /rapr/v0/engagements/{engagementId}/risk-factors/byRiskAssessmentId/{id}` 返回 15 个评分项。每项均具有运行时 `id`、`inkContentId`、`description`、`displayOrder` 和 `riskLevelSpectrum`；本次允许值均为 `1|2|3|4`。

| displayOrder | 评分项 | 本次 applicable | Higher 写入证据 |
|---:|---|---|---|
| 2 | 对业务和财务报告影响的广泛性 | true | request-164 / seq584 |
| 3 | 源数据（数量和复杂度） | true | request-165 / seq585 |
| 4 | 自动化控制（控制数量和复杂度） | true | request-166 / seq586 |
| 5 | 自动化报告逻辑（简单或复杂的内部信息或 IUC） | true | request-167 / seq587 |
| 6 | 高度自动的无纸化处理 | true | request-168 / seq588 |
| 7 | 数据输入和接口 | true | request-169 / seq589 |
| 8 | 财务报告相关自动化的历史错误 | true | request-170 / seq590 |
| 9 | 技术平台或体系结构 | true | request-171 / seq591 |
| 10 | 终端用户访问 | true | request-172 / seq592 |
| 11 | 应用类型 | true | request-173 / seq593 |
| 12 | 变更的数量和性质 | true | request-174 / seq594 |
| 13 | 数据转换（如果适用，次要或主要） | false | 无写入；不得强制评分 |
| 14 | 系统任务的使用 | true | request-175 / seq595 |
| 15 | 安全的复杂度 | true | request-176 / seq596 |
| 16 | 第三方托管 / 资源外包 | true | request-177 / seq597 |

### 8.2 Higher

14 个适用项均通过：

- Endpoint：`PATCH /rapr/v0/engagements/{engagementId}/risk-factors/{id}`；
- JSON Patch path：`/riskLevel`；
- 本次 value：`name=风险较高`、`value=4`；
- 每次 response：`riskLevel.value=4`；
- 每项 `riskLevelSpectrum[].value`：`1|2|3|4`；
- request-178 / seq628 单项 GET 及 request-180 / seq677 列表再次读回 4。

所以当前 SAP ECC Pack 中，Higher 的动态最高分确实为 4。但实现必须在运行时计算 `max(riskLevelSpectrum[].value)`，不能把 4 推广为所有 Pack 的常量，也不能固化当前 GRA 的对象实例 ID。

### 8.3 Lower

本次 15 项的 allowed range 均包含 1，因此“Lower 填 1”的业务规则与当前元数据兼容。产品决策（2026-08-03）明确：Lower 不再单独录制或做独立 canary，直接作为与 Higher 共用写入合同的参数分支：

- 仅对运行时 `applicable=true` 的项目写入；
- 从每个项目的运行时 `riskLevelSpectrum[]` 中选择 `value=1`，继续使用 `PATCH .../risk-factors/{id}` 的 `/riskLevel` 路径；
- 将评估结论写为 `itElementRaitConclusionLevelId=Lower` 并立即读回；
- 复用相同的 `submit-riskfactor-evaluation` 合同并等待 `EvaluationComplete`；
- Risk-Control 只使用 `link_required_lower=Y` 的 17 条关系，`SAP.03` 不进入 Lower 计划；
- 1 不可用或范围不可读时阻断；
- 不保存录制中的对象实例 ID，仍按运行时身份、并发版本和写后读回验收。

这里的状态是“产品批准复用”，不是“Lower 已被录制证明”。两者必须在证据字段中分开表达。

## 9. Higher 提交闭环

提交评价已形成闭环：

- request-211 / seq806：`POST /rapr/v0/engagements/{engagementId}/riskassessments/{id}/submit-riskfactor-evaluation`；
- Payload：`riskLevelOverride=null`、`isPurgeControlHiddenData=false`、`updateQM=false`、`accountContents=[]`；
- Submit response：`EvaluationProcessing`，结论为 Higher；
- request-213/214：继续读回 `EvaluationProcessing`；
- request-227 / seq858：最终 GET 返回 `EvaluationComplete`，`itElementRaitConclusionLevelId=Higher`，`lastSubmittedITElementRaitConclusionLevelId=Higher`。

这证明 Higher 评分与提交完成，不证明 Risk-Control 关联是在本次录制中写入的。

## 10. Risk-Control 18 条逐条匹配

母版 Higher/Lower 规则保持不变：Higher 18 条、Lower 17 条，`REL.APP.SAP_ECC.RAITCOR001.SAP_03` 仅 Higher。

最新录制提供：

- request-229 / seq875：`GET .../risks/byriskassessmentid`，返回运行时 Risk `id`、`inkRiskNumber/riskNumber`、`description`、`riskRiskScopes`；
- request-230 / seq881：`GET .../controls/byRiskAssessmentId/{id}`，返回 Control `id`、`controlNumber`、`name/description`、`controlRiskScopes`；
- per-risk planned detail：`GET .../plannedresponse/GetPlanResponseDetailByRiskRiskScopeId`，返回 `planResponseRisk[0].riskNumber` 以及 selected/control 的 `controlNumber`、`enabled`、`currentRiskScopes[].riskId/riskScopeId/assertionType/assertions`。

逐组匹配结果：

| Risk | 母版 Control | 录制 detail | 结果 |
|---|---|---|---|
| RAITCOR001 | SAP.01、02、03、06、07、11、17、18、19 | request-233 / seq893 | 9 / 9；Higher 既有关联 `enabled=true` |
| RAITCOR003 | SAP.05、09 | request-235 / seq904 | 2 / 2；Higher 既有关联 `enabled=true` |
| RAITCOR004 | SAP.10、13、23、26 | request-239 / seq922 | 4 / 4；Higher 既有关联 `enabled=true` |
| RAITCOR011 | SAP.15、16、27 | request-254 / seq985；request-262 / seq1021 | 3 / 3；Higher 既有关联 `enabled=true` |

总计：18 / 18 母版关系都能通过规范编号和运行时身份字段精确定位。母版没有采用描述文本模糊匹配，也没有保存当前对象实例 ID。

关键边界：整个录制的业务 mutation 中没有 control-risk `associate` 或 `validate` 请求。因此：

- Risk 和 Control 身份已解除未知状态；
- Higher 已存在关系的读回已确认；
- 新建关联实现复用 v4 已验证的 `validateHiddenDataForRiskAssociation` + `controlrisks/associate` 合同，运行时动态填入 `riskScopeId`、`controlId`、`assertionType` 和 `assertion`；
- Lower 不要求单独录制，目标集合直接取母版 17 条；执行时仍要幂等跳过既有关联并逐条读回；
- 不能把“读取到现有关系”写成“本次录制完成了关系创建”。

## 11. V8 母版变更

- 保留 V7，不覆盖；
- Application / SAP ECC IT 风险评估字段升级为当前 v4 录制已证实；
- risk consideration 字段准确描述为 GRA 主文档“在此记录”文字，并明确真实附件完全不属于本功能；
- Application / SAP ECC RAIT 结论补入 Higher submit 与 `EvaluationComplete` 证据；
- SAP ECC Risk 与 18 个 Control 字段补入身份、目录和 planned-response 读回 API；
- 18 条 Risk-Control 关系补入逐条证据，并记录“身份与 Higher 既有关联读回已证实 / v4 写入合同可复用 / Lower 无需单独验证”；
- “评分项与规则”新增 15 行真实评分项元数据及 14 个 Higher 写入事件；
- “评分项与规则”将 Lower 固化为同合同参数分支：适用项写 1、结论写 Lower、关系集合取 17 条；
- “SAP ECC录制证据”新增最新 v4 录制完整性、开关、主文档、评分、提交、关系读回和安全扫描记录；
- 所有运行时对象 ID 均只描述字段位置，不保存实例值。

## 12. 录制器历史缺陷与当前安全边界

`dfa8eb76` 在 GRA popup 打开后出现 instrumentation error，并存在约四分钟静默尾部，却被标记为 `integrity.complete=true`。`f312280e` 只有 23 个 popup/error 事件，0 network、0 mutation，不能提供 API 证据。

最新 `cfd09224` 已解决本次完整性采集问题，29 个关键读取全部捕获。但安全边界仍需保留：

- 早期录制的响应 URI 曾含 `access_token`；
- 最新录制没有 token/Bearer，但仍包含邮箱类 PII；
- `security.credentialsRecorded=false` 不能等价为“没有敏感或人员信息”；
- 原始录制不能进入源码库、Feature 包或普通开发附件；
- 母版与审计文档只能保留脱敏后的 endpoint、字段路径和事件编号。

本任务不修改录制器代码。

## 13. 校验标准

V8 必须满足：

- V7 文件保持不变；
- 9 个工作表可正常导入和渲染；
- 公式扫描无 `#REF!`、`#DIV/0!`、`#VALUE!`、`#NAME?`、`#N/A`；
- 187 个 field ID 唯一；
- SAP ECC 18 条 Higher/Lower 规则与 V7 逐条一致；
- 评分明细 15 行，其中 14 行 Higher 写入已证实、1 行本次不适用；
- 工作簿不包含邮箱、token/authorization 赋值或对象实例 UUID；
- 关键范围和全部 9 个工作表完成可视化检查。

该校验只证明母版和录制证据正确，不等于完整“新建与关联”Feature 已通过真实 Omnia 写入 canary。

## 14. 仍需完成

1. 在 v5 新建与关联 Operation 中迁移 v4 关联写入合同，并以真实运行时 ID、幂等预检和写后读回实现；不再为 Lower 单独录制；
2. 编译测试必须证明 Higher 生成 18 条、Lower 生成 17 条，且 `SAP.03` 只进入 Higher；
3. 编译测试必须证明评分、`/riskLevel` 和 risk consideration `/documentation` 只为 Application 生成，DB、OS、Tool 均省略；
4. 实现与测试必须证明 Application 的 risk consideration 经 `/documentation` 写入并读回，且不会调用附件创建、上传或绑定 API；
5. 完成签名 Operation 与一次整体真实 Omnia canary 后，再把“新建与关联”Feature 标记为已实测/已交付；该 canary 不要求为 Lower 再做一套重复验证。
# Package projection

The audited workbook digest and semantic inventory are compiled into `backend/governance.json`; the original audited bytes are separately packaged as `backend/governance-source-v8.xlsx`. The IR contains 187 field rules, 68 relation rules with catalog/link flags kept separate, and all 15 scoring contracts. Example/default columns and historical instance IDs are not runtime defaults.
