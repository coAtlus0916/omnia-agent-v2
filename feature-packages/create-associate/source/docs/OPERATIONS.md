# 运维

安装后 Worker 在 Remote 未配置时仍可上传和本地校验。实时 Review/prepare 使用不授予写权限的 APP 专用身份解析或 DB/OS/Tool 通用身份解析；四类对象新建在 mutation 前都必须重新通过 `omnia.create-associate.object.create-preflight.v2`，且仅 `disposition=create` 可取得一次性 permit。不得绕过身份/回收站判定。回传仍须遵守全量 read-back、精确 scope evidence 和 `uncertain` 禁止重放。
# Operations and recovery

Offline conversion does not require or register Remote Operations. The first connector invocation lazily registers the exact nested package and caches by Feature version, Operation digest, and Connector session generation.

On a commit-step response loss, mark the command and Run uncertain. Do not replay. Invoke only the corresponding read-only reconcile Operation, compare exact identity/value/multiset, and advance verified current only on authoritative evidence. Real canary and capability evidence are authority/tenant/Pack/engagement/Workspace scoped and revocable.
