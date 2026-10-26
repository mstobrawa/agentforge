import assert from "node:assert/strict";
import test from "node:test";
import { Orchestrator } from "../src/orchestrator.js";
import { SandboxVerifier } from "../src/sandbox-verifier.js";
import type { AgentAdapter, ProjectCheck, SandboxResult } from "../src/types.js";

class RepairingAgent implements AgentAdapter {
  readonly previousFailures: (string | undefined)[] = [];

  constructor(private readonly events: string[]) {}

  async implement(_task: string, previousFailure?: string): Promise<void> {
    this.events.push(`implement:${this.previousFailures.length + 1}`);
    this.previousFailures.push(previousFailure);
  }
}

class SequencedSandboxRunner {
  readonly calls: { workspacePath: string; check: ProjectCheck }[] = [];

  constructor(
    private readonly events: string[],
    private readonly results: SandboxResult[],
  ) {}

  async run(workspacePath: string, check: ProjectCheck): Promise<SandboxResult> {
    this.events.push(`check:${this.calls.length + 1}`);
    this.calls.push({ workspacePath, check });
    const result = this.results.shift();
    if (!result) throw new Error("Sandbox result sequence exhausted.");
    return result;
  }
}

const failure: SandboxResult = {
  exitCode: 1,
  status: "error",
  stdout: "",
  stderr: "TypeScript check failed: missing return type.",
  durationMs: 20,
  timedOut: false,
  cancelled: false,
  logsTruncated: false,
};

const success: SandboxResult = {
  exitCode: 0,
  status: "success",
  stdout: "All checks passed.",
  stderr: "",
  durationMs: 18,
  timedOut: false,
  cancelled: false,
  logsTruncated: false,
};

test("Orchestrator sends SandboxVerifier failure to the agent and succeeds after repair", async () => {
  const events: string[] = [];
  const agent = new RepairingAgent(events);
  const runner = new SequencedSandboxRunner(events, [failure, success]);
  const verifier = new SandboxVerifier(runner, {
    workspacePath: "/staging/task-123",
    checks: [{ image: "node:24-alpine", command: ["npm", "test"] }],
  });

  const report = await new Orchestrator(agent, verifier).run("Implement the feature");

  assert.equal(report.status, "succeeded");
  assert.equal(report.attempts, 2);
  assert.ok(report.attempts <= 3, "the existing initial attempt plus two-repair limit is respected");
  assert.equal(report.verificationResults.length, 2);
  assert.equal(report.verificationResults[0]?.passed, false);
  assert.match(report.verificationResults[0]?.summary ?? "", /TypeScript check failed: missing return type/);
  assert.equal(report.verificationResults[1]?.passed, true);
  assert.match(report.verificationResults[1]?.summary ?? "", /All checks passed/);
  assert.equal(agent.previousFailures[0], undefined);
  assert.equal(agent.previousFailures[1], report.verificationResults[0]?.summary);
  assert.deepEqual(events, ["implement:1", "check:1", "implement:2", "check:2"]);
  assert.deepEqual(report.stateHistory, [
    "idle", "implementing", "verifying", "repairing",
    "implementing", "verifying", "succeeded",
  ]);
  assert.equal(runner.calls.length, 2);
  assert.ok(runner.calls.every((call) => call.workspacePath === "/staging/task-123"));
  assert.ok(runner.calls.every((call) => call.check.image === "node:24-alpine"));
});
