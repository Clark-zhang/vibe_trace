import type { Trace, TraceSource, ValidationResult } from "../schema/types.js";

export interface DetectResult {
  found: boolean;
  path?: string;
  session_count?: number;
  message?: string;
}

export interface SourceSessionSummary {
  source: TraceSource;
  source_session_id: string;
  title: string;
  started_at?: string;
  workspace_path?: string;
  raw_path?: string;
}

export interface AgentAdapter {
  source: TraceSource;
  detect(): Promise<DetectResult>;
  listSessions(): Promise<SourceSessionSummary[]>;
  importSession(sessionId: string): Promise<Trace>;
  validateRaw?(raw: unknown): Promise<ValidationResult>;
}
