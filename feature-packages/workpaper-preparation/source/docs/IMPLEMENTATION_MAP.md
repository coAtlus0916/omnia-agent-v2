# 底稿编制实现映射 __FEATURE_VERSION__

| 平面 | 实现 | 职责 |
| --- | --- | --- |
| Surface | `frontend/surface.json` | Generic Application GRA 多选、统一冻结批次、分 GRA Control 进度、确认与只读核验入口 |
| Worker | `middle/worker.cjs` | authority/safety 绑定、Core CAS、command、no-replay、证据与投影 |
| Python | `python/workpaper-preparation-engine.py` + `middle/workpaper-preparation-python-bridge.cjs` | release CPython 3.13.14 目标 Control 选择、参数化计划、Tab 201/209 不变量和权威读回分类 |
| Store | `backend/migrations/001.json` + Core Store ports | 私有计划、Run、confirmation、intent、command、receipt、Managed Content |
| Operation | `connector-capability/operation.ofop` | Generic APP 权威目录筛选、Control 只读目录、两阶段 Control 更新、精确 reconcile |

Connector 只执行签名 Operation 的通用传输、路由和证据生成；不承载底稿、Control、APP 编号或 Phase2 业务判断。
