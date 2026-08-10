# Remote Connector 0.3.22

0.3.22 只扩展录制 Feature 的冻结文件传输，不修改连接、心跳、Pack 绑定、安全锁或其他签名 Operation。

- `stop_export` 仍先停止并冻结同一个 recordingId；冻结 NDJSON 在 Connector 本机压缩为不可变 gzip，再按既有 `export_chunk` 合同传输。
- 清单同时保存 gzip 与原 NDJSON 的 size/SHA-256、media type 和 content encoding；重试先核对现有冻结证据，不重放 stop，也不重新采集页面。
- 0.3.21 形成的未压缩 stopped 记录可以在核对原清单后迁移为 gzip；该兼容路径仅作用于录制目录。
- GRA 录制目录新增固定 allowlist 的只读 Risk Factor settings 请求，并继续读取 GRA、IT Element、Risk、Control 与关系详情。缺失或不完整数据明确标记 incomplete，不写 Omnia。

发布门禁要求 0.3.21 自动升级到 0.3.22 后保持同一 Connector identity、当前 Pack binding 和 bridge heartbeat；真实 canary 必须证明录制传输耗时下降、Core Artifact 成功固化以及 HANA GRA 目录完整性。
