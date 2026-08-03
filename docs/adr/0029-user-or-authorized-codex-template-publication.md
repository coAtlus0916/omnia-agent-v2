# ADR-0029：模板由用户或获单次授权的 Codex 发布

状态：Accepted  
日期：2026-07-30  
决策者：用户

## Context

模板会影响生成文件、默认规则以及后续 Omnia 操作。用户确认首版模板可以由用户本人或 Codex 发布，但“Codex 可以发布”不能解释为常驻 owner、持有用户签名私钥，或从普通聊天中自行推断长期授权。

## Decision

1. 用户本人可以通过受控发布服务发布模板。
2. Codex 可以提交、验证并发布某个精确 TemplateVersion，但每次必须持有用户签发的单次 `TemplatePublicationAuthorization`。
3. 授权必须绑定 authenticated user、当前实例、scenario/templateVersion、精确 Artifact/package digest、`allowedAction=publish`、签发/过期时间和 single-use nonce。
4. 授权可在消费前撤销；成功发布进入 `consumed`，校验/签名/激活拒绝进入 `rejected`，或进入 `revoked|expired` 后均为终态，不得复用。拒绝原因脱敏保存并绑定 Evidence。
5. Codex 不持有用户长期签名私钥。受控发布服务验证授权、validation、来源/许可、兼容性和发布签名后执行原子激活。
6. 自动 validation 通过不等于用户授权；Codex 创建或修改了文件也不产生发布权限。
7. 首版不强制第二人审批。未来如引入组织角色或双人审批，新增 ADR，不改写历史 Evidence。

## Consequences

- 用户与 Codex 都能完成发布，同时保留可执行、可撤销、防重放的授权边界。
- 每个 TemplateVersion 都能解释是谁请求、谁执行、授权了什么精确字节以及使用了哪个签名。
- 发布服务需要持久化授权 nonce、终态和 Evidence，不能只保存自然语言摘要。

## Verification

- 普通聊天、过期授权、digest 漂移、错误实例/Scenario、已消费/已拒绝 nonce 和已撤销授权全部拒绝；
- Codex 无授权只能生成 candidate，不能把状态改为 `published`；
- validation 失败时即使授权有效也不能发布；
- 发布成功同时冻结 authorization、publisher、signature、digest、sequence 和 activation Evidence；
- Codex 运行环境中不存在用户长期签名私钥。
