import type {
  AgentAdapter,
  RunReport,
  VerificationResult,
  Verifier,
  WorkflowState,
} from "./types.js";

const MAX_REPAIR_ATTEMPTS = 2;

const allowedTransitions: Record<WorkflowState, WorkflowState[]> = {
  idle: ["implementing"],
  implementing: ["verifying", "failed"],
  verifying: ["repairing", "succeeded", "failed"],
  repairing: ["implementing"],
  succeeded: [],
  failed: [],
};

export class Orchestrator {
  constructor(
    private readonly agent: AgentAdapter,
    private readonly verifier: Verifier,
    private readonly now: () => number = Date.now,
  ) {}

  async run(task: string): Promise<RunReport> {
    const startedAt = this.now();
    let state: WorkflowState = "idle";
    const stateHistory: WorkflowState[] = [state];
    const verificationResults: VerificationResult[] = [];
    let attempts = 0;
    let previousFailure: string | undefined;

    const transition = (next: WorkflowState): void => {
      if (!allowedTransitions[state].includes(next)) {
        throw new Error(`Invalid workflow transition: ${state} -> ${next}`);
      }
      state = next;
      stateHistory.push(state);
    };

    const makeReport = (
      status: "succeeded" | "failed",
      error?: RunReport["error"],
    ): RunReport => ({
      task,
      status,
      attempts,
      verificationResults,
      stateHistory,
      durationMs: Math.max(0, this.now() - startedAt),
      ...(error ? { error } : {}),
    });

    while (true) {
      transition("implementing");
      attempts += 1;
      try {
        await this.agent.implement(task, previousFailure);
      } catch {
        transition("failed");
        return makeReport("failed", {
          source: "agent",
          message: "Agent implementation failed.",
        });
      }

      transition("verifying");
      let result: VerificationResult;
      try {
        result = await this.verifier.verify(task);
      } catch {
        transition("failed");
        return makeReport("failed", {
          source: "verifier",
          message: "Verification could not be completed.",
        });
      }
      verificationResults.push(result);

      if (result.passed) {
        transition("succeeded");
        return makeReport("succeeded");
      }

      previousFailure = result.summary;
      if (attempts <= MAX_REPAIR_ATTEMPTS) {
        transition("repairing");
      } else {
        transition("failed");
        return makeReport("failed");
      }
    }
  }
}
