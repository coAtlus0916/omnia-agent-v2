# 新建与关联 0.2.3

用户只看到三步：“上传资料 → 校验 → 回传”。内部获取、处理、转换、输出校验、问题修订等状态仍按 Run/Event revision 持久化，但不暴露为额外用户步骤。上传和本地校验不依赖 Remote 或安全锁；回传需要实时 Remote、当前 Pack 安全锁与 Comments 明确确认。

V8 是治理编译输入，不是用户运行输入或输出模板。
# Product behavior

Review uses an APP/DB/OS/Tool element rail and always shows the official editable matrix for the selected active row. Empty kinds are disabled with real counts. Save means “save modifications and recheck”: it persists explicit CAS revisions, compiles a new TemplateInstance, and reruns all local and available live checks. A row can be excluded only while at least two active rows remain; exclusion preserves the original source and revisions and does not invoke Connector mutation or Omnia deletion.

The user chooses an `.xlsx`; cancel creates no Run. A successful choice creates a durable Run and source artifact before Worker processing. Missing, conflicting, or ambiguous values become persistent issues. Editors save explicit user revisions with CAS. The downloadable result is a new workbook containing processing results, an operation plan, source provenance, and an issue/support matrix.

Upload、Review/Validate 和 Return 是由持久化 `workflow.currentStepId` / `reviewNavigation` 驱动的独立界面层；返回 Upload 显式清除 Review/Progress 投影并保留原 Run、Artifact、修订与排除状态。左侧流程下方的“重新开始”只对可编辑 Run 开放：Core 以 CAS 将该 Run 标记 cancelled，保留 Artifact、修订和事件审计，随后回到干净上传层。两者都不会调用 Connector mutation。APP/DB/OS/Tool 都经过对象类型对应的身份预检、create/reuse、GRA、RAIT 和权威读回；DB/OS 先关联 APP 并双向读回，再创建 GRA 并从 live APP GRA 继承 RAIT。Tool 没有模板关系字段，所以不伪造关系。批外 APP、多 APP 和跨 Workspace 仍失败关闭。首次真实 Pack canary 尚未完成。
