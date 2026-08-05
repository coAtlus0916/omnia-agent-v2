# Four-plane map

Surface 只采集/展示；Worker 解析、验证、编译计划；Core Store 持久化；Connector 只托管签名 Operation。
# Implementation map

Version 0.2.35 keeps the four-plane boundary. The signed Connector Operation uses Work Item/common-account projections only to lock one canonical active assessment GUID. Missing optional projection fields are deferred to the authoritative GRA detail; explicit conflicts, multiple GUIDs and recycle evidence block. Worker and Core receive only the final exact found/blocked result.

- Frontend: `frontend/surface.json` plus generic two-column workflow renderer, native picker/drop staging, explicit confirmation, post-render background action dispatch, signed-template Save As, artifacts, progress/issues, and issue editors.
- Worker: `middle/worker.cjs` owns XLSX parsing, governance interpretation, plan/output compilation, revisions, and orchestration.
- Backend: migration plus Core structured Run/artifact/template/provenance/issue/intent/command/evidence registries.
- Connector capability: `connector-capability/operation.ofop`; Connector Core supplies only signed route transport, session binding, gates, and Operation hosting.
- Machine-readable mapping: `contracts/implementation-map.json`; runtime I/O/event/error/Store ports are in `contracts/feature-runtime.json`, and signed test inventory/vectors are under `tests/`.
