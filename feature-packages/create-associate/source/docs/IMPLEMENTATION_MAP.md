# Four-plane map

Surface 只采集/展示；Worker 解析、验证、编译计划；Core Store 持久化；Connector 只托管签名 Operation。
# Implementation map

Version 0.2.24 keeps the four-plane boundary. The signed Operation selects primary active risk scopes by canonical object type and optional content identity before comparing entity GUIDs. Top-level direct identities remain authoritative candidates. Untyped and other-type scopes are not guessed; zero candidates use the existing strict current directory fallback. APP/DB/OS/TOOL use Application/Infrastructure/Infrastructure/ITTool, with GRA type IDs 3/4/4/5. Empty RAIT remains a separate state intent requiring real PATCH/readback.

- Frontend: `frontend/surface.json` plus generic two-column workflow renderer, native picker/drop staging, explicit confirmation, post-render background action dispatch, signed-template Save As, artifacts, progress/issues, and issue editors.
- Worker: `middle/worker.cjs` owns XLSX parsing, governance interpretation, plan/output compilation, revisions, and orchestration.
- Backend: migration plus Core structured Run/artifact/template/provenance/issue/intent/command/evidence registries.
- Connector capability: `connector-capability/operation.ofop`; Connector Core supplies only signed route transport, session binding, gates, and Operation hosting.
- Machine-readable mapping: `contracts/implementation-map.json`; runtime I/O/event/error/Store ports are in `contracts/feature-runtime.json`, and signed test inventory/vectors are under `tests/`.
