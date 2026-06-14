#!/usr/bin/env python3
"""Create a Vibe Trace JSON skeleton."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path


SOURCES = (
    "codex",
    "claude_code",
    "cursor",
    "cline",
    "kiro",
    "copilot",
    "manual_json",
    "fixture",
    "unknown",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def run_git(args: list[str], cwd: Path) -> str | None:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=cwd,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            timeout=3,
            check=True,
        )
    except (FileNotFoundError, subprocess.SubprocessError):
        return None
    return result.stdout.strip()


def git_state(cwd: Path) -> dict[str, object]:
    repo_root = run_git(["rev-parse", "--show-toplevel"], cwd)
    if not repo_root:
        return {
            "repo_root": None,
            "remote_url": None,
            "branch": None,
            "head_sha": None,
            "is_dirty": False,
            "changed_files": [],
            "untracked_files": [],
            "diff": None,
            "commit_message": None,
            "pr_url": None,
            "issue_url": None,
            "test_command": None,
            "test_result": None,
            "metadata": {},
        }

    root = Path(repo_root)
    status = run_git(["status", "--porcelain"], root) or ""
    changed_files: list[str] = []
    untracked_files: list[str] = []
    for line in status.splitlines():
        if not line:
            continue
        path = line[3:].strip()
        if line.startswith("?? "):
            untracked_files.append(path)
        else:
            changed_files.append(path)

    return {
        "repo_root": repo_root,
        "remote_url": run_git(["config", "--get", "remote.origin.url"], root),
        "branch": run_git(["branch", "--show-current"], root),
        "head_sha": run_git(["rev-parse", "HEAD"], root),
        "is_dirty": bool(status),
        "changed_files": changed_files,
        "untracked_files": untracked_files,
        "diff": None,
        "commit_message": None,
        "pr_url": None,
        "issue_url": None,
        "test_command": None,
        "test_result": None,
        "metadata": {},
    }


def build_trace(args: argparse.Namespace) -> dict[str, object]:
    now = utc_now()
    trace_id = args.trace_id or f"trace_{uuid.uuid4().hex}"
    source_session_id = args.source_session_id or f"manual-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    workspace_path = str(Path(args.workspace_path).expanduser().resolve())
    workspace_name = args.workspace_name or Path(workspace_path).name or "workspace"
    git = git_state(Path(workspace_path)) if not args.no_git else git_state(Path("/"))

    messages = []
    if args.message:
        messages.append(
            {
                "message_id": f"msg_{uuid.uuid4().hex}",
                "role": "user",
                "content": args.message,
                "created_at": now,
                "model": None,
                "parent_id": None,
                "tool_call_ids": [],
                "privacy_findings": [],
                "metadata": {},
            }
        )

    return {
        "schema_version": "0.1.0",
        "trace_id": trace_id,
        "source": args.source,
        "source_session_id": source_session_id,
        "title": args.title,
        "summary": args.summary,
        "workspace": {
            "name": workspace_name,
            "path": workspace_path,
            "repo_url": args.repo_url,
        },
        "started_at": args.started_at or now,
        "ended_at": args.ended_at,
        "messages": messages,
        "tool_calls": [],
        "tool_results": [],
        "file_changes": [],
        "checkpoints": [],
        "git": git,
        "artifacts": [],
        "privacy_findings": [],
        "redactions": [],
        "publish": {
            "visibility": "local",
            "description": "",
            "tags": [],
            "outcome": "",
            "published_url": None,
            "metadata": {},
        },
        "metadata": {},
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--title", required=True, help="Trace title.")
    parser.add_argument("--source", choices=SOURCES, default="manual_json")
    parser.add_argument("--source-session-id")
    parser.add_argument("--trace-id")
    parser.add_argument("--summary", default="")
    parser.add_argument("--workspace-name")
    parser.add_argument("--workspace-path", default=".")
    parser.add_argument("--repo-url")
    parser.add_argument("--started-at", help="ISO 8601 date-time. Defaults to now.")
    parser.add_argument("--ended-at", help="ISO 8601 date-time or omit for null.")
    parser.add_argument("--message", help="Optional first user message.")
    parser.add_argument("--no-git", action="store_true", help="Do not inspect Git state.")
    parser.add_argument("--out", help="Output file. Defaults to stdout.")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    trace = build_trace(args)
    data = json.dumps(trace, indent=2, ensure_ascii=False) + "\n"
    if args.out:
        Path(args.out).write_text(data, encoding="utf-8")
    else:
        sys.stdout.write(data)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
