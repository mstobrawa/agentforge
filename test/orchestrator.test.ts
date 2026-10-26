import assert from "node:assert/strict";
import test from "node:test";
import { Orchestrator } from "../src/orchestrator.js";
import type { AgentAdapter, VerificationResult, Verifier } from "../src/types.js";

class CountingAgent implements AgentAdapter {
  calls = 0;
  previousFailures: (string | undefined)[] = [];
  async implement(_task: string, previousFailure?: string): Promise<void> {
    this.calls += 1;
    this.previousFailures.push(previousFailure);
  }
}

class SequenceVerifier implements Verifier {
  calls = 0;
  constructor(private readonly results: VerificationResult[]) {}
  async verify(_task: string): Promise<VerificationResult> {
    const result = this.results[this.calls];
    this.calls += 1;
    if (!result) throw new Error("Verifier result sequence exhausted");
    return result;
  }
}

const pass = { passed: true, summary: "Checks passed" };
const fail = { passed: false, summary: "Checks failed" };

test("succeeds after the initial implementation", async () => {
  const agent = new CountingAgent();
  const verifier = new SequenceVerifier([pass]);
  const report = await new Orchestrator(agent, verifier, () => 100).run("Add feature");

  assert.equal(report.status, "succeeded");
  assert.equal(report.attempts, 1);
  assert.deepEqual(report.verificationResults, [pass]);
  assert.deepEqual(report.stateHistory, ["idle", "implementing", "verifying", "succeeded"]);
  assert.equal(report.durationMs, 0);
  assert.equal(agent.calls, 1);
  assert.equal(verifier.calls, 1);
});

test("succeeds after a repair fixes the failed verification", async () => {
  const agent = new CountingAgent();
  const verifier = new SequenceVerifier([fail, pass]);
  const report = await new Orchestrator(agent, verifier).run("Add feature");

  assert.equal(report.status, "succeeded");
  assert.equal(report.attempts, 2);
  assert.equal(report.verificationResults.length, 2);
  assert.equal(agent.calls, 2);
  assert.deepEqual(agent.previousFailures, [undefined, fail.summary]);
  assert.deepEqual(report.stateHistory, [
    "idle", "implementing", "verifying", "repairing", "implementing", "verifying", "succeeded",
  ]);
});

test("stops after two repair attempts following the initial implementation", async () => {
  const agent = new CountingAgent();
  const verifier = new SequenceVerifier([fail, fail, fail]);
  const report = await new Orchestrator(agent, verifier).run("Add feature");

  assert.equal(report.status, "failed");
  assert.equal(report.attempts, 3);
  assert.equal(report.verificationResults.length, 3);
  assert.deepEqual(report.verificationResults, [fail, fail, fail]);
  assert.deepEqual(report.stateHistory, [
    "idle", "implementing", "verifying", "repairing", "implementing",
    "verifying", "repairing", "implementing", "verifying", "failed",
  ]);
  assert.equal(agent.calls, 3);
  assert.equal(verifier.calls, 3);
});

test("agent exception returns a failed infrastructure report without repair or leaked details", async () => {
  const secret = "token=super-secret";
  const agent: AgentAdapter = {
    async implement() { throw new Error(secret); },
  };
  const verifier = new SequenceVerifier([pass]);
  const report = await new Orchestrator(agent, verifier).run("Add feature");

  assert.equal(report.status, "failed");
  assert.equal(report.attempts, 1);
  assert.deepEqual(report.verificationResults, []);
  assert.deepEqual(report.stateHistory, ["idle", "implementing", "failed"]);
  assert.deepEqual(report.error, { source: "agent", message: "Agent implementation failed." });
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(verifier.calls, 0);
});

test("verifier exception returns a failed infrastructure report without retry or leaked details", async () => {
  const secret = "token=super-secret";
  const agent = new CountingAgent();
  const verifier: Verifier = {
    async verify() { throw new Error(secret); },
  };
  const report = await new Orchestrator(agent, verifier).run("Add feature");

  assert.equal(report.status, "failed");
  assert.equal(report.attempts, 1);
  assert.deepEqual(report.verificationResults, []);
  assert.deepEqual(report.stateHistory, ["idle", "implementing", "verifying", "failed"]);
  assert.deepEqual(report.error, { source: "verifier", message: "Verification could not be completed." });
  assert.equal(JSON.stringify(report).includes(secret), false);
  assert.equal(agent.calls, 1);
});
