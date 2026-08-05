# Four-plane map

Surface 只采集/展示；Worker 解析、验证、编译计划；Core Store 持久化；Connector 只托管签名 Operation。
# Implementation map

Version 0.2.23 keeps the four-plane boundary. Detail entity evidence has priority and conflicts fail closed. A zero-candidate detail may use only one current authoritative directory row with exact assessment ID, object ID, canonical GRA name, Workspace and object type; the reconciler obtains that directory through two explicit signed read-only routes. Directory merges record conflicting identity fields as ambiguous rather than selecting one silently. Empty RAIT remains a separate state intent requiring real PATCH/readback. The v4 Application settings protocol and all authority/safety/receipt boundaries remain unchanged.

- Frontend: `frontend/surface.json` plus generic two-column workflow renderer, native picker/drop staging, explicit confirmation, post-render background action dispatch, signed-template Save As, artifacts, progress/issues, and issue editors.
- Worker: `middle/worker.cjs` owns XLSX parsing, governance interpretation, plan/output compilation, revisions, and orchestration.
- Backend: migration plus Core structured Run/artifact/template/provenance/issue/intent/command/evidence registries.
- Connector capability: `connector-capability/operation.ofop`; Connector Core supplies only signed route transport, session binding, gates, and Operation hosting.
- Machine-readable mapping: `contracts/implementation-map.json`; runtime I/O/event/error/Store ports are in `contracts/feature-runtime.json`, and signed test inventory/vectors are under `tests/`.
