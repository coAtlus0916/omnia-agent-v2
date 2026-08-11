# Feature 详细设计：删除聊天记录

状态：Product Direction Accepted / Technical Contract Pending  
用户可见名称：删除聊天记录  
所属范围：首批 Feature / 其他

## 1. 精确定义

本 Feature 删除的是 Omnia Agent v5 本地主界面第三列中、当前明确选定会话的聊天记录。

它不删除：

- Omnia 平台上的聊天、评论、邮件、工作项或其他远端记录；
- 当前 Feature、Feature 配置、模板、Provider 或 Connector 配置；
- 其他本地会话；
- 已经发生或可能发生 Omnia effect 的 Evidence；
- 被其他 Run、会话或业务结果引用的 Artifact。

本 Feature 不调用 Connector。当前选择 local 或 remote 不改变其本地删除语义。

## 2. 用户可见结果

用户查看删除影响摘要并明确确认后：

- 当前第三列聊天消息立即按最终策略清空；
- 会话仍存在并可继续新对话；
- 当前 FeatureContext 可以保留，但不能把被删消息重新投影回来；
- 系统返回真实删除数量、保留数量和保留原因；
- 删除失败时保留原消息，不出现“界面空了但数据库没删”的假成功。

## 3. 数据分类

| 数据类别 | 默认 owner | 删除决策 |
|---|---|---|
| ChatMessage | Conversation service | 用户确认后立即物理删除；无普通用户回收站 |
| Chat-only Attachment | Artifact service | 无其他引用且不受保留策略约束时清理 |
| FeatureContext | Session service | 默认保留，允许用户继续当前 Feature |
| terminal Run 投影 | Run service | 删除聊天投影，不直接删除 Run 事实 |
| active Run/Confirmation | Run/Confirmation service | 存在时阻断删除 |
| uncertain Command | Command service | 存在时阻断删除 |
| Evidence/Audit | Evidence service | 与聊天正文分离，按 Evidence 策略保留 |
| Provider/Connector/Template 配置 | 各自 owner | 永不由本 Feature 删除 |

聊天正文不应复制进普通运行日志或 Evidence；Evidence 如需证明用户确认，只保存会话引用、摘要 digest、计数、时间和决定。

已确认的数据生命周期见 [ADR-0015](../adr/0015-chat-history-immediate-deletion.md)：

- 聊天正文立即物理删除，不设置普通用户回收站；
- 仅被聊天引用、没有其他引用且不受活动状态约束的附件物理清理；
- 已发生 Omnia effect、`uncertain`、共享引用和必要 Evidence 分离保留；
- Evidence 只保留不可变身份、digest、计数、时间、决定和必要脱敏摘要，不复制聊天正文；
- 会话和 FeatureContext 默认保留，可继续新的对话。

## 4. 删除前阻断

以下任一条件成立时，不创建可执行删除操作：

- 当前会话身份或 stateVersion 不明确；
- 存在 `preparing/queued/running/waiting_confirmation/reconciling` Run；
- 存在 active/paused 录制；
- 存在未解决 `uncertain` Command；
- Connector Artifact 仍在上传且归属当前会话；
- 附件引用图读取失败；
- 数据库处于迁移、恢复或只读故障状态；
- 无法生成准确的删除/保留摘要。

阻断原因必须来自后台，不由前端根据按钮状态猜测。

## 5. 持久删除操作

为避免删除消息后进程崩溃而遗留附件，后台先创建持久 `ChatDeletionOperation`：

| 字段 | 说明 |
|---|---|
| operationId | 不透明 ID |
| conversationId | 精确会话 |
| stateVersion | 防陈旧确认 |
| messageIdsDigest | 待删消息集合摘要 |
| deletableAttachmentIdsDigest | 可清理附件集合摘要 |
| retainedReferenceSummary | 必须保留的数据及原因 |
| confirmationId | 一次性确认 |
| status | `planned|committing|cleanup_pending|completed|failed` |
| counts | 计划/已删/保留/清理失败的真实计数 |

`planned` 阶段不删除任何正文。确认只能消费一次；集合或引用变化时原计划失效。

## 6. 建议事务语义

```text
读取当前会话与引用图
  → 生成删除/保留摘要与 digest
  → 用户明确确认
  → 同一数据库事务：
       再校验 stateVersion/digest
       写入 committing
       删除 ChatMessage 和聊天投影
       写入 cleanup tombstone
       提交
  → Artifact service 删除无引用且允许删除的附件
  → 重读消息与引用
  → completed / cleanup_pending / failed
```

- 数据库事务失败：原聊天仍在，返回失败。
- 消息事务成功但附件清理失败：聊天保持已删除，状态为 `cleanup_pending`，后台按幂等 tombstone 重试；不能把消息恢复成可见。
- 附件在清理前出现新引用：保留附件并记录原因，不强删。
- 重复请求返回同一 operation 结果，不重复计算或扩大删除范围。

## 7. 恢复与重启

- `planned` 未确认操作过期后自动关闭，不删除数据；
- `committing` 由数据库事务决定全部提交或全部回滚；
- `cleanup_pending` 在重启后继续幂等清理；
- UI 刷新后从后台读取 operation 和当前消息集合；
- 不使用前端 localStorage 作为删除完成证据。

## 8. UI 合同

确认前展示：

- 当前会话名称/创建时间；
- 消息数量、聊天专属附件数量；
- 会被保留的 Run/Evidence/共享 Artifact 数量及原因；
- 是否不可恢复；
- 当前活动状态与阻断原因。

确认后展示真实结果，不显示推算数字。搜索、导出历史、回收站和批量删除其他会话不属于本首批 Feature；没有真实后端前不提供入口。

## 9. 验收门槛

- [ ] 只能清理当前明确选择的 v5 本地会话。
- [ ] 不向 Connector 或 Omnia 发送任何删除命令。
- [ ] 配置、FeatureContext 和其他会话不被误删。
- [ ] active Run、录制、上传和 uncertain 会阻断。
- [ ] 消息与附件引用图变化会使旧确认失效。
- [ ] 数据库失败时 UI 仍显示原消息。
- [ ] cleanup_pending 可跨重启恢复且幂等。
- [ ] 共享/受保留 Artifact 不被删除。
- [ ] 删除结果区分聊天正文已删和 Evidence/业务数据保留。
- [ ] 不使用 mock 数量、硬编码成功消息或仅前端清空。

## 10. 已确认决定与仍待技术验证

产品语义已经冻结：

- 聊天正文立即物理删除，不提供普通用户回收站；
- 无引用聊天专属附件随清理器物理删除；
- 必要业务/Evidence 分离保留；
- 当前没有公司级年龄保留要求。

开发前仍需用 D5/Feature 测试验证数据库事务、引用图、`cleanup_pending` 重启恢复、物理清理和备份边界；这些是技术验收，不再是用户产品选择。
