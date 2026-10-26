import type { AgentAdapter, VerificationResult, Verifier } from "./types.js";

/** No code is generated or executed; this is a placeholder for a future adapter. */
export class StubAgentAdapter implements AgentAdapter {
  async implement(_task: string, _previousFailure?: string): Promise<void> {}
}

/** Placeholder verifier that reports a passing result without running commands. */
export class StubVerifier implements Verifier {
  async verify(_task: string): Promise<VerificationResult> {
    return { passed: true, summary: "Stub verification passed (no checks executed)." };
  }
}
