# 底稿编制实现映射 __FEATURE_VERSION__

| 平面 | 实现 | 职责 |
| --- | --- | --- |
| Surface | `frontend/surface.json` | APP GRA 单选、冻结计划、Control 进度、确认与只读核验入口；声明式固定状态/操作底栏与独立滚动目录列；不使用 Comments |
| Worker | `middle/worker.cjs` | authority/safety 绑定、Core CAS、一次性 command、no-replay、证据与投影 |
| Python | `python/engine.py` + `middle/python-bridge.cjs` | release CPython 3.13.14 参数化计划、唯一身份和 Tab 201/209 不变量 |
| Store | `backend/migrations/001.json` + Core Store ports | 私有计划、Run、confirmation、intent、command、receipt、Managed Content |
| Operation | `connector-capability/operation.ofop` | APP GRA/Control 只读目录、Control PATCH、精确 reconcile |

Connector 仍只执行签名 Operation 的通用传输和收据生成；没有承载底稿业务判断。
