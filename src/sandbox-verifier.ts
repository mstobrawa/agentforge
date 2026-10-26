import type { SandboxRunner } from "./sandbox-runner.js";
import type { ProjectCheck, SandboxResult, VerificationResult, Verifier } from "./types.js";

export interface SandboxVerifierOptions {
  /** Explicit path to the prepared workspace; never taken from task text. */
  workspacePath: string;
  /** Application-owned checks; callers must not build these from agent output. */
  checks: readonly ProjectCheck[];
}

type SandboxRunnerPort = Pick<SandboxRunner, "run">;

/** Runs a fixed list of application-configured checks for one prepared workspace. */
export class SandboxVerifier implements Verifier {
  private readonly workspacePath: string;
  private readonly checks: readonly ProjectCheck[];

  constructor(
    private readonly runner: SandboxRunnerPort,
    options: SandboxVerifierOptions,
  ) {
    if (typeof options.workspacePath !== "string" || options.workspacePath.trim() === "") {
      throw new Error("SandboxVerifier requires an explicitly configured workspacePath.");
    }
    if (!Array.isArray(options.checks) || options.checks.length === 0) {
      throw new Error("SandboxVerifier requires at least one configured project check.");
    }

    this.workspacePath = options.workspacePath;
    this.checks = Object.freeze(options.checks.map((check) => Object.freeze({
      ...check,
      command: Object.freeze([...check.command]),
    })));
  }

  async verify(_task: string): Promise<VerificationResult> {
    const results: SandboxResult[] = [];
    for (const check of this.checks) {
      try {
        results.push(await this.runner.run(this.workspacePath, check));
      } catch {
        // A thrown runner failure is infrastructure failure, never a passing check.
        results.push({
          exitCode: null,
          status: "infrastructure_error",
          stdout: "",
          stderr: "",
          durationMs: 0,
          timedOut: false,
          cancelled: false,
          logsTruncated: false,
          error: "SandboxRunner failed to complete the check.",
        });
      }
    }

    const passed = results.length === this.checks.length && results.every(
      (result) => result.status === "success" && result.exitCode === 0 && !result.timedOut && !result.cancelled,
    );
    return {
      passed,
      summary: results.map((result, index) => formatResult(index + 1, result)).join("\n\n"),
    };
  }
}

function formatResult(index: number, result: SandboxResult): string {
  const exit = result.exitCode === null ? "no exit code" : `exit ${result.exitCode}`;
  const lines = [`Check ${index}: ${result.status} (${exit}, ${result.durationMs} ms)`];
  if (result.timedOut) lines.push("Timed out.");
  if (result.cancelled) lines.push("Cancelled.");
  if (result.error) lines.push(`Error: ${result.error}`);
  if (result.cleanupError) lines.push(`Cleanup error: ${result.cleanupError}`);
  if (result.stdout) lines.push(`stdout:\n${result.stdout}`);
  if (result.stderr) lines.push(`stderr:\n${result.stderr}`);
  if (result.logsTruncated) lines.push("Logs were truncated.");
  return lines.join("\n");
}
