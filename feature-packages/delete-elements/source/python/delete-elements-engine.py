"""Pure deterministic scheduler for the delete-elements frozen plan graph."""

from __future__ import annotations

import hashlib
import json
import os
import struct
import sys
import traceback
from typing import Any


PROTOCOL = "omnia.python-sidecar-rpc/v1"
INPUT_SCHEMA = "omnia.delete-scheduler-input/v1"
OUTPUT_SCHEMA = "omnia.delete-scheduler-decision/v1"
PREPARATION_INPUT_SCHEMA = "omnia.delete-preparation-compile-input/v1"
PREPARATION_OUTPUT_SCHEMA = "omnia.delete-preparation-compile-output/v1"
CAPABILITIES = ["compile_delete_preparation", "schedule_deletion"]
MAX_FRAME_BYTES = 1024 * 1024
MAX_STEPS = 2000
MAX_TARGETS = 200
OUTCOME_STATES = {"succeeded", "failed", "skipped", "uncertain"}
OBJECT_TYPES = {"Information", "GRA", "APP", "DB", "OS", "DCNO", "TOOL"}
INFRASTRUCTURE_TYPES = {"DB", "OS", "DCNO"}
RELATION_TYPES = {"InfrastructureApplication", "ItToolApplication"}


class SchedulerError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def required_text(value: Any, label: str, maximum: int = 800) -> str:
    result = str(value or "").strip()
    if not result or len(result) > maximum:
        raise SchedulerError("DELETE.SCHEDULER_INPUT_INVALID", f"{label} is invalid.")
    return result


def canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def optional_text(value: Any, label: str, maximum: int = 800) -> str:
    result = str(value or "").strip()
    if len(result) > maximum:
        raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", f"{label} is invalid.")
    return result


def preparation_text(value: Any, label: str, maximum: int = 800) -> str:
    result = str(value or "").strip()
    if not result or len(result) > maximum:
        raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", f"{label} is invalid.")
    return result


def target_key(value: dict[str, Any]) -> str:
    return f"{value['objectType']}|{value['workspace']}|{value['objectId']}"


def relation_edge_key(value: dict[str, Any]) -> str:
    return f"{value['relationType']}|{value['sourceObjectId']}|{value['targetObjectId']}"


def relation_group_key(relation_type: str, source_object_id: str, target_object_ids: list[str]) -> str:
    target_digest = hashlib.sha256(canonical(sorted(set(target_object_ids))).encode("utf-8")).hexdigest()
    return f"{relation_type}|{source_object_id}|group:{target_digest}"


def blocker_kind(value: Any) -> str:
    normalized = str(value or "").strip().lower()
    if normalized in {"riskassessment", "riskfactorevaluation", "gra"}:
        return "GRA"
    if normalized == "infrastructure":
        return "INFRASTRUCTURE"
    if normalized == "application":
        return "APPLICATION"
    if normalized in {"ittool", "tool"}:
        return "TOOL"
    raise SchedulerError("DELETE.PREPARATION_GRAPH_UNSUPPORTED", "Blocking relation type is outside the signed graph compiler.")


