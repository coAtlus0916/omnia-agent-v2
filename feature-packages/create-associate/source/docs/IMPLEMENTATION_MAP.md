# Four-plane map

Surface 只采集/展示；Worker 解析、验证、编译计划；Core Store 持久化；Connector 只托管签名 Operation。
# Implementation map

Version 0.2.9 keeps the four-plane boundary: Renderer displays backend-driven Upload/Review/Return layers, stages picker/drop input, and generically dispatches a declared non-mutation background action once after the exact processing Surface renders; Worker owns staging confirmation, APP/DB/OS/Tool rules, local/live validation, relation-before-GRA ordering, RAIT inheritance and output compilation; Core owns Run/Artifact persistence, atomic `acquiring -> processing`, replacement cancellation audit, field revisions, issues and TemplateInstance bindings; Connector hosts only the existing signed Operations. The authority Operation now shares the verified `facets/byEngagementIds` source and strict real-Facet membership semantics with safety/delete. Review hides the internal TemplateInstance artifact and Upload never exports a source Artifact. Business branching remains outside Connector Core.

- Frontend: `frontend/surface.json` plus generic two-column workflow renderer, native picker/drop staging, explicit confirmation, post-render background action dispatch, signed-template Save As, artifacts, progress/issues, and issue editors.
- Worker: `middle/worker.cjs` owns XLSX parsing, governance interpretation, plan/output compilation, revisions, and orchestration.
- Backend: migration plus Core structured Run/artifact/template/provenance/issue/intent/command/evidence registries.
- Connector capability: `connector-capability/operation.ofop`; Connector Core supplies only signed route transport, session binding, gates, and Operation hosting.
- Machine-readable mapping: `contracts/implementation-map.json`; runtime I/O/event/error/Store ports are in `contracts/feature-runtime.json`, and signed test inventory/vectors are under `tests/`.
