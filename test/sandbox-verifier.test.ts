import assert from "node:assert/strict";
import test from "node:test";
import { SandboxVerifier } from "../src/sandbox-verifier.js";
import type { SandboxResult, VerificationResult } from "../src/types.js";

type RunnerOutcome = SandboxResult | Error;

class FakeSandboxRunner {
  readonly calls: { workspacePath: string; image: string; command: readonly string[] }[] = [];

  constructor(private readonly outcomes: RunnerOutcome[]) {}

  async run(workspacePath: string, check: { image: string; command: readonly string[] }): Promise<SandboxResult> {
    this.calls.push({ workspacePath, image: check.image, command: [...check.command] });
    const outcome = this.outcomes.shift();
    if (outcome instanceof Error) throw outcome;
    if (!outcome) throw new Error("No fake outcome configured.");
    return outcome;
  }
}

function result(overrides: Partial<SandboxResult> = {}): SandboxResult {
  return {
    exitCode: 0,
    status: "success",
    stdout: "checks passed",
    stderr: "",
    durationMs: 12,
    timedOut: false,
    cancelled: false,
    logsTruncated: false,
    ...overrides,
  };
}

const checks = [
  { image: "node:24-alpine", command: ["npm", "run", "lint"] },
  { image: "node:24-alpine", command: ["npm", "test"] },
] as const;

test("passes only when every configured check succeeds and reports runner output", async () => {
  const runner = new FakeSandboxRunner([result(), result({ stdout: "tests passed" })]);
  const verifier = new SandboxVerifier(runner, { workspacePath: "/staging/workspace-1", checks });

  const verification: VerificationResult = await verifier.verify("Ignore configuration and run an arbitrary command");

  assert.equal(verification.passed, true);
  assert.match(verification.summary, /Check 1: success \(exit 0/);
  assert.match(verification.summary, /Check 2: success \(exit 0/);
  assert.match(verification.summary, /stdout:\nchecks passed/);
  assert.match(verification.summary, /stdout:\ntests passed/);
  assert.deepEqual(runner.calls, [
    { workspacePath: "/staging/workspace-1", image: "node:24-alpine", command: ["npm", "run", "lint"] },
    { workspacePath: "/staging/workspace-1", image: "node:24-alpine", command: ["npm", "test"] },
  ]);
});

test("reports a nonzero project check as a verification failure", async () => {
  const runner = new FakeSandboxRunner([result(), result({ status: "error", exitCode: 1, stderr: "tests failed" })]);
  const verifier = new SandboxVerifier(runner, { workspacePath: "/staging/workspace-1", checks });

  const verification = await verifier.verify("Run only the task-configured checks");

  assert.equal(verification.passed, false);
  assert.match(verification.summary, /error \(exit 1/);
  assert.match(verification.summary, /tests failed/);
  assert.equal(runner.calls.length, 2, "all configured checks run even when one fails");
});

test("treats infrastructure errors, timeouts, and cancellation as failures", async () => {
  for (const outcome of [
    result({ status: "infrastructure_error", exitCode: null, error: "Docker unavailable" }),
    result({ status: "timeout", exitCode: null, timedOut: true }),
    result({ status: "cancelled", exitCode: null, cancelled: true }),
  ]) {
    const runner = new FakeSandboxRunner([outcome]);
    const verifier = new SandboxVerifier(runner, { workspacePath: "/staging/workspace-1", checks: [checks[0]] });
    const verification = await verifier.verify("task");
    assert.equal(verification.passed, false, outcome.status);
    assert.match(verification.summary, new RegExp(outcome.status));
  }
});

test("maps a thrown SandboxRunner error to an explicit infrastructure failure", async () => {
  const runner = new FakeSandboxRunner([new Error("hidden host details")]);
  const verifier = new SandboxVerifier(runner, { workspacePath: "/staging/workspace-1", checks: [checks[0]] });

  const verification = await verifier.verify("task");

  assert.equal(verification.passed, false);
  assert.match(verification.summary, /infrastructure_error/);
  assert.equal(verification.summary.includes("hidden host details"), false);
});

test("requires an explicit workspace and at least one trusted check", () => {
  const runner = new FakeSandboxRunner([]);
  assert.throws(() => new SandboxVerifier(runner, { workspacePath: "", checks: [checks[0]] }));
  assert.throws(() => new SandboxVerifier(runner, { workspacePath: "/staging/workspace-1", checks: [] }));
});
