# 新建与关联 0.2.50

用户只看到三步：“上传资料 → 校验 → 回传”。内部获取、处理、转换、输出校验、问题修订等状态仍按 Run/Event revision 持久化，但不暴露为额外用户步骤。上传和本地校验不依赖 Remote 或安全锁；回传需要实时 Remote、当前 Pack 安全锁与“新建与关联”回传页内的明确确认。

V8 是治理编译输入，不是用户运行输入或输出模板。
# Product behavior

Review uses an APP/DB/OS/Tool element rail and always shows the official editable matrix for the selected active row. Empty kinds are disabled with real counts. Save means “save modifications and recheck”: it persists explicit CAS revisions, compiles a new TemplateInstance, and reruns all local and available live checks. A row can be excluded only while at least two active rows remain; exclusion preserves the original source and revisions and does not invoke Connector mutation or Omnia deletion.

The user chooses an `.xlsx`; cancel creates no Run. A successful choice creates a durable `acquiring` Run and source Artifact, displays its real filename/size in the upload box, and does not parse or navigate. Upload exposes only 下载模板 and 确认上传. Confirmation atomically advances the Run to `processing` and immediately projects the Validate page at 0/11; the declared non-mutation background action begins only after that Surface has rendered. Missing, conflicting, or ambiguous values become persistent issues. The compiled TemplateInstance remains an internal managed artifact used for provenance and Return planning; neither it nor the source Artifact exposes a download entry.

Version 0.2.50 keeps Return confirmation and the real serial executor inside one authorized mutation action. While it runs, the screen receives receipt-backed Core progress after real command transitions; no timer animation or fabricated increment is used. Generated Risk identities settle first, their governed classifications are written with Risk-owned concurrency evidence when available and then read back, and only then are Risk-Control relations resolved and associated. Risk/Control settlement remains bounded and fails closed on missing, ambiguous or drifted identities.

Artifact-tool workbooks with explicit SpreadsheetML prefixes parse like unprefixed Excel workbooks. Structurally unreadable or empty supported input is rejected before field revisions are persisted.

Upload、Review/Validate 和 Return 是由持久化 `workflow.currentStepId` / `reviewNavigation` 驱动的独立界面层；步骤 1 详情固定为“上传系统信息”。左侧固定显示“重新开始”和“返回上一步”。Validate 返回 Upload 只改变导航并保留 Run、Artifact 与修订；尚未执行任何命令的 waiting_confirmation 返回 Review 时，Core 原子作废确认令牌并取消对应 frozen intents。“重新开始”只对稳定的上传/校验前状态与终态开放：前者 CAS 取消旧 Run，后者保留命令、回执和终态审计；下一次上传创建新 Run。`processing|converting|validating_output|returning|verifying|reconciling|uncertain` 禁止回退和重启，禁用原因来自真实 Run、intent、command、receipt 状态。新文件暂存会在同 Feature/version/engagement 范围内事务取消旧 `acquiring` Run 并记录替换事件。APP/DB/OS/Tool 都经过对象类型对应的身份预检、create/reuse、GRA、RAIT 和权威读回。首次真实 Pack canary 尚未完成。
