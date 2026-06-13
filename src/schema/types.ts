export const TRACE_SCHEMA_VERSION = "0.1.0" as const;

export type TraceSource =
  | "codex"
  | "claude_code"
  | "cursor"
  | "cline"
  | "kiro"
  | "copilot"
  | "manual_json"
  | "fixture"
  | "unknown";

export type MessageRole = "user" | "assistant" | "system" | "tool";
export type ToolCallStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "unknown";
export type ToolResultStatus = "succeeded" | "failed" | "unknown";
export type FileChangeType =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "unknown";
export type CheckpointKind = "auto" | "manual";
export type CheckpointReason =
  | "before_agent"
  | "after_edit"
  | "tests_passed"
  | "pre_commit"
  | "commit"
  | "user_marked";
export type TestStatus = "passed" | "failed" | "unknown";
export type PrivacyFindingKind =
  | "api_key"
  | "access_token"
  | "ssh_key"
  | "private_key"
  | "env"
  | "cookie"
  | "session"
  | "database_url"
  | "webhook_url"
  | "internal_ip"
  | "internal_domain"
  | "email"
  | "phone"
  | "local_path"
  | "private_repo"
  | "sensitive_name"
  | "unknown";
export type PrivacySeverity = "low" | "medium" | "high" | "critical";
export type PublishVisibility = "local" | "private" | "unlisted" | "public";
export type ArtifactKind = "file" | "image" | "video" | "log" | "report" | "other";

export type JsonObject = Record<string, unknown>;

export interface WorkspaceInfo {
  name: string;
  path: string;
  repo_url?: string | null;
}

export interface Trace {
  schema_version: typeof TRACE_SCHEMA_VERSION;
  trace_id: string;
  source: TraceSource;
  source_session_id: string;
  title: string;
  summary?: string;
  workspace: WorkspaceInfo;
  started_at: string;
  ended_at?: string | null;
  messages: TraceMessage[];
  tool_calls: ToolCall[];
  tool_results: ToolResult[];
  file_changes: FileChange[];
  checkpoints: Checkpoint[];
  git: GitState;
  artifacts?: Artifact[];
  privacy_findings?: PrivacyFinding[];
  redactions?: Redaction[];
  publish?: PublishMetadata;
  metadata: JsonObject;
}

export interface TraceMessage {
  message_id: string;
  role: MessageRole;
  content: string;
  created_at: string;
  model?: string | null;
  parent_id?: string | null;
  tool_call_ids: string[];
  privacy_findings: PrivacyFinding[];
  metadata: JsonObject;
}

export interface ToolCall {
  tool_call_id: string;
  message_id?: string | null;
  name: string;
  created_at: string;
  status?: ToolCallStatus;
  arguments: JsonObject;
  metadata: JsonObject;
}

export interface ToolResult {
  tool_result_id: string;
  tool_call_id: string;
  created_at: string;
  status: ToolResultStatus;
  content: string;
  privacy_findings?: PrivacyFinding[];
  metadata: JsonObject;
}

export interface FileChange {
  file_change_id: string;
  path: string;
  change_type: FileChangeType;
  old_path?: string | null;
  language?: string | null;
  additions?: number;
  deletions?: number;
  diff?: string | null;
  metadata: JsonObject;
}

export interface GitState {
  repo_root: string | null;
  remote_url?: string | null;
  branch: string | null;
  head_sha: string | null;
  is_dirty: boolean;
  changed_files: string[];
  untracked_files: string[];
  diff?: string | null;
  commit_message?: string | null;
  pr_url?: string | null;
  issue_url?: string | null;
  test_command?: string | null;
  test_result?: TestStatus | null;
  metadata: JsonObject;
}

export interface CheckpointGitState {
  repo_root: string | null;
  branch: string | null;
  head_sha: string | null;
  hidden_ref: string | null;
  is_dirty: boolean;
}

export interface Checkpoint {
  checkpoint_id: string;
  trace_id: string;
  label: string;
  kind: CheckpointKind;
  reason: CheckpointReason;
  created_at: string;
  git: CheckpointGitState;
  diff_ref?: string | null;
  test_status: TestStatus;
  metadata: JsonObject;
}

export interface Artifact {
  artifact_id: string;
  kind: ArtifactKind;
  name: string;
  path: string | null;
  url?: string | null;
  mime_type?: string | null;
  metadata: JsonObject;
}

export interface PrivacyFinding {
  finding_id: string;
  kind: PrivacyFindingKind;
  severity: PrivacySeverity;
  location: string;
  preview: string;
  start?: number | null;
  end?: number | null;
  metadata: JsonObject;
}

export interface Redaction {
  redaction_id: string;
  finding_id: string;
  replacement: string;
  applied: boolean;
  metadata: JsonObject;
}

export interface PublishMetadata {
  visibility: PublishVisibility;
  description?: string;
  tags: string[];
  outcome?: string;
  published_url?: string | null;
  metadata: JsonObject;
}

export interface TraceSummary {
  trace_id: string;
  title: string;
  source: TraceSource;
  session_kind?: string;
  workspace: WorkspaceInfo;
  started_at: string;
  ended_at?: string | null;
  message_count: number;
  token_count: number;
  tool_call_count: number;
  file_change_count: number;
  checkpoint_count: number;
  privacy_finding_count: number;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}
