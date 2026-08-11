# ADR-0022：先交付真实 Shell 基线，首批功能使用独立 Feature 包

状态：Accepted  
日期：2026-07-30  
决策来源：用户产品决策  
Refines：ADR-0001 的微内核与隔离 Feature Worker；ADR-0021 的首批开发顺序

## Context

v5 要证明功能可以单独开发、部署、升级和回滚，而不是把代码放进不同目录后仍随整个应用一起发布。若一开始把首批功能编译进 Shell，就无法证明 Feature Registry、包生命周期、隔离、版本兼容、私有迁移和故障边界真实有效。

用户决定首批开发先交付一个不内置业务 Feature 的 Shell，再把录制、删除元素、删除聊天记录、新建与关联做成独立 Feature 包进行测试。

“空壳”容易被误解为只有界面、假菜单或模拟数据。本决定中的 Shell 基线必须是真实可运行的平台交付物，只是尚未安装业务 Feature。

## Decision

1. 首个工程交付物是 **Shell Baseline**，包含真实可运行的：
   - 三列 Shell、统一缩放与可调整分区；
   - Core、Feature Registry、Package Manager、Documentation Registry、Managed Content Registry 和版本化公共合同；
   - Core DB、模块数据域托管、Artifact quarantine、Secret/Evidence 边界；
   - Run/Step/Event/Lease、权限、诊断和真实健康状态；
   - 本地聊天/会话和 FeatureContext 基础状态；未配置真实 AI Provider 时不得生成模拟回复；
   - Local/Remote Transport 合同与 Connector Gate 的平台能力，是否可用由真实状态决定。
2. Shell Baseline **不内置**录制、删除元素、删除聊天记录或新建与关联的业务 Worker、业务 UI、业务迁移或 Connector Operation。
3. 未安装任何业务 Feature 时：
   - 第二列不显示硬编码的首批菜单，只显示来自 Registry 的真实空状态；
   - 第三列保留真实聊天/交付区域；依赖未配置时显示真实不可用原因；
   - 系统设置、诊断和模块管理只有在具备真实 Core action/data/state 时才可操作；
   - 不使用 mock、sample、硬编码统计或假成功来填充界面。
4. 四个首批功能分别构建为独立签名 Feature 包，按 ADR-0021 的顺序安装和验收：
   1. 录制；
   2. 删除元素；
   3. 删除聊天记录；
   4. 新建与关联。
5. 每个包拥有独立 `featureId/version/manifest/worker/ui/private migration/data owner/tests/docs/SBOM/signature`，可以在不重装 Shell、不重启无关 Worker、不迁移其他模块数据的情况下独立安装、启用、禁用、升级和回滚。
   Feature UI 同样必须隔离：使用 Shell 解释的声明式 view，或独立无特权 sandboxed view；不得把包的 JavaScript/CSS import 到特权 Shell renderer。
   Feature 文档必须记录每个 capability 的四 Plane 实现，并与代码同版本安装、升级和回滚；详细规则由 [ADR-0023](0023-feature-documentation-bundle.md) 约束。
6. Feature 菜单只在包已安装、签名有效、兼容、启用、Worker 健康、依赖满足且用户有权限时由后台注册；卸载或禁用后从业务树移除或显示真实禁用状态。
7. 每加入一个首批包，都必须重复验证：
   - 从零 Feature 到安装后菜单出现；
   - 真实 Run 闭环；
   - 禁用、升级、回滚、重启和失败恢复；
   - 已安装前序包继续可用且状态不漂移；
   - 包崩溃、迁移失败或签名失败只影响自身。
8. Feature 包可以独立交付已经确定；生产只允许官方签名包并从官方受控发布源取得，首版不开放第三方或任意离线导入。未来只能在独立评审后兼容官方签名离线包，见 [ADR-0026](0026-official-signed-package-supply-chain.md)。测试工具不得自动演变成生产信任根或任意包导入入口。
9. Feature 所需 Omnia 能力使用独立签名 Operation Module；普通业务包不得要求修改 Connector Core。Operation Module 的发布、在线升级和信任边界继续遵循 ADR-0019。

## Consequences

- 首批计划新增一个先于录制的 Shell Baseline 工程里程碑，但它不是第五个业务 Feature，也不改变四个 Feature 的开发顺序。
- Shell/Core 的边界必须先稳定到足以安装和隔离真实包；首批功能不能通过私有旁路补齐 Shell 缺失能力。
- “安装包包含一组已批准 Feature”的单体交付假设被收紧：基础安装可只包含 Shell/Core；Feature 是独立部署单元。
- Shell Baseline 可以作为内部/验收交付物，但在没有业务 Feature 时不得被宣传为已经具备录制、删除或新建能力的完整产品。
- 每增加一个包都会形成一次架构隔离回归，第四个“新建与关联”仍承担首批四 Plane 综合验收。

## Alternatives

### 首版把四个功能全部编译进 Shell

实现路径较直接，但无法证明独立安装、升级、回滚和故障隔离，后续拆包成本会重新出现。

### 先做只有静态界面的演示壳

不能验证 Registry、Package Manager、Core 状态、持久化或隔离，并会形成假入口，违反真实功能原则。

### 四个包并行安装后再测试

难以定位公共平台和包边界问题，也不符合已经确认的 Feature 开发顺序。

## Verification

- 无 Feature 的干净安装启动成功，Registry 返回真实空集合，业务树无硬编码叶子；
- Shell 的设置、诊断、布局、聊天基础状态和 Package Manager 全部读取真实 Core 状态；
- 首批四个包可以逐个独立安装、启用、禁用、升级、回滚和恢复；
- 安装/升级失败不改变 active 版本，不破坏 Shell 或其他 Feature；
- Feature Registry 与 Documentation Registry 的 active/previous 版本一致；文档失败会拒绝候选，回滚同时恢复代码和文档；
- Managed Content Registry 在无业务 Feature 时返回真实空集合；不预填样例对象，新建/删除包只通过 ADR-0024 的受控合同更新；
- Feature UI 的死循环、崩溃、CSS/DOM 越界和非法 Bridge 消息只影响自身 surface；
- 包删除/禁用不删除其私有数据；清理数据必须是独立确认操作；
- Shell、Feature、Operation 和合同版本均在 Run/Evidence 中可追溯；
- 无 mock/sample/hardcoded 业务数据参与 Shell Baseline 或 Feature 发布验收。
