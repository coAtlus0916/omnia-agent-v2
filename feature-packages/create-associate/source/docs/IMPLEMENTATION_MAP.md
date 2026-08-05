# Four-plane map

Surface 只采集/展示；Worker 解析、验证、编译计划；Core Store 持久化；Connector 只托管签名 Operation。
# Implementation map

Version 0.2.30 keeps the four-plane boundary. The Worker query and frozen target remain unchanged. The signed Connector Operation canonicalizes duplicate object and GRA directory representations by GUID, rejects conflicting identities, and uses object detail plus Work Item-to-Workspace mapping as final authority. Core can therefore reuse an already created object and relation without replaying mutation calls.

- Frontend: `frontend/surface.json` plus generic two-column workflow renderer, native picker/drop staging, explicit confirmation, post-render background action dispatch, signed-template Save As, artifacts, progress/issues, and issue editors.
- Worker: `middle/worker.cjs` owns XLSX parsing, governance interpretation, plan/output compilation, revisions, and orchestration.
- Backend: migration plus Core structured Run/artifact/template/provenance/issue/intent/command/evidence registries.
- Connector capability: `connector-capability/operation.ofop`; Connector Core supplies only signed route transport, session binding, gates, and Operation hosting.
- Machine-readable mapping: `contracts/implementation-map.json`; runtime I/O/event/error/Store ports are in `contracts/feature-runtime.json`, and signed test inventory/vectors are under `tests/`.
