# 底稿编制实现映射 __FEATURE_VERSION__

| 平面 | 实现 | 职责 |
| --- | --- | --- |
| Surface | `frontend/surface.json` | Generic Application GRA 单选、单 APP 冻结计划、上传/初始跳过、Control 进度、确认与只读核验入口 |
| Worker | `middle/worker.cjs` | authority/safety 绑定、仅限 pre-Return 同权威草稿的 Session 换绑、真实空资料状态、Core CAS、command、no-replay、缺证据 editor/text 占位回传、程序索引、证据与投影 |
| Python | `python/workpaper-preparation-engine.py` + `python/policy_extract.py` + `middle/workpaper-preparation-python-bridge.cjs` | release CPython 3.13.14 目标 Control 选择、嵌套制度 ZIP 的有界递归解析、参数化计划、Tab 201/209 不变量和权威读回分类 |
| Store | `backend/migrations/001.json` + Core Store ports | 私有计划、Run、confirmation、intent、command、receipt、Managed Content |
| Operation | `connector-capability/operation.ofop` | Generic APP 权威目录筛选、Control 只读目录、两阶段 Control 更新、正文 snapshot permit、全部正文页签动态 token、TOD/OE1–4 精确 procedure ID PATCH 与 readback |

Connector 只执行签名 Operation 的通用传输、路由和证据生成；不承载底稿、Control、APP 编号或 Phase2 业务判断。
