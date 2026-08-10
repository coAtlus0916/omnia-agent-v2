# 录制实现映射

| Plane | 实现 | 真实职责 |
|---|---|---|
| Surface | `frontend/surface.json` | 播放器式状态与真实 Artifact 下载 |
| Worker | `middle/worker.cjs` | recordingId、Run、观测控制、流读取、摘要、最终化与投影 |
| Python | `middle/python-bridge.cjs`、`python/*.py` | 单职责授权校验、NDJSON 分批摄取、response evidence 组装、目录行构造、SQLite 24h staging、successor lineage 接管、JSON 流式导出 |
| Core/Data | Feature runtime Store ports、`backend/migrations/001.json` | Processing Run、failed predecessor→唯一 successor 事务、受管 handle、Artifact、计划与私有 SQLite |
| Connector | 签名 `operation.ofop` + 平台 `PageObservationHost`/`ManagedStreamHost` | 当前 Pack 只读页面观测、源头脱敏、有界 NDJSON 流 |

禁止重新引入 `recording_command`、Connector 录制目录、Connector 业务 endpoint 分类或 gzip 分块协议。GRA/Risk/Control 语义只存在于 Feature Python。

Python 调用边界固定为参数化函数：`_validate_ingest_request` 只授权请求和 handle，`_ingest_observation_events` 只校验并分批落事件，`_catalog_rows` 只生成确定性目录行，`write_recording_artifact` 只从 SQLite 游标流式写受管输出。不得按页面、元素类型或 GRA 产品复制第二套摄取/导出引擎。
