# 删除元素独立 Feature 0.1 验收

> 后续决策（2026-08-01）：本报告保留 2026-07-31 候选验收事实和集中 artifact digest。按 [ADR-0031](../adr/0031-fast-local-feature-iteration-and-automated-integrity.md)，Windows 强隔离认证不再是未来安装/启用门槛，开发者也不需要在每次修改后人工复算 SHA。现有 0.1.0/0.1.1 包仍是不可变、`runtimeEnabled=false` 的历史候选；仅修改本报告不会接通 Worker runtime 或 Connector Operation。

验收日期：2026-07-31  
Shell candidate：0.3.0  
Feature：0.1.0 → 0.1.1 → rollback 0.1.0  
结论：候选通过；生产 mutation 未开放。

## 交付边界

0.3.0 Shell 基线不编译删除业务 ID、文案、分支或 Connector endpoint。以下扫描无匹配：

```powershell
rg -n -i "delete-elements|删除元素|omnia\.delete|information\.direct|confirm-delete" src
```

删除业务只存在于 `feature-packages/delete-elements/` 的独立签名源码和候选包。0.2.0 Shell、Remote Connector 0.2.0/sequence 2 和 v4 均未重建、覆盖或发布。

## 正式便携根验收

验收从 ZIP 解压出的完整根执行，不使用源树 `dist`：

```text
portable-root.json
current
releases/0.3.0/
data/
```

安装器由解压包内同一 Electron 二进制以 `ELECTRON_RUN_AS_NODE=1` 运行：

```powershell
Omnia Agent v5.exe resources/app/dist/tools/feature-installer.cjs --root <fresh-root> <command>
```

fresh root 首次 `list` 返回空数组；随后真实完成：

1. 安装 0.1.0：activation generation 1；
2. 安装 0.1.1：generation 2；
3. 显式回滚 0.1.0：generation 3；
4. 篡改 0.1.1 envelope signature 后安装失败，head 仍为 0.1.0/generation 3；
5. Feature Registry、Documentation Registry、activation head 的版本和物理路径一致；
6. 投影文档逐文件 SHA-256 与 `docs/manifest.json` 一致；
7. CLI 运行前后预置 secret ciphertext sentinel 未改变，证明 installer 不改写已有 DPAPI secret 列。

验收结果保存在 fresh root 的 `acceptance-result.json`。最终 head 保持 `runtimeEnabled=false`，`feature_registry.lifecycle=candidate`，真实 active count 为 0。

## 包与供应链

Feature 与 Connector Operation 使用独立 Ed25519 keyId/公钥。安装验证包括：

- envelope/product/key scope；
- exact member inventory；
- canonical Base64、64 位小写 SHA-256、有限 JSON number；
- NFC 与 Windows 大小写折叠路径冲突；
- Windows 设备名、控制字符、冒号、尾随点/空格；
- manifest/navigation/surface/docs/structured migration；
- nested Operation exact operation/route/method/body-mode allowlist；
- mutation `enabledByDefault=false`；
- anti-rollback sequence 与 immutable version。

Operation 包没有自由 URL、header、body、通用 HTTP 或通用 JSON Patch。

## 安装与故障恢复

安装流程为 journal → validate → unique staging → immutable move → documentation projection → one-transaction activation。测试注入 `after_immutable_move_before_activation` 故障，验证：

- activation head 不生成；
- attempt 记录为 failed；
- 同 digest immutable orphan 在下一次安装被重新验签并安全复用；
- 不同 digest 路径冲突 fail closed；
- 相同已激活版本重装是真 no-op，不增加 generation 或 event。

Windows portable 打包也使用唯一 staging，成功后原子切换，并对 EBUSY 做有限重试；中断不会先删除正式 artifact。

## Worker 合同

包内 `middle/worker.cjs` 是真实状态机，不是占位：

- 首版严格一个 Information/plan；
- 冻结 Connector ID、session generation、Pack、完整安全锁、Workspace、对象身份、WorkItem、updatedAt、blocker signature、plan digest；
- 确认前重新 scope read 和 preflight；
- `commit_attempted` 只在实际 mutation 调用前持久化；
- response-lost/timeout/EOF/502/503/504 不重放写，转 uncertain；
- uncertain 只调用独立 read-only reconcile；
- 写后权威读回、managed-content tombstone、authoritative refresh event；
- plan 通过 `savePlan/loadPlan` 窄 Store port 持久化，可跨 worker 重启确认或 reconcile。

worker 同时提供声明式 `messageCard(plan)`。卡片冻结 `featureVersion + surfaceId + runId + confirmationId + stateVersion`；确认只存在于 pending Agent 消息卡，uncertain 只提供只读核验。工作台没有第二个“确认删除”入口。

## 自动与视觉验收

`npm run check`：38/38 tests 通过，随后 build 与 independence test 通过。覆盖签名硬化、安装/升级/回滚、文档投影、故障恢复、跨 worker 恢复、安全锁变化、二次 preflight 变化、uncertain reconcile、tombstone 和 Remote/Local 原有合同。

视觉验收：

- baseline fresh extraction：Feature navigation 为空、active count 0；
- 安装并回滚后：三级菜单“其他 → 元素管理 → 删除元素”出现，availability=disabled；
- workbench 状态徽标显示“已阻止”；
- 禁用原因是中文；
- 工作台只有“权威重抓取”“创建删除计划”，没有确认按钮；
- 第三列聊天、缩放控件和可拖分隔线保留。

截图：

- `docs/reviews/assets/shell-0.3.0-portable-empty.png`
- `docs/reviews/assets/delete-elements-0.1.0-final-disabled.png`

## Artifact 哈希

| Artifact | Bytes | 文件 SHA-256 |
|---|---:|---|
| `artifacts/omnia-agent-v5-portable-0.3.0.zip` | 147,953,151 | `f94660edc817d513e4c54db1d8136990bb14c7e4356d4aa6434f8c4bdd4d9667` |
| `releases/0.3.0/Omnia Agent v5.exe` | 225,613,824 | `8593db40c0c6e5e3c4b6b0a225b1dc9a549ecdf10f6cf2010cf5b6ce869ce07f` |
| `delete-elements-0.1.0.ofp` | 50,614 | `27d176a61527507bb21843235f1305b198c3c646cd042144040888fa23dc0d5b` |
| `delete-elements-0.1.1.ofp` | 50,686 | `53104e3bae453510fc5c94b0cf688ef3b8c5d30d504bd75a3dae009ec3be59ba` |

注意：上表是完整文件 SHA-256；签名 envelope 的 canonical package digest 分别为：

- 0.1.0：`sha256:2d211a8b6dd8e33baf378704dc044ad72d5bfce162f7a4d51e0ab4da8fa5d03e`
- 0.1.1：`sha256:e26a91199a357e25481655ab754dffa8a93ab5ae21a4bd1e7e0662752c79cbfb`

## 未开放项

本轮没有当前 Omnia 实机 canary，也没有执行任何真实 Omnia mutation；Shell 没有通用 Feature Worker/action runtime，Local/Remote Connector host 也没有装载包内 Operation。因此：

- Feature 与 mutation Operation 继续 candidate/disabled；
- UI 不声称删除可用；
- read-only/mutation Operation 尚未装入生产 Connector host；
- Local/Remote Worker/Operation 真实接线和当前响应 schema/status 验证仍未完成；组织代码签名可作为后续分发加固，但不阻碍本地安装测试。

“没有 Windows 强 worker isolation 认证”仍是当次验收的历史环境描述，不再是后续阻塞项。上方 SHA 表属于这一次候选的集中证据，不是日常开发逐次人工核验要求。
