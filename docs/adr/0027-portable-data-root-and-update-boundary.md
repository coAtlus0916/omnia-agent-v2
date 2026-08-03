# ADR-0027：便携根目录内的数据与更新边界

状态：Accepted  
日期：2026-07-30  
决策者：用户

## Context

当前没有公司级数据保留、备份位置、云同步或不可恢复删除要求。用户希望数据尽量保留在同一便携包/开发包根目录中，方便整体更新、移动和显式删除；同时更新不能覆盖运行数据，Secret 也不能因复制目录而泄露。

“放在同一根目录”不能等同于“程序文件和数据库混在同一版本目录”。否则覆盖式更新、回滚或删除旧 release 容易误删可变数据。

## Decision

1. 每个安装/开发实例有一个稳定的产品根目录，根内至少逻辑分离：

   ```text
   product-root/
   ├─ releases/        # 不可变程序版本
   ├─ current          # active release 指针/记录
   └─ data/            # 稳定可变数据根
      ├─ stores/
      ├─ artifacts/
      ├─ templates/
      ├─ evidence/
      ├─ documentation/
      ├─ packages/
      ├─ updates/
      ├─ logs/
      └─ temp/
   ```

   这是逻辑布局，不提前决定 Windows 物理链接、数据库或打包技术。Store/API 不向 Feature 暴露绝对路径。
2. `releases` 与 `data` 生命周期完全分开。安装更新只新增并激活不可变 release；不得覆盖、重建、移动或删除 `data`。回滚只切换兼容的 release/activation record。
3. Feature 私有 Store、Managed Content、Artifact、模板、Evidence、Documentation Registry 和包缓存尽量位于该实例的 `data` 下；Remote Bridge 短期密文和 Omnia/AI Secret 不因此成为普通便携数据。
4. Secret 由 Windows 当前用户/设备保护的 Secret Store 保存，数据库只保存 `secretRef`。复制产品根到另一台电脑或另一 Windows 用户后，Secret 不可用，相关入口禁用并要求重新配置/配对；不得把 Secret 降级为根目录明文文件以实现“完全便携”。
   包含客户正文的 Store/Artifact 必须使用实例数据密钥做静态保护，数据密钥由 Windows Secret Store 包装；复制根目录不能绕过保护，跨设备读取走受控导出/导入。具体算法和恢复门槛由 D5 冻结。
5. 当前没有按年龄自动删除的业务数据默认值。Run、Artifact、录制、Evidence、模板、历史文档和 Managed Content 默认保留，直到用户通过真实清理动作显式删除，或容量保护停止新任务。引用、`uncertain`、active mutation、repair 和必要 Evidence 仍可阻断物理删除，并必须向用户解释。
6. 首版不承诺定时自动备份、云同步或跨设备无损迁移。破坏性 migration/升级前必须创建同根受控 checkpoint；用户可按未来真实管理动作导出/复制一致性数据包。checkpoint 不能被 UI 冒充长期备份。
7. 删除旧 release、清理 update candidate/package cache、清理业务数据、受控移除实例和直接删除整个产品根是不同操作。每个实例必须持久化不可重用的 `instanceId` 与 `externalResourceInventory`，至少登记 Windows Secret/设备键、Remote 设备注册、Supervisor/服务和待撤销事实。
   受控“彻底删除实例”按以下顺序执行：阻断新 effect 并处理活动/`uncertain` → 撤销 Remote 注册 → 删除 OS Secret/设备键 → 停止并移除 Supervisor/服务 → 删除 data/releases。Remote 注册必须是有最大 TTL 的租约；设备私钥删除后不能继续认证。
   远端不可达时，在删除 `data` 前把最小、非业务正文的签名 `PendingRevocationCapsule` 写入产品根之外的 Windows 保护区，包含 instance/device identity、revocation digest、createdAt、leaseExpiresAt 和重试状态。此时终态只能是 `local_removed_pending_remote`，不能声称彻底删除；胶囊由受控卸载 helper、下次安装或服务器确认/租约自然过期后清除。资源管理器直接删文件夹不等于受控移除实例。
8. 普通更新失败必须保留 `data` 和 previous release。更新器不得使用整个根目录替换、解压覆盖或先删后装。
9. v4 首版不自动迁移。需要历史资料时，对用户点名的数据类别执行只读 inventory、按类打捞、扫描、验证和导入；不扫描整个 v4 根后自动复制。
10. 普通 ThinkPad 是目标设备范围：
    - Windows 10 和 Windows 11 的普通 ThinkPad 均允许安装、连接和使用；不以 Windows 生命周期、ESU、补丁新鲜度或强隔离认证设置统一阻断；
    - 程序可以显示非阻塞的兼容性/安全风险提示，并在问题报告中记录 Windows SKU、build、补丁状态、Electron/Chromium 与杀软信息；
    - 只有真实技术不兼容（例如当前运行时无法启动、所需系统 API 缺失）或具体 capability 的真实依赖失败时，才禁用受影响能力并显示准确原因，不扩大为整机禁用；
    - 最低/推荐 CPU、内存、磁盘和显示缩放通过代表性真机测试形成建议值，不作为开发安装的认证流程。
    Windows 生命周期与 ESU 信息仅作为风险说明和排障背景：[Windows 10 生命周期](https://learn.microsoft.com/en-us/lifecycle/announcements/windows-10-22h2-end-of-support-update)、[Windows 10 ESU](https://learn.microsoft.com/en-us/windows/whats-new/extended-security-updates)。

## Consequences

- 用户可以把一个实例的数据集中管理，同时安全更新/回滚程序版本。
- 复制根目录不能复制可用 Secret 或绕过敏感数据静态保护；迁机后需要受控导入并重新配置 Provider 和 Connector 身份。
- 不做默认年龄清理会增加磁盘占用，需要真实容量、低磁盘和显式清理机制。
- 当前无自动备份承诺；更新 checkpoint 只保护升级恢复，不替代用户备份。
- 未来若出现公司合规、全盘加密或强制保留要求，需要新增 ADR，不得静默改变已保存数据语义。

## Alternatives

### 程序与数据放在同一版本目录

拒绝。旧 release 回收、覆盖更新和回滚会直接威胁数据。

### 默认把数据分散到多个系统目录

首版不采用。会增加便携包管理、更新核对和显式删除的复杂度；Windows Secret Store 是必要例外。

### 默认按固定天数自动清理

拒绝。当前没有公司保留规定，也没有真实容量基准和完整引用图，不应猜测期限。

## Verification

- 更新、回滚、删除旧 release 和清理 candidate 后 `data` digest/引用保持不变；
- 安装器尝试覆盖 `data` 时失败关闭；
- 复制根目录到另一用户/设备后 Key/配对不可用且不会泄露明文；
- migration checkpoint 可恢复，且 UI 不把它显示为长期备份；
- 用户清理能列出实际删除与因引用/`uncertain` 保留的对象；受控移除还能核对 OS Secret、Remote 注册、租约/PendingRevocationCapsule 和 Supervisor/服务；
- 磁盘不足时停止新的大 Artifact/录制或 mutation 准入，不静默删除业务数据；
- v4 默认不迁移，按类打捞可重复、只读、有报告；
- Win10/Win11 代表性 ThinkPad 的兼容性报告记录 SKU/build、生命周期/ESU、补丁状态、Electron/Chromium、Secret Store、杀软、硬件、缩放和数据规模；这些记录用于排障和改进，不构成统一安装/使用门槛。
