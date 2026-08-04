# Shell 0.4.4 启动修复与便携入口验收

状态日期：2026-08-03
范围：只修复 Shell 主窗口显示竞态、明确完整便携根的双击入口并同步 Shell 产品版本；不修改 Renderer 业务、Feature/Operation、Bridge、Remote Connector 或 `data` 合同。

## 问题与修复

1. 0.4.3 在 `await loadFile(...)` 之后才订阅 `ready-to-show`，事件可能已发生，导致 1280×800 主窗口长期 `Visible=False`。0.4.4 在加载前订阅该事件，并在加载完成后检查一次真实可见性作为平台兜底。
2. 初始 0.4.4 把 `releases/<version>` 当组件目录、把可运行产品根放在 `artifacts/`，导致用户直接双击 release EXE 必然失败。该结论已撤销。当前规则改为 `releases/` 是唯一产品根，版本 EXE 可向上发现根标记，`data/` 位于版本目录外，后续不再生成 `artifacts/` 副本。
3. 初始双击入口把带末尾反斜杠的 `%~dp0` 作为引号参数传入 PowerShell，真实执行报 `GetFullPath: Illegal characters in path`。修复为 `%~dp0.`。原冒烟只检查 CMD 存在并绕过它直接启动 EXE，因此其“入口通过”结论无效。
3. `data/` 继续位于便携根，release 内不创建可变数据。启动器设置的产品根只指向经过身份验证的便携根，不创建 Local Connector 或 fallback。

## 验收分层

| 层级 | 唯一执行入口 | 判定 |
|---|---|---|
| 定向回归 | `npx tsx --test tests/shell-startup.test.ts` | 显示监听顺序、便携根发现、`current` 解析和越界拒绝 |
| 冻结前完整验收 | `npm run check` | lint、typecheck、全量自动化、build 与独立性一次完成 |
| 冻结候选 | `npm run package:windows` | 只消费已冻结 `dist`，不隐式重跑 build/test；只生成一次 Shell release、manifest 和 ZIP |
| 用户入口验收 | 用户直接双击 `releases/0.4.4/Omnia Agent v5.exe` 或 `releases/Start Omnia Agent v5.cmd` | 自动化不得绕过真实入口后宣称通过；每个版本由用户直接测试 |

`acceptance/shell-0.4.4-portable/portable-startup-smoke-report.json` 没有执行 CMD，也不是用户入口通过证据，已撤销。真实 Omnia/Pack、公司电脑 Remote Connector 和 mutation/read-back 本轮均不执行，继续标为“未实机验证/待 canary”。

## 交付入口

用户直接使用 `releases/`：可双击 `releases/Start Omnia Agent v5.cmd`，也可双击 `releases/0.4.4/Omnia Agent v5.exe`。复制到其他电脑时复制整个 `releases/`，不要只复制单个 EXE。
