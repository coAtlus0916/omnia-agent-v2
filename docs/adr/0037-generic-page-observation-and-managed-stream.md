# ADR-0037：通用 Page Observation 与 Managed Stream 原语

状态：Accepted；持久冻结证据源码已实现，尚未打包、安装或完成真实 Remote canary  
日期：2026-08-06  
决策来源：用户确认 Connector 只负责传输、Session、Gate 与 Operation host，录制等 Feature 业务不得进入 Connector

## Context

现有签名 Operation host 只支持固定 Omnia HTTP route 和小型 JSON 返回。持续页面观察和较大只读响应如果继续由 Feature 专用 Connector command 承担，会把录制状态机、业务 endpoint 分类、目录拼装和导出逻辑放进 Connector Core；如果改成 Feature 提供脚本、URL、Header 或任意 CDP 命令，又会扩大凭据和任意网络边界。

通用能力必须同时满足：绑定当前已核验 Connector generation 与 Pack；只执行 Connector 固定策略；在源头移除凭据；事件 sequence 连续；大结果不整体进入 JSON；断线重读使用 opaque identity、offset、digest 和 EOF；活动观察随签名 Operation 包的本地生命周期回收。

## Decision

1. Connector Core 提供唯一固定策略 `omnia.page-observation.current-pack.v1`。Operation 只能选择该策略并提供幂等键，不能提供脚本、URL、Header、选择器、endpoint 分类或 Feature command。
2. 观察只绑定当前受控 Omnia Page、精确 Connector binding/session generation/Engagement/Pack 以及签名 Operation package digest。一个包同一时间最多一个活动观察，Connector 全局最多四个。
3. 固定策略观察页面导航、受限 DOM snapshot、交互元数据、同源请求/响应元数据和 GET JSON response evidence。Cookie、Authorization、Header、密码/Token/Secret 字段不进入流；URL query 只保留 GUID、布尔值和有界数字，其余值源头替换为 `[redacted]`。
4. JSON response evidence 在脱敏后拆成有序 base64 segment；单体源响应、单事件、事件数、总流字节和持续时间都有硬预算。缺正文、超预算、target 漂移或页面关闭必须产生 omission/partial 事实，不能截断后标记 complete。
5. 事件写入 Connector 本机 opaque NDJSON managed stream，sequence 从 1 连续递增。Operation 只使用 `streamId + offset + maxBytes` 读取；块大小固定为 128 KiB，活动流只发布完整块，未成块尾部返回 `ready=false` 而不伪造 digest；冻结后发布唯一尾块、整流 SHA-256 和 EOF。已发布 offset 在未释放流上永远返回同一字节与 digest，非块边界或越界读取失败关闭。
6. `open/status/pause/resume/stop/readChunk` 通过签名 Operation SDK 暴露。Operation manifest 使用通用签名 `resourceOwner` 声明稳定 owner、兼容 epoch、capability 和精确 legacy source package digest。稳定 owner identity 由 `featureId + packageId + ownerId + compatibilityVersion + capabilityId` 派生；Connector 不按版本号、描述或 Feature 名称猜兼容。跨 digest 接管还必须满足 publisher sequence 严格递增，以及由 publisher key、Feature/package identity、规范化 Operation descriptors、handler hash 和 policy hash 形成的 capability fingerprint 完全相等。
7. 活动观察继续精确锁定创建它的 package digest、Connector session generation 和受控 Page；Operation 更新不会迁移活动观察，而是先失败关闭并冻结为不可接管的 incomplete evidence。只有 `stopped + complete + omissionCount=0` 且 stream 已标记 transferable 的证据，才可由相同稳定 owner 或 manifest 精确列出的 legacy digest 读取。
8. stream bytes 与逐流 metadata 放在版本外 Connector data root。append 在返回前 `fsync`，metadata 使用同目录临时文件 + 原子 rename；finalize 固化 size、整流 SHA-256、创建 identity、binding scope、fingerprint、sequence 和 7 天 `expiresAt`。cold restart 重新验证 regular file、size 和 digest；漂移/损坏失败关闭但不删除证据。活动 writer 在 restart 后只能冻结为 incomplete，不能续写或冒充 complete。
9. 7 天 TTL 到期后，Connector 才删除 stream/metadata，并先写入只追加 cleanup audit。旧 Connector 遗留的无认证 metadata `.bin` 不再启动即删除：它被移动到 `legacy-orphans`，记录 exact streamId、size、SHA-256 和隔离时间；因为缺少可信 owner/binding，不自动 claim。
10. 该原语不识别 recording、GRA、Risk、Control、元素类型或任何 Feature ID。业务状态机、目录重建、SQLite、导出和 Artifact 完成事实仍由 Feature/Core 拥有。

## Consequences

- 录制 Feature 可以在后续独立包版本中通过签名 Operation 使用同一公共原语，不再要求 Connector Core 理解录制业务。
- 源头脱敏和固定策略缩小了 Bridge/Core 获得凭据或任意页面执行能力的风险。
- 已完整停止的 managed stream 在明确 7 天 TTL 内跨 Operation package 更新、Worker/Supervisor cold restart保持精确只读；Feature 仍只能使用 opaque `streamId + offset`，不能获得 Connector 路径。
- 无 metadata 的 legacy orphan 只能先法证隔离；除非后续存在可验证的签名 owner/binding claim 合同，否则不能从文件名或内容自动认领。
- 本变更触及 Connector Core 合同，因此必须独立打包、安装和 Remote canary；源码 typecheck/build 不能替代公司电脑页面观察证据。

## Alternatives

- 保留 Feature 专用 recording command：拒绝，持续违反 Connector 无业务分支约束。
- 允许 Feature 传入脚本、URL、Header 或 CDP 方法：拒绝，形成任意执行/HTTP 代理并扩大凭据泄露面。
- 整流 JSON 或一次性 base64 返回：拒绝，超过 Remote 消息预算时会截断、复制大内存或失去可重读 checkpoint。
- 只捕获 DOM、不捕获只读 JSON response：不足以形成真实页面/API evidence；仍需另建 Feature 专用读取链。

## Verification

- 定向 TypeScript strict typecheck 覆盖合同、managed stream、page observation 和 Operation host。
- 定向 build 证明新增模块可进入 Connector bundle，且不修改 Bridge、Supervisor、凭据、更新或重连文件。
- 进程自检必须证明：open 幂等、连续 sequence、敏感字段脱敏、128 KiB 上限、重复 offset digest 一致、EOF 只在 finalize 后出现、跨注册版本/进程重开、错误 owner/Pack/authority、active upgrade fail-close、tamper 和 TTL audit。
- 真实 Remote canary 必须在公司电脑已核验 Pack 上执行 start/pause/resume/stop/readChunk，并由 Feature/Core 消费成真实 Artifact；未完成前不得宣称录制迁移完成。
