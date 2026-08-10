# ADR-0026：只允许官方签名的 Feature 与 Operation 包

状态：Accepted  
日期：2026-07-30  
决策者：用户

## Context

独立 Feature 包用于降低发布和故障半径，但也形成高权限供应链边界。允许任意第三方或未签名离线包会扩大 Feature Worker、UI、Module Store、Connector Operation 和文档注册表的攻击面。

## Decision

1. 生产环境只信任 Omnia Agent v5 官方发布根签发的 Feature、Connector Operation、策略和更新 manifest。
2. 未签名、签名无效、发布者不受信、sequence 回退、已撤销、SBOM/成员 allowlist/digest/兼容性不合格的包一律拒绝，不能通过设置或命令行关闭门禁。
3. 首版不开放第三方发布者注册、任意包市场、任意 URL 安装，也不提供“选择任意本地文件并忽略风险”的导入入口。
4. 默认从官方受控发布服务取得包。未来可以兼容由官方签名的离线包，但必须另行评审受控管理员导入流程、介质来源、撤销新鲜度和审计；该兼容方向不构成首版任意离线导入入口。
5. 开发与 D5 conformance 可使用隔离的官方测试根/测试发布源。测试信任根不得进入生产信任集合，测试包不得在生产 Registry 中激活。
6. Feature 包中的代码、UI、合同、migration、SBOM 和文档属于同一个签名发布事实；任何成员变化都需要新版本、新 digest 和重新签名。
7. Operation Module 同样只允许官方签名。不能借“Connector 只做 Gate”把未受控业务代码装进高权限 Operation Worker。
8. 发布者身份、签名 key、sequence、构建来源、安装/拒绝/撤销、active/previous 和回滚 Evidence 必须持久化并可审计。
9. 根据 [ADR-0031](0031-fast-local-feature-iteration-and-automated-integrity.md)，包构建器自动计算成员 digest 并签名，安装器自动验签、校验成员和 sequence。日常开发者不手工计算、复制或逐项核对 SHA；必要 digest 只在候选验收/正式发布时由工具集中报告。

## Consequences

- 首版供应链边界清晰，支持成本和恶意包风险显著降低。
- 用户不能安装第三方或自行修改的 Feature 包。
- 官方发布系统、密钥轮换、撤销、离线恢复和构建可复现成为平台必备能力。
- 若未来存在离线环境需求，可增加“只接受官方签名离线包”的受控流程，而不改变官方信任根原则。
- 官方签名不会变成逐次人工流程；快速开发安装只处理工具给出的成功或明确拒绝结果。

## Alternatives

### 允许用户确认后安装任意包

拒绝。一次确认不能替代发布者身份、签名、权限、隔离、撤销和兼容性门禁。

### 允许第三方使用自己的签名

首版拒绝。需要独立的发布者治理、责任边界、审核、撤销和支持模型。

## Verification

- 未签名、篡改、未知发布者、sequence 回退、撤销和测试根包在生产环境全部失败关闭；
- 文档或 SBOM 任一成员改变都会使整个候选签名验证失败；
- 更新命令不能携带任意 URL、脚本或临时信任根；
- 生产安装界面不存在第三方/未签名包绕过入口；
- 官方签名包 candidate 失败不影响 active/previous 或其他 Feature；
- 信任根轮换、撤销过期、离线和恢复演练具有 Evidence。
