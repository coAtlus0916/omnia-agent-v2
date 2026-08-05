# Four-plane map

Surface 只采集/展示；Worker 解析、验证、编译计划；Core Store 持久化；Connector 只托管签名 Operation。
# Implementation map

Version 0.2.22 keeps the four-plane boundary: Renderer shows compact four-phase workflow and grouped progress; Worker freezes settings mode and orchestrates durable commands; Core alone proves prior product-owned object-create commits and binds settings mode and exact GRA name to immutable intent; the signed Connector Operation performs v4-compatible two-stage PATCH/GET/PATCH and final readback. GRA intent `externalId`, preview desired identity, create/reuse command name and readback name are the same canonical `GRA-${elementId}`. GRA Operation readback extracts one unique active entity GUID from a bare or explicitly allowlisted risk-scope array envelope. Identity resolution marks an otherwise exact GRA with empty RAIT as `exact_existing_incomplete_gra`; Worker/Core retain the planned RAIT field intent, whose signed state Operation performs the actual PATCH and receipt-backed readback. `recover_owned_create_bootstrap` requires both Core ownership proof and current exact empty live settings; ordinary `resume|reuse` remains token-gated. APP identity, object readback, and settings reads retain authoritative Work Item Facet Mapping.

- Frontend: `frontend/surface.json` plus generic two-column workflow renderer, native picker/drop staging, explicit confirmation, post-render background action dispatch, signed-template Save As, artifacts, progress/issues, and issue editors.
- Worker: `middle/worker.cjs` owns XLSX parsing, governance interpretation, plan/output compilation, revisions, and orchestration.
- Backend: migration plus Core structured Run/artifact/template/provenance/issue/intent/command/evidence registries.
- Connector capability: `connector-capability/operation.ofop`; Connector Core supplies only signed route transport, session binding, gates, and Operation hosting.
- Machine-readable mapping: `contracts/implementation-map.json`; runtime I/O/event/error/Store ports are in `contracts/feature-runtime.json`, and signed test inventory/vectors are under `tests/`.
