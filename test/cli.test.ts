import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.js";
import { OpenAIAgentAdapter, type OpenAIAgentTransport } from "../src/openai-agent-adapter.js";
import type { SandboxResult } from "../src/types.js";

const stagingArgs = ["--staging-root", "/staging", "--workspace", "/staging/task-1"];

function sandboxResult(overrides: Partial<SandboxResult> = {}): SandboxResult {
  return {
    exitCode: 0,
    status: "success",
    stdout: "Type check passed.",
    stderr: "",
    durationMs: 12,
    timedOut: false,
    cancelled: false,
    logsTruncated: false,
    ...overrides,
  };
}

test("rejects missing, blank, and malformed CLI arguments", async () => {
  const invalidArgs = [
    [],
    ["   ", ...stagingArgs],
    ["Task", "--report"],
    ["Task", "--report", "--other", ...stagingArgs],
    ["Task", ...stagingArgs, "--report", "a.json", "--report", "b.json"],
    ["Task", "--unknown", ...stagingArgs],
    ["Task", "--workspace", "/staging/task-1"],
    ["Task", "--staging-root", "/staging"],
    ["Task", "--staging-root", "/staging", "--workspace"],
    ["Task", ...stagingArgs, "--workspace", "/staging/other"],
    ["--openai-smoke", "unexpected-task"],
  ];

  for (const args of invalidArgs) {
    const result = await runCli(args);
    assert.equal(result.exitCode, 2, `expected usage error for ${JSON.stringify(args)}`);
    assert.match(result.stderr, /Usage:/);
    assert.equal(result.stdout, "");
  }
});

test("OpenAI smoke mode creates a temporary workspace and runs its sandbox verifier", async () => {
  let stagingRoot = "";
  let workspacePath = "";
  let verificationCalls = 0;
  const requests: Parameters<OpenAIAgentTransport["proposeFileChanges"]>[0][] = [];
  const result = await runCli(["--openai-smoke"], undefined, (root) => {
    stagingRoot = root;
    return {
      async run(workspace, check) {
        workspacePath = workspace;
        assert.equal(dirname(workspace), root);
        assert.equal(check.image, "node:24-alpine");
        assert.equal(check.command[0], "node");
        assert.match(check.command[2] ?? "", /String\.fromCharCode\(10\)/);
        const passed = readFileSync(join(workspace, "hello.txt"), "utf8") === "Hello from AgentForge.\n";
        verificationCalls += 1;
        return sandboxResult({
          status: passed ? "success" : "error",
          exitCode: passed ? 0 : 1,
          stdout: passed ? "Smoke file matches." : "Expected exactly one final LF.",
          stderr: "",
        });
      },
    };
  }, (workspace, paths) => {
    assert.deepEqual(paths, ["README.md", "hello.txt"]);
    assert.equal(readFileSync(join(workspace, "hello.txt"), "utf8"), "");
    const transport: OpenAIAgentTransport = {
      async proposeFileChanges(input) {
        requests.push(input);
        return {
          changes: [{
            operation: "replace",
            path: "hello.txt",
            content: requests.length === 1 ? "Hello from AgentForge." : "Hello from AgentForge.\n",
          }],
        };
      },
    };
    return new OpenAIAgentAdapter(workspace, transport, paths);
  });

  assert.equal(result.exitCode, 0);
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.task, "Set hello.txt to exactly `Hello from AgentForge.` followed by exactly one LF. The file already exists; return a replace change.");
  assert.deepEqual(requests[1]?.context.files.find((file) => file.path === "hello.txt"), {
    path: "hello.txt",
    content: "Hello from AgentForge.",
  });
  assert.match(requests[1]?.previousFailure ?? "", /Expected exactly one final LF/);
  assert.equal(verificationCalls, 2);
  assert.equal(JSON.parse(result.stdout).attempts, 2);
  assert.equal(existsSync(join(workspacePath, "README.md")), false);
  assert.equal(existsSync(stagingRoot), false);
  const report = JSON.parse(result.stdout) as { execution: string; workspace: string; status: string };
  assert.deepEqual(report, { ...report, execution: "openai_smoke", workspace: "temporary", status: "succeeded" });
});

test("configures SandboxVerifier with the explicit workspace and application-owned check", async () => {
  const roots: string[] = [];
  const calls: { workspacePath: string; image: string; command: readonly string[] }[] = [];
  const result = await runCli(["Check this project", ...stagingArgs], undefined, (stagingRoot) => {
    roots.push(stagingRoot);
    return {
      async run(workspacePath, check) {
        calls.push({ workspacePath, image: check.image, command: check.command });
        return sandboxResult();
      },
    };
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(roots, ["/staging"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.workspacePath, "/staging/task-1");
  assert.equal(calls[0]?.image, "node:24-alpine");
  assert.deepEqual(calls[0]?.command, ["./node_modules/.bin/tsc", "--noEmit", "-p", "tsconfig.json"]);

  const report = JSON.parse(result.stdout) as {
    status: string;
    implementation: { performed: boolean; message: string };
  };
  assert.equal(report.status, "verification_only");
  assert.equal(report.implementation.performed, false);
  assert.match(report.implementation.message, /does not modify the workspace/);
});

test("returns a failing exit code and report when configured verification fails", async () => {
  let calls = 0;
  const result = await runCli(["Check this project", ...stagingArgs], undefined, () => ({
    async run() {
      calls += 1;
      return sandboxResult({ status: "error", exitCode: 2, stdout: "", stderr: "Type check failed." });
    },
  }));

  assert.equal(result.exitCode, 1);
  const report = JSON.parse(result.stdout) as {
    status: string;
    attempts: number;
    implementation: { performed: boolean; message: string };
    verificationResults: { passed: boolean; summary: string }[];
  };
  assert.equal(report.status, "failed");
  assert.equal(report.attempts, 3);
  assert.equal(calls, 3);
  assert.equal(report.verificationResults.at(-1)?.passed, false);
  assert.match(report.verificationResults.at(-1)?.summary ?? "", /Type check failed/);
  assert.equal(report.implementation.performed, false);
});

test("reports file write failure without printing a success report", async () => {
  const result = await runCli(["A valid task", ...stagingArgs, "--report", "report.json"], async () => {
    throw new Error("secret path details");
  }, () => ({ run: async () => sandboxResult() }));

  assert.equal(result.exitCode, 1);
  assert.match(result.stderr, /Unable to write the report file/);
  assert.equal(result.stdout, "");
});
