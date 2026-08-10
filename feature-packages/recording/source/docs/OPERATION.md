# 录制签名 Operation

Operation package 只暴露以下 read-only 操作：

- `omnia.recording.pack.read.v1`
- `omnia.recording.observation.open.v1`
- `omnia.recording.observation.status.v1`
- `omnia.recording.observation.pause.v1`
- `omnia.recording.observation.resume.v1`
- `omnia.recording.observation.stop.v1`
- `omnia.recording.observation.read-chunk.v1`

所有 Operation 条目只声明同一条当前 Pack hierarchy 固定 GET allowlist，以满足可执行 Operation 的安装合同；只有 pack read 实际调用该 step。其余操作只把 Feature 请求映射到 `sdk.pageObservation`。Operation 校验 binding、recording UUID、opaque observation/stream ID、128 KiB offset；没有业务 URL 分类、递归目录抓取或写操作。

0.4.19 的签名 manifest 另外声明通用 `resourceOwner`：稳定 owner family/epoch/capability 与 0.4.16/0.4.17/0.4.18 exact Operation package digest。Connector 计算忽略 version/sequence/signature 的 ABI fingerprint（publisher、Feature/package identity、canonical Operation descriptors、handler/policy digest）；只有 fingerprint 相等且 sequence 单调时，才可把已有 durable creator metadata 的 stopped/complete/zero-omission/finalized PageObservation 与 Managed Stream 原子迁到稳定 owner。注册沿现有 `operation_register` route 使用 prepare、commit、abort、finalize：PackageManager 先精确注册 current source Operation；prepare 时旧 digest 继续服务 frozen read且新 digest 不可 invoke；commit 后新旧 digest 并存；Core activation head CAS 前失败时用同 token abort 并保留旧注册，CAS 成功后只允许 finalize 删除旧注册，绝不删除 frozen owner/stream。Core SQLite ledger 精确绑定 source/target Feature digest、Operation digest、activation generation 与 token，禁止从 candidate 顺序或 Worker health 猜 handoff。Worker health 不得以 Feature 私有计划自动声明未知 owner 的 legacy orphan；缺少不可变 creator receipt 的隔离证据保持原样，等待用户明确授权的独立法证恢复。Feature 业务、固化状态机与 recording 计划不得进入 Connector。
