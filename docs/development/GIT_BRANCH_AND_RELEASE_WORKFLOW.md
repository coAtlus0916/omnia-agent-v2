# Git 分支、Remote 联调与便携发布流程

## 单一源码原则

Remote 在线测试版与公司便携包不是两套产品源码，也不得以两个长期分支承载不同实现。两者从同一提交构建，只允许部署 profile 不同：

- `remote-test`：连接测试服务器，用于持续真实 Pack 联调；
- `company-loopback-current`：由主 EXE 启动内置 Connector Next，用于公司便携发布。

两个 profile 必须使用同一组已接受 Feature 身份。Feature 业务只能存在于各自签名 Feature 包，不能进入 Connector。

## 长期分支

| 分支 | 职责 | 允许的提交 |
|---|---|---|
| `main` | 正式主线；任一提交都必须可构建便携包 | 已完成 Remote 验收或不影响运行的文档/发布维护 |
| `integration/remote` | Remote 在线联调入口 | 待真实 Pack 验收的完整候选提交 |

除此之外只使用短期 `feature/<topic>` 或 `fix/<topic>` 分支。禁止重新建立长期 `portable`、`connector` 或 Feature candidate source 分支。

## 开发与晋升

1. 从 `integration/remote` 创建短期任务分支。
2. 完成代码和必要的定向验证后，合入 `integration/remote`。
3. 用该提交部署 Remote 测试环境并记录精确 commit SHA、Connector profile 和 Feature 集合摘要。
4. 真实 Pack 验收通过后，仅以 fast-forward 方式把同一提交推进 `main`。
5. 从 `main` 打不可变 Tag，并构建公司单 EXE 便携 ZIP。
6. ZIP、历史 Connector 包和历史候选放 GitHub Release；Git 只保留当前构建所需的接受资产和清单。

`main` 产生紧急修复时，必须立即同步回 `integration/remote`，禁止形成双向长期漂移。

## Tag 约定

- 正式源码：`v<shell-version>`
- 公司便携发布：`v<shell-version>-company-loopback-r<revision>`
- Remote 联调候选：`remote-test/<date>-<short-sha>`
- 只读历史证据：`archive/<name>`

Feature 的签名 package identity 仍以包内版本、sequence 和 digest 为准；Tag 不能替代签名清单。

## 对 Agent 的标准指令

开始日常 Remote 开发：

```text
开始 Remote 联调开发：<目标>。从 integration/remote 开始，只部署 Remote 测试，不晋升 main、不打便携包。
```

Remote 验收完成后晋升：

```text
Remote 验收通过。把当前同一提交 fast-forward 晋升 main，打发布 Tag，并构建公司单 EXE 便携包。
```

只修改便携封装而不改变业务时：

```text
调整便携发布封装：<目标>。业务代码和 Feature 集合保持与 integration/remote 当前接受版本一致。
```

## 安全规则

- 禁止直接 force-push `main` 或 `integration/remote`；
- 分支删除前必须先用可验证 Tag 保存唯一提交；
- 未跟踪候选不得顺手加入产品提交；
- API key、运行数据库、Connector 身份、Chromium profile、日志和 ZIP 不得进入 Git；
- 发布前必须记录源码 commit、profile、Feature 清单、ZIP 字节数和 SHA-256。
