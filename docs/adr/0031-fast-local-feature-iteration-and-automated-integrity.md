# ADR-0031：Feature 本地快速迭代与自动完整性处理

状态：Accepted  
日期：2026-08-01  
决策者：用户

## Context

v5 仍要保持 Shell 与业务 Feature 分离、Feature 之间互不覆盖，并只安装受信包。但此前部分文档把 Windows 强隔离认证、逐次人工计算文件 SHA、真实 canary 和正式发布检查全部叠加成了日常开发安装的前置门槛，导致“代码完成后立即装入便携包测试”无法成为正常路径。

这些事项需要分层：开发测试需要真实代码、真实状态和真实依赖，但不需要先完成 Windows 强隔离认证或由开发者人工抄录哈希；候选/正式发布才需要集中生成供应链证据。签名和成员 digest 已经是包格式的一部分，应由构建器和安装器自动处理，而不是成为人工操作负担。

## Decision

1. **Windows 强隔离认证不再是 Feature 安装、本地启用或开发测试的前置条件。** v5 保留独立 Feature 包、独立版本、数据 owner、故障边界和受控 SDK/Operation 合同；Windows sandbox、AppContainer 或第三方隔离认证只能作为后续加固项，不能仅因尚未完成而把一个真实接线且可测试的 Feature 强制设为 `disabled`。
2. 本地正式快速路径固定为：构建 Feature → 工具自动生成成员 digest 并签名 → 安装到独立便携根 → 启动真实 Worker/后台/界面 → 连接当前可用的 Local 或 Remote 依赖 → 立即执行行为测试。Feature-only 变化不要求重打 Shell；Connector Core 没有变化时不要求重打 Connector。
3. “不以隔离认证阻碍测试”不等于允许假功能。缺少 Worker supervisor、后台 repository、真实 action、Connector Operation host、所需模板或当前连接时，只禁用受影响 capability，并显示准确原因；不得把未接通的动作写成可用。
4. 签名、成员 hash/digest、清单和反篡改验证继续保留，但全部由包构建器、安装器和发布工具自动完成。日常开发者不计算、不复制、不逐项比对 SHA，也不把手工 SHA 清单作为每次开发的完成条件。
5. 开发安装只看工具的结构化成功/失败结果和行为测试结果。候选验收或正式发布时，由工具一次性输出 package identity、版本、签名验证、必要 digest、测试摘要和安装/回滚证据，集中写入验收或发布记录。
6. 官方签名原则不变：可安装 Feature/Operation 仍来自 v5 受信发布根。开发者使用项目配置的受信开发签名流程；不增加“忽略签名”“跳过完整性”或任意第三方包入口。
7. 真实 Omnia/Provider 测试按 capability 需要执行。它是验证外部链路的测试步骤，不是普遍的安装门槛；首次授权环境中的真实测试可以直接作为 canary。没有执行过真实 mutation 时必须如实写“未验证”，不能据合同测试宣称写链路可用。

## Consequences

- Feature 开发完成后可以直接装入便携包进行本地行为测试，不等待 Windows 强隔离认证。
- 开发者不再被要求为每个小改动人工生成或核对 SHA；供应链格式仍由工具保证。
- 运行时可用性由真实依赖和真实接线决定，而不是由笼统的“认证未完成”决定。
- 现有“删除元素”0.1.0/0.1.1 候选包仍是不可变历史产物；它们的 `runtimeEnabled=false` 和旧禁用原因不会通过改文档原地改变。后续新版本必须在实现 Worker supervisor 与 Connector Operation 装载后，按本 ADR 更新运行时判定。
- 取消认证门槛不会取消 Feature 间独立升级、数据边界、响应丢失不重放、写前预检和写后读回等业务可靠性要求。

## Supersedes / Refines

- 细化 [ADR-0001](0001-microkernel-isolated-feature-workers.md)：保留独立进程/故障边界，取消“Windows 强隔离认证是安装或启用前置条件”的解释。
- 细化 [ADR-0026](0026-official-signed-package-supply-chain.md)：保留官方签名和自动校验，取消日常开发者手工计算/抄录 SHA 的流程。
- 替代开发手册、Feature 源文档和验收说明中把 `strong isolation certification` 单独列为运行时阻塞项的未来指导；历史验收事实仍保留。

## Verification

- 一个仅修改 Feature 的 patch 可以在不重打 Shell/Connector Core 的情况下自动打包并安装到指定便携根。
- 构建器自动签名，安装器自动验证；快速路径文档不要求人工运行 `Get-FileHash` 或手抄 SHA。
- 缺少真实 Worker/Operation/连接时，UI 显示具体依赖缺失，不使用“隔离认证未完成”作为笼统原因。
- 接通真实依赖后，Feature 能直接进入 Local/Remote 行为测试；测试失败只影响该 Feature/capability。
- 篡改、未知发布者和不兼容包仍由安装器自动拒绝。