def normalize_preparation_target(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", "Preparation target is invalid.")
    object_type = preparation_text(raw.get("objectType"), "target.objectType", 32)
    if object_type not in OBJECT_TYPES:
        raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", "Preparation target type is unsupported.")
    workspace = preparation_text(raw.get("workspace"), "target.workspace", 500)
    workspace_ids = raw.get("workspaceIds")
    if not isinstance(workspace_ids, list) or len(workspace_ids) != 1 or workspace_ids[0] != workspace:
        raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", "Preparation target Workspace is invalid.")
    object_id = preparation_text(raw.get("objectId"), "target.objectId", 500)
    information_id = optional_text(raw.get("informationId"), "target.informationId", 500)
    if object_type == "Information" and information_id != object_id:
        raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", "Information identity is inconsistent.")
    if object_type != "Information" and information_id:
        raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", "Non-Information target contains an Information identity.")
    return {
        "objectId": object_id,
        "informationId": information_id,
        "workItemId": preparation_text(raw.get("workItemId"), "target.workItemId", 500),
        "objectType": object_type,
        "workspace": workspace,
        "workspaceIds": [workspace],
        "riskAssessmentId": optional_text(raw.get("riskAssessmentId"), "target.riskAssessmentId", 500),
    }


def normalize_preparation_relation(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", "Preparation relation is invalid.")
    relation = {
        "relationType": preparation_text(raw.get("relationType"), "relation.relationType", 80),
        "sourceObjectId": preparation_text(raw.get("sourceObjectId"), "relation.sourceObjectId", 500),
        "targetObjectId": preparation_text(raw.get("targetObjectId"), "relation.targetObjectId", 500),
        "sourceObjectType": preparation_text(raw.get("sourceObjectType"), "relation.sourceObjectType", 32),
        "targetObjectType": preparation_text(raw.get("targetObjectType"), "relation.targetObjectType", 32),
        "sourceWorkItemId": preparation_text(raw.get("sourceWorkItemId"), "relation.sourceWorkItemId", 500),
        "targetWorkItemId": preparation_text(raw.get("targetWorkItemId"), "relation.targetWorkItemId", 500),
        "sourceWorkspaceId": preparation_text(raw.get("sourceWorkspaceId"), "relation.sourceWorkspaceId", 500),
        "targetWorkspaceId": preparation_text(raw.get("targetWorkspaceId"), "relation.targetWorkspaceId", 500),
    }
    if relation["relationType"] not in RELATION_TYPES:
        raise SchedulerError("DELETE.PREPARATION_GRAPH_UNSUPPORTED", "Relation type is outside the signed graph compiler.")
    return relation


def normalize_preparation_preflight(raw: Any, target: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", "Preparation object preflight is invalid.")
    workspace_ids = raw.get("workspaceIds")
    if (str(raw.get("objectId") or raw.get("informationId") or "") != target["objectId"]
            or str(raw.get("objectType") or "") != target["objectType"]
            or str(raw.get("workItemId") or "") != target["workItemId"]
            or not isinstance(workspace_ids, list) or workspace_ids != [target["workspace"]]):
        raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", "Object preflight identity or Workspace differs from its target.")
    raw_blockers = raw.get("blockers")
    raw_relations = raw.get("relations")
    if not isinstance(raw_blockers, list) or len(raw_blockers) > MAX_TARGETS * 4 or not isinstance(raw_relations, list) or len(raw_relations) > MAX_TARGETS * 4:
        raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", "Object preflight graph inventory is invalid.")
    blocker_by_identity: dict[str, dict[str, str]] = {}
    for raw_blocker in raw_blockers:
        if not isinstance(raw_blocker, dict):
            raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", "Object blocker is invalid.")
        kind = blocker_kind(raw_blocker.get("type"))
        blocker = {
            "kind": kind,
            "id": preparation_text(raw_blocker.get("id"), "blocker.id", 500),
            "workItemId": optional_text(raw_blocker.get("workItemId"), "blocker.workItemId", 500),
        }
        identity = f"{kind}|{blocker['id']}"
        existing = blocker_by_identity.get(identity)
        if existing is not None and existing != blocker:
            raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", "Duplicate blocker identity contains conflicting evidence.")
        blocker_by_identity[identity] = blocker
    relation_by_identity: dict[str, dict[str, Any]] = {}
    for raw_relation in raw_relations:
        relation = normalize_preparation_relation(raw_relation)
        identity = relation_edge_key(relation)
        existing = relation_by_identity.get(identity)
        if existing is not None and existing != relation:
            raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", "Duplicate relation identity contains conflicting evidence.")
        relation_by_identity[identity] = relation
    return {
        "objectId": target["objectId"],
        "informationId": target["informationId"],
        "workItemId": target["workItemId"],
        "objectType": target["objectType"],
        "workspaceIds": [target["workspace"]],
        "riskAssessmentId": optional_text(raw.get("riskAssessmentId"), "preflight.riskAssessmentId", 500),
        "blockers": [blocker_by_identity[key] for key in sorted(blocker_by_identity)],
        "relations": [relation_by_identity[key] for key in sorted(relation_by_identity)],
    }


def compile_delete_preparation(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict) or payload.get("schemaVersion") != PREPARATION_INPUT_SCHEMA:
        raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", "Delete preparation compiler input schema is invalid.")
    plan_id = preparation_text(payload.get("planId"), "planId", 200)
    run_id = preparation_text(payload.get("runId"), "runId", 200)
    raw_targets = payload.get("targets")
    raw_preflights = payload.get("objectPreflights")
    if not isinstance(raw_targets, list) or not 1 <= len(raw_targets) <= MAX_TARGETS or not isinstance(raw_preflights, list) or len(raw_preflights) != len(raw_targets):
        raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", "Delete preparation target/preflight inventory is invalid.")
    targets = [normalize_preparation_target(raw) for raw in raw_targets]
    target_by_id: dict[str, dict[str, Any]] = {}
    target_keys: set[str] = set()
    for target in targets:
        key = target_key(target)
        if target["objectId"] in target_by_id or key in target_keys:
            raise SchedulerError("DELETE.PREPARATION_INPUT_INVALID", "Delete preparation contains duplicate or cross-type target identity.")
        target_by_id[target["objectId"]] = target
        target_keys.add(key)
    preflights = [normalize_preparation_preflight(raw, targets[index]) for index, raw in enumerate(raw_preflights)]

    edge_by_key: dict[str, dict[str, Any]] = {}
    for preflight in preflights:
        for edge in preflight["relations"]:
            source = target_by_id.get(edge["sourceObjectId"])
            target = target_by_id.get(edge["targetObjectId"])
            if source is None or target is None:
                raise SchedulerError("DELETE.PREPARATION_GRAPH_INCOMPLETE", "Relation requires every endpoint in the explicit selection.")
            valid_pair = ((edge["relationType"] == "InfrastructureApplication" and source["objectType"] in INFRASTRUCTURE_TYPES and target["objectType"] == "APP")
                          or (edge["relationType"] == "ItToolApplication" and source["objectType"] == "TOOL" and target["objectType"] == "APP"))
            if (not valid_pair or source["workspace"] != target["workspace"]
                    or edge["sourceObjectType"] != source["objectType"] or edge["targetObjectType"] != target["objectType"]
                    or edge["sourceWorkItemId"] != source["workItemId"] or edge["targetWorkItemId"] != target["workItemId"]
                    or edge["sourceWorkspaceId"] != source["workspace"] or edge["targetWorkspaceId"] != target["workspace"]):
                raise SchedulerError("DELETE.PREPARATION_GRAPH_INVALID", "Relation evidence conflicts with selected endpoint identity or Workspace.")
            key = relation_edge_key(edge)
            existing = edge_by_key.get(key)
            if existing is not None and existing != edge:
                raise SchedulerError("DELETE.PREPARATION_GRAPH_INVALID", "Relation identity contains conflicting evidence.")
            edge_by_key[key] = edge

    gra_seed_by_key: dict[str, dict[str, Any]] = {}
    for index, selected in enumerate(targets):
        preflight = preflights[index]
        gra_ids = {value for value in [selected["riskAssessmentId"], preflight["riskAssessmentId"]] if value}
        gra_ids.update(blocker["id"] for blocker in preflight["blockers"] if blocker["kind"] == "GRA")
        for risk_assessment_id in sorted(gra_ids):
            key = f"GRA|{selected['workspace']}|{risk_assessment_id}"
            seed = gra_seed_by_key.setdefault(key, {"key": key, "riskAssessmentId": risk_assessment_id,
                                                     "workspace": selected["workspace"], "affectedTargetKeys": []})
            seed["affectedTargetKeys"] = sorted(set([*seed["affectedTargetKeys"], target_key(selected)]))
        for blocker in preflight["blockers"]:
            kind = blocker["kind"]
            if kind == "GRA":
                continue
            if selected["objectType"] == "APP" and kind == "INFRASTRUCTURE":
                source = target_by_id.get(blocker["id"])
                if source is None or source["objectType"] not in INFRASTRUCTURE_TYPES:
                    raise SchedulerError("DELETE.PREPARATION_GRAPH_INCOMPLETE", "Infrastructure/Application blocker requires both exact endpoints.")
                if blocker["workItemId"] and blocker["workItemId"] != source["workItemId"]:
                    raise SchedulerError("DELETE.PREPARATION_GRAPH_INVALID", "Infrastructure blocker Work Item identity conflicts with the selected endpoint.")
                generated = {"relationType": "InfrastructureApplication", "sourceObjectId": source["objectId"],
                             "targetObjectId": selected["objectId"], "sourceObjectType": source["objectType"],
                             "targetObjectType": selected["objectType"], "sourceWorkItemId": source["workItemId"],
                             "targetWorkItemId": selected["workItemId"], "sourceWorkspaceId": source["workspace"],
                             "targetWorkspaceId": selected["workspace"]}
                if source["workspace"] != selected["workspace"]:
                    raise SchedulerError("DELETE.PREPARATION_GRAPH_INVALID", "Infrastructure/Application blocker crosses Workspace.")
                edge_by_key[relation_edge_key(generated)] = generated
            elif selected["objectType"] in INFRASTRUCTURE_TYPES and kind == "APPLICATION":
                target = target_by_id.get(blocker["id"])
                if target is None or target["objectType"] != "APP":
                    raise SchedulerError("DELETE.PREPARATION_GRAPH_INCOMPLETE", "Infrastructure/Application blocker requires both exact endpoints.")
                if blocker["workItemId"] and blocker["workItemId"] != target["workItemId"]:
                    raise SchedulerError("DELETE.PREPARATION_GRAPH_INVALID", "Application blocker Work Item identity conflicts with the selected endpoint.")
                generated = {"relationType": "InfrastructureApplication", "sourceObjectId": selected["objectId"],
                             "targetObjectId": target["objectId"], "sourceObjectType": selected["objectType"],
                             "targetObjectType": target["objectType"], "sourceWorkItemId": selected["workItemId"],
                             "targetWorkItemId": target["workItemId"], "sourceWorkspaceId": selected["workspace"],
                             "targetWorkspaceId": target["workspace"]}
                if selected["workspace"] != target["workspace"]:
                    raise SchedulerError("DELETE.PREPARATION_GRAPH_INVALID", "Infrastructure/Application blocker crosses Workspace.")
                edge_by_key[relation_edge_key(generated)] = generated
            elif ((selected["objectType"] == "APP" and kind == "TOOL")
                  or (selected["objectType"] == "TOOL" and kind == "APPLICATION")):
                source_id = selected["objectId"] if selected["objectType"] == "TOOL" else blocker["id"]
                target_id = selected["objectId"] if selected["objectType"] == "APP" else blocker["id"]
                blocker_endpoint = target_by_id.get(blocker["id"])
                if blocker_endpoint is None or (blocker["workItemId"] and blocker["workItemId"] != blocker_endpoint["workItemId"]):
                    raise SchedulerError("DELETE.PREPARATION_GRAPH_INVALID", "Tool/Application blocker identity conflicts with the selected endpoint.")
                if f"ItToolApplication|{source_id}|{target_id}" not in edge_by_key:
                    raise SchedulerError("DELETE.PREPARATION_GRAPH_INCOMPLETE", "Tool/Application blocker lacks authoritative relation evidence.")
            else:
                raise SchedulerError("DELETE.PREPARATION_GRAPH_UNSUPPORTED", "Blocker direction is outside the signed graph compiler.")

    grouped_edges: dict[str, list[dict[str, Any]]] = {}
    for edge in sorted(edge_by_key.values(), key=canonical):
        owner = f"{edge['relationType']}|{edge['sourceObjectId']}"
        grouped_edges.setdefault(owner, []).append(edge)
    relation_descriptors: list[dict[str, Any]] = []
    for owner in sorted(grouped_edges):
        edges = grouped_edges[owner]
        first = edges[0]
        source = target_by_id[first["sourceObjectId"]]
        target_ids = sorted(set(edge["targetObjectId"] for edge in edges))
        target_values = [target_by_id[target_id] for target_id in target_ids]
        key = relation_group_key(first["relationType"], source["objectId"], target_ids)
        relation_descriptors.append({
            "key": key, "relationType": first["relationType"], "workspace": source["workspace"],
            "source": {"objectId": source["objectId"], "objectType": source["objectType"],
                       "workItemId": source["workItemId"], "workspace": source["workspace"]},
            "targets": [{"objectId": target["objectId"], "objectType": target["objectType"],
                         "workItemId": target["workItemId"], "workspace": target["workspace"]} for target in target_values],
            "affectedTargetKeys": sorted(set([target_key(source), *[target_key(target) for target in target_values]])),
        })
    gra_seeds = [gra_seed_by_key[key] for key in sorted(gra_seed_by_key)]
    selected_gra_keys = {f"GRA|{target['workspace']}|{target['objectId']}" for target in targets if target["objectType"] == "GRA"}
    derived_gra_seeds = [seed for seed in gra_seeds if seed["key"] not in selected_gra_keys]
    object_order = {"DB": 1, "OS": 2, "DCNO": 3, "TOOL": 4, "Information": 5, "APP": 6}
    nodes: list[dict[str, Any]] = []
    for descriptor in relation_descriptors:
        nodes.append({"stepId": descriptor["key"], "kind": "relation", "affectedTargetKeys": descriptor["affectedTargetKeys"]})
    for seed in gra_seeds:
        nodes.append({"stepId": seed["key"], "kind": "cascade", "affectedTargetKeys": seed["affectedTargetKeys"]})
    for target in sorted((target for target in targets if target["objectType"] != "GRA"),
                         key=lambda item: (object_order[item["objectType"]], item["objectId"])):
        nodes.append({"stepId": target_key(target), "kind": "object", "affectedTargetKeys": [target_key(target)]})
    rank = {"relation": 0, "cascade": 1, "object": 2}
    dependency_skeleton: list[dict[str, Any]] = []
    for index, node in enumerate(nodes):
        affected = set(node["affectedTargetKeys"])
        dependencies = [candidate["stepId"] for candidate in nodes[:index]
                        if rank[candidate["kind"]] < rank[node["kind"]]
                        and affected.intersection(candidate["affectedTargetKeys"])]
        dependency_skeleton.append({**node, "dependsOn": dependencies})
    body = {"schemaVersion": PREPARATION_OUTPUT_SCHEMA, "planId": plan_id, "runId": run_id,
            "graSeeds": gra_seeds, "derivedGraSeeds": derived_gra_seeds,
            "relationDescriptors": relation_descriptors, "dependencySkeleton": dependency_skeleton}
    return {**body, "compilationDigest": hashlib.sha256(canonical(body).encode("utf-8")).hexdigest()}


def normalize_steps(raw_steps: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_steps, list) or not 1 <= len(raw_steps) <= MAX_STEPS:
        raise SchedulerError("DELETE.SCHEDULER_INPUT_INVALID", "Deletion graph inventory is invalid.")
    steps: list[dict[str, Any]] = []
    step_ids: set[str] = set()
    for raw in raw_steps:
        if not isinstance(raw, dict):
            raise SchedulerError("DELETE.SCHEDULER_INPUT_INVALID", "Deletion graph step is invalid.")
        step_id = required_text(raw.get("stepId"), "stepId", 700)
        target_key = required_text(raw.get("targetKey"), "targetKey", 700)
        operation_id = required_text(raw.get("operationId"), "operationId", 200)
        effect = required_text(raw.get("effect"), "effect", 32)
        depends_on = raw.get("dependsOn")
        if effect not in {"omnia_mutation"} or not isinstance(depends_on, list) or len(depends_on) > MAX_STEPS:
            raise SchedulerError("DELETE.SCHEDULER_INPUT_INVALID", "Deletion graph effect or dependency list is invalid.")
        dependencies = [required_text(item, "dependsOn", 700) for item in depends_on]
        if step_id in step_ids or len(set(dependencies)) != len(dependencies) or step_id in dependencies:
            raise SchedulerError("DELETE.SCHEDULER_INPUT_INVALID", "Deletion graph identities or dependencies are invalid.")
        step_ids.add(step_id)
        steps.append({"stepId": step_id, "targetKey": target_key, "dependsOn": dependencies,
                      "operationId": operation_id, "effect": effect})
    for step in steps:
        if any(dependency not in step_ids for dependency in step["dependsOn"]):
            raise SchedulerError("DELETE.SCHEDULER_INPUT_INVALID", "Deletion graph contains an unknown dependency.")
    return steps


def normalize_outcomes(raw_outcomes: Any, steps: list[dict[str, Any]]) -> tuple[dict[str, dict[str, Any]], list[dict[str, Any]]]:
    if not isinstance(raw_outcomes, list) or len(raw_outcomes) > len(steps):
        raise SchedulerError("DELETE.SCHEDULER_INPUT_INVALID", "Deletion outcome inventory is invalid.")
    step_ids = {step["stepId"] for step in steps}
    step_order = {step["stepId"]: index for index, step in enumerate(steps)}
    outcomes: dict[str, dict[str, Any]] = {}
    normalized_outcomes: list[dict[str, Any]] = []
    for raw in raw_outcomes:
        if not isinstance(raw, dict):
            raise SchedulerError("DELETE.SCHEDULER_INPUT_INVALID", "Deletion outcome is invalid.")
        step_id = required_text(raw.get("stepId"), "outcome.stepId", 700)
        state = required_text(raw.get("state"), "outcome.state", 32)
        if step_id not in step_ids or step_id in outcomes or state not in OUTCOME_STATES:
            raise SchedulerError("DELETE.SCHEDULER_INPUT_INVALID", "Deletion outcome identity or state is invalid.")
        outcome = {
            "stepId": step_id,
            "state": state,
            "phase": str(raw.get("phase") or "")[:80],
            "commandId": str(raw.get("commandId") or "")[:200],
            "code": str(raw.get("code") or "")[:160],
            "message": str(raw.get("message") or "")[:800],
        }
        outcomes[step_id] = outcome
        normalized_outcomes.append(outcome)
    normalized_outcomes.sort(key=lambda item: step_order[item["stepId"]])
    return outcomes, normalized_outcomes


def dependency_skips(steps: list[dict[str, Any]], outcomes: dict[str, dict[str, Any]]) -> list[str]:
    skip_ids: list[str] = []
    failed_or_skipped = {step_id for step_id, item in outcomes.items() if item["state"] in {"failed", "skipped"}}
    changed = True
    while changed:
        changed = False
        for step in steps:
            if step["stepId"] in outcomes or step["stepId"] in skip_ids:
                continue
            if any(dependency in failed_or_skipped for dependency in step["dependsOn"]):
                skip_ids.append(step["stepId"])
                failed_or_skipped.add(step["stepId"])
                changed = True
    return skip_ids


def scheduler_input(payload: Any) -> tuple[str, str, int, list[dict[str, Any]], dict[str, dict[str, Any]], list[dict[str, Any]]]:
    if not isinstance(payload, dict) or payload.get("schemaVersion") != INPUT_SCHEMA:
        raise SchedulerError("DELETE.SCHEDULER_INPUT_INVALID", "Deletion scheduler input schema is invalid.")
    plan_id = required_text(payload.get("planId"), "planId", 200)
    run_id = required_text(payload.get("runId"), "runId", 200)
    budget = payload.get("concurrencyBudget")
    if not isinstance(budget, int) or isinstance(budget, bool) or not 1 <= budget <= 16:
        raise SchedulerError("DELETE.SCHEDULER_INPUT_INVALID", "concurrencyBudget must be an integer from 1 through 16.")
    steps = normalize_steps(payload.get("steps"))
    outcomes, normalized_outcomes = normalize_outcomes(payload.get("outcomes"), steps)
    return plan_id, run_id, budget, steps, outcomes, normalized_outcomes


def schedule(payload: Any) -> dict[str, Any]:
    plan_id, run_id, budget, steps, outcomes, normalized_outcomes = scheduler_input(payload)
    skip_ids = dependency_skips(steps, outcomes)

    uncertain = any(item["state"] == "uncertain" for item in outcomes.values())
    pending = [step for step in steps if step["stepId"] not in outcomes and step["stepId"] not in skip_ids]
    ready = [] if uncertain else [step["stepId"] for step in pending
        if all(outcomes.get(dependency, {}).get("state") == "succeeded" for dependency in step["dependsOn"])]
    completed_count = len(outcomes) + len(skip_ids)
    if uncertain:
        terminal = "uncertain"
    elif completed_count == len(steps):
        terminal = "failed" if any(item["state"] == "failed" for item in outcomes.values()) or skip_ids else "succeeded"
    else:
        terminal = "running"
    if terminal == "running" and not ready and not skip_ids:
        raise SchedulerError("DELETE.SCHEDULER_DEADLOCK", "Deletion graph has no ready or dependency-skipped step.")

    ledger = {"planId": plan_id, "runId": run_id, "steps": steps, "outcomes": normalized_outcomes}
    return {
        "schemaVersion": OUTPUT_SCHEMA,
        "planId": plan_id,
        "runId": run_id,
        "readyStepIds": ready[:budget],
        "skipStepIds": skip_ids,
        "counts": {
            "total": len(steps), "pending": len(steps) - completed_count, "ready": min(len(ready), budget),
            "succeeded": sum(item["state"] == "succeeded" for item in outcomes.values()),
            "failed": sum(item["state"] == "failed" for item in outcomes.values()),
            "skipped": sum(item["state"] == "skipped" for item in outcomes.values()) + len(skip_ids),
            "uncertain": sum(item["state"] == "uncertain" for item in outcomes.values()),
        },
        "terminal": terminal,
        "ledgerDigest": hashlib.sha256(canonical(ledger).encode("utf-8")).hexdigest(),
    }


def read_frame() -> dict[str, Any] | None:
    prefix = sys.stdin.buffer.read(4)
    if not prefix:
        return None
    if len(prefix) != 4:
        raise SchedulerError("PYTHON.FRAME_INVALID", "RPC frame prefix is incomplete.")
    length = struct.unpack(">I", prefix)[0]
    if length < 2 or length > MAX_FRAME_BYTES:
        raise SchedulerError("PYTHON.FRAME_INVALID", "RPC frame length is invalid.")
    body = sys.stdin.buffer.read(length)
    if len(body) != length:
        raise SchedulerError("PYTHON.FRAME_INVALID", "RPC frame body is incomplete.")
    value = json.loads(body.decode("utf-8"))
    if not isinstance(value, dict):
        raise SchedulerError("PYTHON.MESSAGE_INVALID", "RPC message is invalid.")
    return value


def write_frame(value: dict[str, Any]) -> None:
    body = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(body) > MAX_FRAME_BYTES:
        raise SchedulerError("PYTHON.FRAME_TOO_LARGE", "RPC response exceeds the signed frame bound.")
    sys.stdout.buffer.write(struct.pack(">I", len(body)) + body)
    sys.stdout.buffer.flush()


def main() -> int:
    if sys.version_info[:3] != (3, 13, 14) or os.environ.get("OMNIA_PYTHON_PROTOCOL") != PROTOCOL:
        return 70
    while True:
        message = read_frame()
        if message is None:
            return 0
        request_id = str(message.get("requestId") or "")
        common = {"schemaVersion": PROTOCOL, "requestId": request_id}
        kind = message.get("type")
        if kind == "hello":
            if (message.get("protocol") != PROTOCOL or message.get("pythonVersion") != "3.13.14"
                    or message.get("maxFrameBytes") != MAX_FRAME_BYTES or message.get("networkPolicy") != "deny"
                    or message.get("userSite") is not False or message.get("binaryTransfer") != "json_only"):
                raise SchedulerError("PYTHON.HANDSHAKE_MISMATCH", "Deletion scheduler runtime policy is invalid.")
            write_frame({**common, "type": "ready", "protocol": PROTOCOL, "pythonVersion": "3.13.14",
                         "networkPolicy": "deny", "userSite": False, "binaryTransfer": "json_only",
                         "maxFrameBytes": MAX_FRAME_BYTES, "capabilities": CAPABILITIES})
        elif kind == "heartbeat":
            write_frame({**common, "type": "heartbeat_ack"})
        elif kind == "shutdown":
            return 0
        elif kind == "invoke":
            try:
                method = message.get("method")
                if method not in CAPABILITIES:
                    raise SchedulerError("PYTHON.METHOD_DENIED", "Scheduler method is not signed or supported.")
                value = schedule(message.get("payload")) if method == "schedule_deletion" else compile_delete_preparation(message.get("payload"))
                write_frame({**common, "type": "result", "ok": True, "value": value})
            except SchedulerError as error:
                write_frame({**common, "type": "result", "ok": False,
                             "error": {"code": error.code, "message": str(error), "retryable": False}})
            except Exception:
                traceback.print_exc(file=sys.stderr)
                write_frame({**common, "type": "result", "ok": False,
                             "error": {"code": "PYTHON.SCHEDULER_FAILED", "message": "Deletion scheduler failed closed.", "retryable": False}})
        else:
            raise SchedulerError("PYTHON.MESSAGE_DENIED", "RPC message type is denied.")


if __name__ == "__main__":
    raise SystemExit(main())
