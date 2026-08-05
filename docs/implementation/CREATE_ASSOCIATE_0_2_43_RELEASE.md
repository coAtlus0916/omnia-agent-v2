# 新建与关联 0.2.43 Release

日期：2026-08-05；Feature：`omnia.create-associate@0.2.43 / sequence 45`。

本版本将工作簿解析中的逐行全表扫描改为预建索引。APP、DB、OS、TOOL 的行顺序、字段候选、来源、校验问题和语义摘要保持不变；真实 8 行工作簿与 200 行合成工作簿均已做新旧算法等价比对。

当前单次导入上限为 200 个有效元素。解析到第 201 个有效元素时，系统在任何字段或问题写入 Core 前以 `PARSER.ELEMENT_LIMIT_EXCEEDED` 终止，并提示：`当前版本单次最多处理200个元素，请拆分工作簿后重新上传；文件未写入后台。` 该上限用于保证现有 Core 单批字段修订合同不被突破，不是按固定 8 行或固定模板位置识别。

本次随 Omnia Agent v5 Shell 0.4.14 独立 Release 发布；固定启动器仍是唯一用户入口。便携根内置官方 CPython 3.13.14 embeddable x64，用户电脑不需要预装 Python、pip 或 Anaconda，也不会在运行时联网安装依赖。

上传后的 XLSX/OOXML 解析、本地候选与问题生成、四个可见运行工作表编译由隔离 Python sidecar 执行；大二进制通过 Core 管理的 Feature/Run Artifact handle 传递，不使用 base64 跨进程。Run、Artifact 最终提交、安全锁、确认、回传命令、回执和 Managed Content 仍由 Core 掌握。现有完整 Return preparation 与远端执行继续由 Feature Worker 经 Core/Connector 执行；未达到等价的 Python Return compiler 不暴露为生产 capability。

便携路径使用 Windows extended-length namespace 启动 sidecar 和访问临时 Artifact，避免 Feature 安装目录超过传统 260 字符后 Python 无法导入同包模块；Core 合同和用户可见路径保持普通 Windows 路径。
