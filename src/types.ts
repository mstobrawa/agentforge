export type WorkflowState =
  | "idle"
  | "implementing"
  | "verifying"
  | "repairing"
  | "succeeded"
  | "failed";

export interface VerificationResult {
  passed: boolean;
  summary: string;
}

export interface RunReport {
  task: string;
  status: "succeeded" | "failed";
  attempts: number;
  verificationResults: VerificationResult[];
  stateHistory: WorkflowState[];
  durationMs: number;
  error?: {
    source: "agent" | "verifier";
    message: string;
  };
}

export interface AgentAdapter {
  implement(task: string, previousFailure?: string): Promise<void>;
}

export interface FileChange {
  operation: "create" | "replace";
  path: string;
  content: string;
}

export interface FileChangeProposal {
  changes: readonly FileChange[];
}

export interface Verifier {
  verify(task: string): Promise<VerificationResult>;
}

/**
 * Runtime-validated check configuration. `image` accepts a conservative Docker
 * reference: lowercase repository components, optional registry host/port,
 * optional tag, and optional sha256 digest. It is not a Docker CLI argument.
 */
export interface ProjectCheck {
  image: string;
  command: readonly string[];
  timeoutMs?: number;
}

export interface SandboxResult {
  exitCode: number | null;
  status: "success" | "error" | "timeout" | "cancelled" | "infrastructure_error";
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  logsTruncated: boolean;
  error?: string;
  cleanupError?: string;
}
