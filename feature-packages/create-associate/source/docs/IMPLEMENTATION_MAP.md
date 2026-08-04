# Four-plane map

Surface 只采集/展示；Worker 解析、验证、编译计划；Core Store 持久化；Connector 只托管签名 Operation。
# Implementation map

Version 0.2.5 keeps the four-plane boundary: Renderer displays backend-driven Upload/Review/Return layers and submits typed actions; Worker owns APP/DB/OS/Tool rules, local/live validation, relation-before-GRA ordering, RAIT inheritance and output compilation; Core atomically commits field revisions, issue replacement, TemplateInstance bindings and Run CAS; Connector hosts signed identity/recycle resolution, object-type-aware create-only permit preflight and gated Return Operations. Business branching remains outside Connector Core. Generic `clearFields` and `restart` presentation live in Shell contracts; Run reset semantics remain in the Feature Worker and Core state machine. The fixed authority Operation reads the exact v4-verified Workspace Facet Type; Connector does not infer Workspace business membership.

- Frontend: `frontend/surface.json` plus generic two-column workflow renderer, native picker/drop/import, signed-template Save As, artifacts, progress/issues, and issue editors.
- Worker: `middle/worker.cjs` owns XLSX parsing, governance interpretation, plan/output compilation, revisions, and orchestration.
- Backend: migration plus Core structured Run/artifact/template/provenance/issue/intent/command/evidence registries.
- Connector capability: `connector-capability/operation.ofop`; Connector Core supplies only signed route transport, session binding, gates, and Operation hosting.
- Machine-readable mapping: `contracts/implementation-map.json`; runtime I/O/event/error/Store ports are in `contracts/feature-runtime.json`, and signed test inventory/vectors are under `tests/`.
