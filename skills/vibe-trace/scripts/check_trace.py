#!/usr/bin/env python3
"""Validate a Vibe Trace JSON file."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any


SKILL_DIR = Path(__file__).resolve().parents[1]
SCHEMA_PATH = SKILL_DIR / "references" / "trace.schema.json"

TOP_REQUIRED = (
    "schema_version",
    "trace_id",
    "source",
    "source_session_id",
    "title",
    "workspace",
    "started_at",
    "messages",
    "tool_calls",
    "tool_results",
    "file_changes",
    "checkpoints",
    "git",
    "metadata",
)

SOURCES = {"codex", "claude_code", "cursor", "cline", "kiro", "copilot", "manual_json", "fixture", "unknown"}
ROLES = {"user", "assistant", "system", "tool"}
TOOL_CALL_STATUSES = {"pending", "running", "succeeded", "failed", "unknown"}
TOOL_RESULT_STATUSES = {"succeeded", "failed", "unknown"}
FILE_CHANGE_TYPES = {"added", "modified", "deleted", "renamed", "unknown"}
CHECKPOINT_KINDS = {"auto", "manual"}
CHECKPOINT_REASONS = {"before_agent", "after_edit", "tests_passed", "pre_commit", "commit", "user_marked"}
TEST_STATUSES = {"passed", "failed", "unknown"}
FINDING_KINDS = {
    "api_key",
    "access_token",
    "ssh_key",
    "private_key",
    "env",
    "cookie",
    "session",
    "database_url",
    "webhook_url",
    "internal_ip",
    "internal_domain",
    "email",
    "phone",
    "local_path",
    "private_repo",
    "sensitive_name",
    "unknown",
}
SEVERITIES = {"low", "medium", "high", "critical"}
VISIBILITIES = {"local", "private", "unlisted", "public"}


def load_json(path: str) -> Any:
    raw = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    return json.loads(raw)


def jsonschema_errors(value: Any) -> list[str] | None:
    try:
        from jsonschema import Draft202012Validator, FormatChecker
    except ModuleNotFoundError:
        return None

    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = []
    for error in sorted(validator.iter_errors(value), key=lambda item: list(item.path)):
        location = "/" + "/".join(str(part) for part in error.path)
        errors.append(f"{location} {error.message}")
    return errors


def is_object(value: Any) -> bool:
    return isinstance(value, dict)


def is_array(value: Any) -> bool:
    return isinstance(value, list)


def require_object(value: Any, path: str, errors: list[str]) -> bool:
    if not is_object(value):
        errors.append(f"{path} must be an object")
        return False
    return True


def require_array(value: Any, path: str, errors: list[str]) -> bool:
    if not is_array(value):
        errors.append(f"{path} must be an array")
        return False
    return True


def require_fields(obj: dict[str, Any], fields: tuple[str, ...], path: str, errors: list[str]) -> None:
    for field in fields:
        if field not in obj:
            errors.append(f"{path}/{field} is required")


def check_enum(value: Any, allowed: set[str], path: str, errors: list[str], nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if value not in allowed:
        errors.append(f"{path} must be one of {sorted(allowed)}")


def check_datetime(value: Any, path: str, errors: list[str], nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if not isinstance(value, str):
        errors.append(f"{path} must be an ISO date-time string")
        return
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        errors.append(f"{path} must be a valid ISO date-time")


def check_privacy_findings(value: Any, path: str, errors: list[str]) -> None:
    if not require_array(value, path, errors):
        return
    for index, finding in enumerate(value):
        item_path = f"{path}/{index}"
        if not require_object(finding, item_path, errors):
            continue
        require_fields(
            finding,
            ("finding_id", "kind", "severity", "location", "preview", "metadata"),
            item_path,
            errors,
        )
        if "kind" in finding:
            check_enum(finding["kind"], FINDING_KINDS, f"{item_path}/kind", errors)
        if "severity" in finding:
            check_enum(finding["severity"], SEVERITIES, f"{item_path}/severity", errors)
        if "metadata" in finding and not is_object(finding["metadata"]):
            errors.append(f"{item_path}/metadata must be an object")


def fallback_errors(trace: Any) -> list[str]:
    errors: list[str] = []
    if not require_object(trace, "/", errors):
        return errors

    require_fields(trace, TOP_REQUIRED, "", errors)
    if trace.get("schema_version") != "0.1.0":
        errors.append("/schema_version must be 0.1.0")
    if "source" in trace:
        check_enum(trace["source"], SOURCES, "/source", errors)
    check_datetime(trace.get("started_at"), "/started_at", errors)
    check_datetime(trace.get("ended_at"), "/ended_at", errors, nullable=True)

    workspace = trace.get("workspace")
    if require_object(workspace, "/workspace", errors):
        require_fields(workspace, ("name", "path"), "/workspace", errors)

    message_ids: set[str] = set()
    tool_call_ids: set[str] = set()

    messages = trace.get("messages", [])
    if require_array(messages, "/messages", errors):
        for index, message in enumerate(messages):
            path = f"/messages/{index}"
            if not require_object(message, path, errors):
                continue
            require_fields(
                message,
                ("message_id", "role", "content", "created_at", "tool_call_ids", "privacy_findings", "metadata"),
                path,
                errors,
            )
            message_id = message.get("message_id")
            if isinstance(message_id, str):
                if message_id in message_ids:
                    errors.append(f"{path}/message_id duplicates {message_id}")
                message_ids.add(message_id)
            if "role" in message:
                check_enum(message["role"], ROLES, f"{path}/role", errors)
            check_datetime(message.get("created_at"), f"{path}/created_at", errors)
            if "tool_call_ids" in message and not is_array(message["tool_call_ids"]):
                errors.append(f"{path}/tool_call_ids must be an array")
            if "privacy_findings" in message:
                check_privacy_findings(message["privacy_findings"], f"{path}/privacy_findings", errors)
            if "metadata" in message and not is_object(message["metadata"]):
                errors.append(f"{path}/metadata must be an object")

    tool_calls = trace.get("tool_calls", [])
    if require_array(tool_calls, "/tool_calls", errors):
        for index, call in enumerate(tool_calls):
            path = f"/tool_calls/{index}"
            if not require_object(call, path, errors):
                continue
            require_fields(call, ("tool_call_id", "name", "created_at", "arguments", "metadata"), path, errors)
            call_id = call.get("tool_call_id")
            if isinstance(call_id, str):
                if call_id in tool_call_ids:
                    errors.append(f"{path}/tool_call_id duplicates {call_id}")
                tool_call_ids.add(call_id)
            if call.get("message_id") is not None and call.get("message_id") not in message_ids:
                errors.append(f"{path}/message_id does not match a message")
            check_datetime(call.get("created_at"), f"{path}/created_at", errors)
            if "status" in call:
                check_enum(call["status"], TOOL_CALL_STATUSES, f"{path}/status", errors)
            if "arguments" in call and not is_object(call["arguments"]):
                errors.append(f"{path}/arguments must be an object")
            if "metadata" in call and not is_object(call["metadata"]):
                errors.append(f"{path}/metadata must be an object")

    for index, message in enumerate(messages if isinstance(messages, list) else []):
        if not isinstance(message, dict) or not isinstance(message.get("tool_call_ids"), list):
            continue
        for call_id in message["tool_call_ids"]:
            if call_id not in tool_call_ids:
                errors.append(f"/messages/{index}/tool_call_ids references missing tool call {call_id}")

    tool_results = trace.get("tool_results", [])
    if require_array(tool_results, "/tool_results", errors):
        for index, result in enumerate(tool_results):
            path = f"/tool_results/{index}"
            if not require_object(result, path, errors):
                continue
            require_fields(result, ("tool_result_id", "tool_call_id", "created_at", "status", "content", "metadata"), path, errors)
            if result.get("tool_call_id") not in tool_call_ids:
                errors.append(f"{path}/tool_call_id does not match a tool call")
            check_datetime(result.get("created_at"), f"{path}/created_at", errors)
            if "status" in result:
                check_enum(result["status"], TOOL_RESULT_STATUSES, f"{path}/status", errors)
            if "privacy_findings" in result:
                check_privacy_findings(result["privacy_findings"], f"{path}/privacy_findings", errors)

    file_changes = trace.get("file_changes", [])
    if require_array(file_changes, "/file_changes", errors):
        for index, change in enumerate(file_changes):
            path = f"/file_changes/{index}"
            if not require_object(change, path, errors):
                continue
            require_fields(change, ("file_change_id", "path", "change_type", "metadata"), path, errors)
            if "change_type" in change:
                check_enum(change["change_type"], FILE_CHANGE_TYPES, f"{path}/change_type", errors)
            for number_field in ("additions", "deletions"):
                if number_field in change and (not isinstance(change[number_field], int) or change[number_field] < 0):
                    errors.append(f"{path}/{number_field} must be a non-negative integer")

    git = trace.get("git")
    if require_object(git, "/git", errors):
        require_fields(git, ("repo_root", "branch", "head_sha", "is_dirty", "changed_files", "untracked_files", "metadata"), "/git", errors)
        if "changed_files" in git and not is_array(git["changed_files"]):
            errors.append("/git/changed_files must be an array")
        if "untracked_files" in git and not is_array(git["untracked_files"]):
            errors.append("/git/untracked_files must be an array")
        if "test_result" in git:
            check_enum(git["test_result"], TEST_STATUSES, "/git/test_result", errors, nullable=True)

    checkpoints = trace.get("checkpoints", [])
    if require_array(checkpoints, "/checkpoints", errors):
        for index, checkpoint in enumerate(checkpoints):
            path = f"/checkpoints/{index}"
            if not require_object(checkpoint, path, errors):
                continue
            require_fields(
                checkpoint,
                ("checkpoint_id", "trace_id", "label", "kind", "reason", "created_at", "git", "test_status", "metadata"),
                path,
                errors,
            )
            if checkpoint.get("trace_id") != trace.get("trace_id"):
                errors.append(f"{path}/trace_id must match /trace_id")
            if "kind" in checkpoint:
                check_enum(checkpoint["kind"], CHECKPOINT_KINDS, f"{path}/kind", errors)
            if "reason" in checkpoint:
                check_enum(checkpoint["reason"], CHECKPOINT_REASONS, f"{path}/reason", errors)
            if "test_status" in checkpoint:
                check_enum(checkpoint["test_status"], TEST_STATUSES, f"{path}/test_status", errors)
            check_datetime(checkpoint.get("created_at"), f"{path}/created_at", errors)
            cp_git = checkpoint.get("git")
            if require_object(cp_git, f"{path}/git", errors):
                require_fields(cp_git, ("repo_root", "branch", "head_sha", "hidden_ref", "is_dirty"), f"{path}/git", errors)

    if "privacy_findings" in trace:
        check_privacy_findings(trace["privacy_findings"], "/privacy_findings", errors)

    publish = trace.get("publish")
    if publish is not None and require_object(publish, "/publish", errors):
        require_fields(publish, ("visibility", "tags", "metadata"), "/publish", errors)
        if "visibility" in publish:
            check_enum(publish["visibility"], VISIBILITIES, "/publish/visibility", errors)
        if "tags" in publish and not is_array(publish["tags"]):
            errors.append("/publish/tags must be an array")

    if "metadata" in trace and not is_object(trace["metadata"]):
        errors.append("/metadata must be an object")

    return errors


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("trace", help="Trace JSON path, or '-' for stdin.")
    parser.add_argument("--json", action="store_true", help="Print machine-readable validation output.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        trace = load_json(args.trace)
    except Exception as exc:  # noqa: BLE001
        errors = [f"failed to read JSON: {exc}"]
    else:
        errors = []
        schema_result = jsonschema_errors(trace)
        if schema_result is not None:
            errors.extend(f"schema: {item}" for item in schema_result)
        errors.extend(f"structural: {item}" for item in fallback_errors(trace))

    if args.json:
        print(json.dumps({"ok": not errors, "errors": errors}, indent=2))
    elif errors:
        print("Invalid Vibe Trace:")
        for error in errors:
            print(f"- {error}")
    else:
        print("Valid Vibe Trace")

    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
