# ADR-0030：以 v4 证据启动 v5 删除与录制的重新认证

状态：Accepted  
日期：2026-07-30  
决策者：用户

## Context

v4 已经积累了删除元素和操作录制的真实录制文件、Handoff、当前源码、自动化合同测试、历史真实 canary 与写后读回证据。若要求用户为 v5 再单独准备一个专用 Pack，会重复已有投入，也会延迟文档和首批 Feature 验证。

但 v4 的实现经历过多次契约修正。例如 Tool 关系的并发 token、删除目录读取和录制正文捕获都曾被后续真实证据推翻旧假设。直接把 v4 代码、名称映射或历史端点当成 v5 永久授权同样不安全。

## Decision

1. v5 的删除元素和录制 Feature 以 v4 当前仓库、Handoff、完整录制、合同测试和真实写后证据作为首轮设计与开发输入，不要求用户另行准备专用 Pack。
2. 开发时冻结一份明确的 v4 evidence baseline，至少记录仓库 commit、文件 digest、录制完整性、对应对象/关系/页面范围和证据等级。
3. v4 证据用于：
   - 生成 v5 候选 Operation/capture 合同；
   - 建立 synthetic fixture、回归矩阵和异常样本；
   - 复用已经验证的测试步骤、对象选择原则和写后读回方法；
   - 识别必须保留的安全不变量和已经失败过的假设。
4. v4 证据不用于：
   - 自动启用 v5 mutation capability；
   - 固化历史 Pack、Workspace、Section、对象 ID、名称或端点；
   - 跳过当前 Omnia 会话、权限、类型、关系、并发 token 和终态复核；
   - 把不完整录制或仅文档描述升级为生产合同。
5. 删除元素使用与 v4 相同的测试方法，不要求专用 Pack：
   - 先跑离线合同和 synthetic fixture；
   - 再在当时可用的现有非生产 Pack/Workspace 做只读目录与计划预检；
   - 最后按 capability 逐类选择最小、唯一、可清理目标做单项/小批 canary；
   - 每次 mutation 前实时复核，写后独立读回；结果未知禁止重放。
6. 录制先使用 v4 完整录制语料、当前 Recorder 源码和测试建立 v5 等价基线；首次现场验收可使用当时已有的非生产 Pack 和典型页面流程，不要求固定或专门准备新 Pack。
7. capture allowlist 以 v4 已观察的真实 host/path/method/content-type/body 字段为候选起点；在 v5 首次当前会话中只读/录制复核后冻结。未再次观察到的字段默认不采集，不凭历史名称猜测。
8. 任何 Omnia 明确返回的当前契约与 v4 证据冲突时，当前只读/完整录制证据优先；相关 capability 保持禁用，回填新合同、测试和 ADR/Feature 文档后才能开放。

## Evidence Levels

| 等级 | 最低证据 | 可用于 |
|---|---|---|
| A | 当前源码/测试 + 完整录制或真实 mutation 写后读回 | 候选合同、synthetic 回归、最小现场重新认证 |
| B | 完整录制或已验证历史实现，但缺当前端到端复核 | 候选合同和测试语料，不直接开放 |
| C | Handoff/README 描述、不完整录制或单次观察 | 风险和待测项，不生成可点击能力 |

## Consequences

- 用户不需要为删除或录制额外准备一个专用 Pack。
- v5 可以充分利用 v4 的真实投入，同时避免把历史环境身份和曾被推翻的假设写死。
- 平台边界验证按具体风险与 Feature 开发并行，或在候选复核时完成，不作为开始开发、打包或本地安装的统一 D5 门槛；涉及真实 Omnia 的 capability 仍在届时已有的非生产环境执行首次真实 canary。
- v4 源码可以参考和抽取测试语料，不做整块复制；v5 仍按独立 Feature/Operation 包和统一 Gate 重构。

## Alternatives

### 完全从零重新录制和准备新 Pack

拒绝。它重复已有可靠证据，且用户明确不要求专门 Pack。

### 直接搬迁 v4 代码并视为已验证

拒绝。v4 架构耦合、历史名称推断和多次契约修正不满足 v5 的隔离与重新认证要求。

### 永久绑定 TEST/TEST-Auto

拒绝。测试 Workspace 只是可用时的环境，不是 capability 身份或业务规则。

## Verification

- evidence baseline 可追溯到固定 commit/digest 和完整性状态；
- 不完整录制不会进入 A 级；
- 测试和代码中不存在固定 Pack/Section/Workspace/对象 ID 授权；
- 删除每个已开放 capability 都有当前预检、一次最小 canary 和写后读回；
- 录制与 v4 在开始/暂停/继续/停止、segment、关键正文、完整/不完整状态和脱敏上有等价合同测试；
- 当前 Omnia 与 v4 冲突时失败关闭，不静默沿用历史契约；
- 无专用 Pack 时仍能完成离线测试，并在可用现有非生产环境到位后执行最小现场复核。
