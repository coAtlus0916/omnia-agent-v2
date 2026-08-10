# Feature 快速开发、安装与测试指导

状态：Accepted workflow / implementation gaps noted  
依据：[ADR-0031](../adr/0031-fast-local-feature-iteration-and-automated-integrity.md)

> 2026-08-03 Connector 更新：标题中的“本地快速迭代”指本地开发工作流，不表示 Shell Local Connector。v5 正式 Connector 链路为 Remote-only，见 [ADR-0035](../adr/0035-remote-only-connector-and-link-code-pairing.md)；本文旧版 Local/Remote Operation host 清单不再授权 Local 产品路径。

## 1. 目标

开发者完成一个可运行切片后，应当立即把它装进独立便携根测试。日常路径不等待 Windows 强隔离认证，不要求人工计算 SHA，也不因 Feature-only 修改而重打 Shell 或 Connector Core。

快速不代表展示型 MVP。前台入口仍必须连接真实 Worker、后台状态或真实 Connector 能力；缺少某一段时可以测试已经接通的层，但不能把完整业务动作标成可用。

## 2. 两条路径

### 2.1 Feature-only 快速路径

适用于 Feature Worker、声明式界面、私有 migration、Feature 文档或既有 Operation 包发生变化，而 Shell 公共合同和 Connector Core 没有变化。

1. 修改 Feature 自己的 source、合同、migration、测试和随包文档。
2. 运行与本 Feature 相关的单元/合同测试；合入候选前再运行项目 `npm run check`。
3. 使用 Feature 构建命令生成 `.ofp`。构建器自动计算成员 digest、生成清单并签名；开发者不手工计算 SHA。
4. 将包安装到一份专用、可删除的 v5 便携测试根。不要覆盖正在使用的便携实例。
5. 启动该便携根，检查真实导航、状态、刷新/重启恢复和错误语义。
6. 若 capability 依赖 Connector Operation，确认相同版本的 `.ofop` 已由公司电脑 Remote Connector Operation host 装载；只在真实依赖存在时执行对应读/写测试。
7. 测试通过后继续开发；需要候选验收或发布时再由工具生成集中证据报告。

当前“删除元素”构建命令已经存在：

```powershell
npm run package:delete-feature
```

该命令会自动构建、计算 digest 和签名。签名密钥由现有受信开发环境提供，不进入仓库。

在已经解压的便携根中，当前安装器的真实调用方式是：

```powershell
$env:ELECTRON_RUN_AS_NODE = '1'
& '<便携根>\releases\0.3.0\Omnia Agent v5.exe' `
  '<便携根>\releases\0.3.0\resources\app\dist\tools\feature-installer.cjs' `
  --root '<便携根>' install '<Feature包.ofp>'
```

安装器内部自动执行签名、成员 digest、清单、兼容性、sequence 和路径检查。开发者只处理成功结果或明确错误，不再逐项人工核对 hash。

### 2.2 平台/Connector 变化路径

只有以下变化才重打对应基础包：

- Shell 公共合同、Package Manager、Documentation Registry 或通用渲染器变化：重打 Shell 便携包；
- Connector Core/Transport/Supervisor 本身变化：重打独立 Remote Connector；
- 仅新增或修改业务 Operation：优先只构建、部署 `.ofop`，不修改 Connector Core；
- Bridge 协议或服务器进程变化：才重新部署 Bridge；普通 Feature 不触发。

## 3. 测试分层

| 层级 | 何时执行 | 通过含义 | 不能宣称 |
|---|---|---|---|
| Feature 单元/合同 | 每次相关修改 | 算法、状态机和端口合同符合预期 | 已接通 Shell/Connector |
| 包安装冒烟 | 每个可安装候选 | 自动签名校验、安装、文档投影、升级/回滚工作 | 业务动作已经可用 |
| 便携 UI 行为 | 界面/action 变化 | 菜单和状态来自真实 Registry/action | 外部 Omnia effect 成功 |
| Remote 链路 | Remote Operation host 与 Bridge 路由已装载 | 当前远程链路可用 | 所有 Pack/协议版本均兼容 |
| 候选/发布验收 | 准备共享候选或发布 | 集中证据和必要回归完成 | 未执行过的真实 mutation 已验证 |

Windows 强隔离认证不属于上述任何一层的必需前置步骤。进程边界、最小权限和故障不扩散仍是实现目标，可用普通故障测试验证，不要求外部认证。

## 4. Hash 与签名的工作方式

日常开发者只需要：

- 使用项目包命令；
- 阅读命令的成功/失败；
- 保留候选版本号和测试结论。

工具负责：

- 每个成员的 digest；
- 包 envelope 的签名；
- 安装时验签与防篡改；
- sequence/兼容性校验；
- 候选或正式发布时的集中证据摘要。

人工 `Get-FileHash`、把 SHA 复制进普通开发记录、每改一次文档就手工对比所有文件，都不是日常完成条件。历史验收报告中已有的 SHA 表是当次集中证据，不是今后每次开发的模板。

## 5. 当前实现差距

当前包管理器已经能安装、升级、回滚并投影文档，但尚没有通用 Feature Worker supervisor/action router，也没有把签名 Operation 包装载进 Remote Connector host。“删除元素”0.1.0/0.1.1 因而只能测试包生命周期和 Worker 合同，不能测试真实 Omnia 删除。

下一轮平台实现应按顺序补齐：

1. 通用 Worker 启动、Store/Event/Connector ports 和 action/message-card 路由；
2. `runtimeEnabled` 改为按真实依赖健康判定，移除硬编码的 `blocked_isolation_and_canary`；
3. Remote Connector Operation host 的签名模块装载与 capability 报告；
4. Remote Connector Operation 的独立下发、side-by-side、回滚与 capability 报告；
5. 在用户授权的当前 Omnia 环境执行第一次真实读/写 canary。

第 1–4 项接通后即可直接安装测试，不增加 Windows 强隔离认证步骤。第 5 项只决定对应真实 Omnia 行为是否已验证。
