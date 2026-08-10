# ADR-0019：Remote Connector 必须支持分层在线升级

状态：Accepted / Decision 12 superseded by ADR-0028  
日期：2026-07-30  
决策者：用户

## Context

v5 只维护一个本地产品，Remote 是 Connector Transport。用户要求 Remote Connector 继续支持在线升级，同时希望新功能尽量不修改、少升级 Connector。

这两个目标并不冲突：绝大多数业务变化应通过独立 Operation/Capability Module 交付；Connector Core 仍需要在 Transport、Session、Gate、安全协议、Omnia 基础兼容或严重漏洞修复时具备远程在线升级能力。

“在线升级”只表示无需人工复制完整安装目录即可取得、验证、切换候选版本，不表示允许热补丁、静默运行未签名代码、绕过在途任务或直接从任意 URL 下载执行。

## Decision

1. Remote Connector 必须支持由受信发布系统提供的在线检查、下载、验证、暂存、激活、观察和回滚。
2. 升级分为三层：
   - Operation/Capability Module：默认、最常用；不修改 Connector Core，按版本并行和 Run pinning 升级；
   - Connector Core/runtime：仅在 Transport、Session、Gate、受控 SDK、安全边界或 Omnia 基础兼容确实变化时升级；
   - Supervisor/bootstrap/trust root：极少变更，使用独立双重签名/bootstrap 流程和显式管理员批准。
3. 新 Feature 不得以方便为理由要求 Connector Core 升级。Core 变更必须在发布记录中说明为什么 Operation Module 无法完成，并经过独立架构评审。
4. 所有在线包必须具备签名、逐文件 hash/size、SBOM、产品/通道/平台/兼容范围、单调 publisher sequence 和撤销信息。
5. 更新器只能使用固定或受签名策略允许的更新源；禁止命令携带任意下载 URL、脚本或执行参数。
6. 更新采用 candidate/active/previous 分槽：
   - 在非 active 目录下载和验证；
   - 候选独立启动并通过 health/contract；
   - 阻止新命令并等待安全窗口；
   - 原子切换 active generation；
   - probation 通过后晋升，否则回到 previous。
7. 在途 mutation、未解决 `uncertain`、Connector Artifact 上传、状态未知，或无法安全结束的命令都会阻断 Core 激活；不得为了更新强制重启或切换到 Local。
8. Operation Module 默认 side-by-side 安装。活动 Run 冻结旧版本，新 Run 只在新版本健康且兼容后使用新版本；旧版本在无引用后回收。
9. Core 更新后必须重新建立 Connector 身份、Session/Engagement 绑定、capability snapshot 和 active lease，全部通过后 Remote Transport 才恢复 `available`。
10. 更新失败时保留用户选择的 `remote` 模式并显示真实失败；使用 previous 恢复服务，不静默 fallback 到 Local。
11. 防降级 sequence 不因回滚而降低。回滚使用已授权的 previous payload 和更高序列的回滚授权/修复发布，不通过修改本地状态绕过单调性。
12. 自动下载、自动安装、通知安装或维护窗口的产品策略另行配置；无论采用哪种策略，上述安全门禁都不可关闭。该未决策略现已由 [ADR-0028](0028-remote-automatic-safe-window-rollout.md) 收敛为 `automatic_safe_window`。
13. Run pinning 不覆盖安全撤销。撤销至少区分“禁止新 Run”“提交点前停止”“禁止全部执行/仅允许兼容 read-only reconcile”和“信任根失陷”；历史 payload 可以保留审计但不可因此继续执行。超过撤销分发 TTL 且无法刷新时，Remote mutation 失败关闭。
14. 已提交或 `uncertain` 命令绑定的版本被撤销时，不重放、不静默切换实现；只有明确声明可解释旧 Command/Evidence schema 的安全版本可以执行只读 reconcile，否则保持 `uncertain` 并要求人工处理。

## Consequences

- Remote Connector 可以长期维护、安全修复和适配 Omnia 变化，不依赖现场手工复制。
- 大多数新功能只升级 Feature Package 和 Operation Module，减少 Core 重启与连带风险。
- 需要长期维护最小 Supervisor、签名发布服务、更新状态合同、A/B 槽、兼容矩阵和撤销机制。
- Core 升级会产生短暂 maintenance 状态，但不能丢失 Run、Command、Evidence 或改变 Local/Remote 用户选择。
- Operation Module 的供应链权限仍然很高，不能成为隐藏巨型 Connector 业务代码的容器。
- 具体默认 rollout、截止时间与高危更新降险规则见 [ADR-0028](0028-remote-automatic-safe-window-rollout.md)。

## Alternatives

### Remote Connector 永不在线升级

拒绝。无法及时修复安全问题、协议变化和 Omnia 兼容性，也增加远程维护成本。

### 每个 Feature 都升级整个 Connector

拒绝。扩大故障半径、增加重启和回归成本，违背 Connector 只做 Gate 的目标。

### 运行中直接覆盖文件

拒绝。无法可靠回滚，可能混用版本、破坏活动命令和 Evidence。

### 从命令指定任意 URL 下载执行

拒绝。形成远程代码执行和供应链后门。

## Verification

- Operation Module 升级不重启 Connector Core，不中断其他版本固定的 Run；
- Core 更新在活动 mutation/uncertain/Artifact 上传时保持 `waiting_safe_window`；
- 包篡改、错误产品/通道/平台、sequence 回退、撤销 key 和不兼容合同全部失败关闭；
- 下载中断可续传或清理 candidate，不影响 active；
- candidate crash/health/contract 失败不切换；
- 激活后崩溃或 probation 超阈值恢复 previous，且不重放 mutation；
- 更新后重新验证 Connector/Session/Engagement/capability/lease；
- Remote 更新失败不会启动 Local Connector 命令领取；
- pinned 旧版本被各严重度撤销时，新 Run、提交前命令、uncertain reconcile 和历史 payload 分别按合同失败关闭；
- 撤销列表过期/离线、key 轮换和 trust-root compromise 均有演练，历史 bytes 保留不等于可执行；
- 更新状态、版本、发布者、时间、结果和脱敏错误均可审计。
- 默认自动安全窗口的下发、截止时间和 admission 测试见 [ADR-0028](0028-remote-automatic-safe-window-rollout.md)。
