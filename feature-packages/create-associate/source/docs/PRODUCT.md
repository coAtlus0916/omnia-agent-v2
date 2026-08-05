# 新建与关联 0.2.10

用户只看到三步：“上传资料 → 校验 → 回传”。内部获取、处理、转换、输出校验、问题修订等状态仍按 Run/Event revision 持久化，但不暴露为额外用户步骤。上传和本地校验不依赖 Remote 或安全锁；回传需要实时 Remote、当前 Pack 安全锁与 Comments 明确确认。

V8 是治理编译输入，不是用户运行输入或输出模板。
# Product behavior

Review uses an APP/DB/OS/Tool element rail and always shows the official editable matrix for the selected active row. Empty kinds are disabled with real counts. Save means “save modifications and recheck”: it persists explicit CAS revisions, compiles a new TemplateInstance, and reruns all local and available live checks. A row can be excluded only while at least two active rows remain; exclusion preserves the original source and revisions and does not invoke Connector mutation or Omnia deletion.

The user chooses an `.xlsx`; cancel creates no Run. A successful choice creates a durable `acquiring` Run and source Artifact, displays its real filename/size in the upload box, and does not parse or navigate. Upload exposes only 下载模板 and 确认上传. Confirmation atomically advances the Run to `processing` and immediately projects the Validate page at 0/11; the declared non-mutation background action begins only after that Surface has rendered. Missing, conflicting, or ambiguous values become persistent issues. The compiled TemplateInstance remains an internal managed artifact used for provenance and Return planning; neither it nor the source Artifact exposes a download entry.

Upload、Review/Validate 和 Return 是由持久化 `workflow.currentStepId` / `reviewNavigation` 驱动的独立界面层；步骤 1 详情固定为“上传系统信息”。左侧“重新开始”对 `acquiring|needs_input|ready_for_review` 开放：Core 以 CAS 将 Run 标记 cancelled 并保留 Artifact、修订和事件审计。`processing|converting|validating_output` 中断继续失败关闭且不会自动重放。新文件暂存会在同 Feature/version/engagement 范围内事务取消旧 `acquiring` Run 并记录替换事件。APP/DB/OS/Tool 都经过对象类型对应的身份预检、create/reuse、GRA、RAIT 和权威读回。首次真实 Pack canary 尚未完成。
