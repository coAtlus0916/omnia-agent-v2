# 新建与关联 0.2.6 热更新

日期：2026-08-05

Feature：`omnia.create-associate@0.2.6 / sequence 8`

Shell：`0.4.12`（不提升 Shell 版本，不生成新 EXE）

## 更新内容

1. `返回上传` 始终服从后台 action 的 `enabled` 状态，不再被未保存 Review 字段阻断；返回后上传步骤为 current，校验和回传均为 pending。
2. `重新检查全部` 在有 dirty draft 时仍可执行，并提交与 `保存修改并重新检查` 相同的 revisions 批次。Worker 继续走同一字段/派生字段 CAS 保存、TemplateInstance 编译和全量实时复核路径，成功后清理前端草稿。
3. Review Surface 固定投影 `artifacts: []`，不再显示内部 `template_instance` XLSX 下载。内部 Artifact、来源追溯和 Return 计划数据仍由 Core 管理。
4. 缺少 Remote Connector binding 或当前 Pack Workspace 安全范围时，`omnia_id_conflicts`、`relationship_targets`、`workspace_live` 三项都返回 failed，并展示具体缺失原因，不再以 pending/未执行泛化文案停住。旧 checkpoint 若仍保存“前两项 pending + workspace failed”，新版投影会用已持久化的 workspace 失败原因将前两项显示为 failed，不伪造已执行证据。一旦 binding 与安全范围可用，revalidate/apply 仍通过既有 signed Connector Operations 真正执行 APP 身份/回收站、非 APP 活动对象、关系目标类型和工作区检查；不会绕过安全锁读取，也不会直接伪造 passed。

## 现场根因

- Renderer 原先把除 `apply-revisions` 外的 Review footer 动作统一套上 `dirtyReviewValues.size > 0` 门禁，导致 `返回上传` 和 `重新检查全部` 在有草稿时都被禁用。
- Renderer 的 `revalidate-all` 只提交 `expectedRunRevision`，Worker 又只为 `apply-revisions` 读取 revisions，因此即使放开按钮也会丢弃未保存草稿。
- Review Surface 投影了编译后的 `template_instance`，通用 Renderer 因而自动显示底部 XLSX 下载。
- `runReviewLiveValidation` 在 binding 或 `safety.workspaceIds` 缺失时提前返回；旧返回对象把 `omnia_id_conflicts` 与 `relationship_targets` 留为 pending，所以界面表现为“未执行”，且没有进入任何 signed Operation。

## 热更新方式

本次只提升独立 Feature 到 0.2.6 / sequence 8，并更新 Shell 0.4.12 的 builtin 文件名引用。构建流程在工作区重新生成 Renderer `dist` 与签名 `.ofp/.ofop` 候选包；现有固定启动器继续加载工作区热构建和新版 builtin。无需重新生成、替换或分发 Windows EXE，用户数据根、Remote binding、安全范围和历史 Run 均保持不变。

## 真实 Omnia canary 状态

2026-08-05 现场快照中，Core 当前 Run `0fce2250…` 仍记录为 Feature 0.2.3；`import-source-workbook` 于 15:32 成功，但没有 signed-operation 日志。持久化 issue 为“请启用当前 Pack Workspace 安全范围后在原 Run 重新校验”，证明实时校验在空 `safety.workspaceIds` 前置门禁处失败关闭，并未调用 Connector。当前 active 0.2.5 仅恢复该旧 checkpoint。

因此真实 SAP ECC Omnia mutation/readback canary 尚未完成。0.2.6 的验收顺序是：先热更新并确认新版 Feature 激活；再启用当前 Pack 的明确 Workspace 安全范围；最后在原 Run 执行重新检查，核对 signed authority/identity/preflight 日志和三项 live check 的真实结果。没有这些现场证据，不得宣称 canary 通过。
