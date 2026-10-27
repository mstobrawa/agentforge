import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { SandboxRunner } from "./sandbox-runner.js";
import { SandboxVerifier } from "./sandbox-verifier.js";
import type { ProjectCheck } from "./types.js";
import { Orchestrator } from "./orchestrator.js";
import { StubAgentAdapter } from "./stubs.js";
import { createOpenAIAgentAdapter } from "./openai-api-transport.js";
import type { AgentAdapter } from "./types.js";

const PROJECT_CHECKS: readonly ProjectCheck[] = Object.freeze([
  Object.freeze({
    image: "node:24-alpine",
    // No installation is performed. The prepared workspace must already have
    // its project dependencies; --noEmit keeps this check compatible with the
    // runner's read-only workspace mount.
    command: Object.freeze(["./node_modules/.bin/tsc", "--noEmit", "-p", "tsconfig.json"]),
  }),
]);

const OPENAI_SMOKE_TASK = "Set hello.txt to exactly `Hello from AgentForge.` followed by exactly one LF. The file already exists; return a replace change.";
const OPENAI_SMOKE_CHECK: ProjectCheck = Object.freeze({
  image: "node:24-alpine",
  command: Object.freeze([
    "node",
    "-e",
    "const fs = require('node:fs'); if (fs.readFileSync('hello.txt', 'utf8') !== 'Hello from AgentForge.' + String.fromCharCode(10)) process.exit(1);",
  ]),
});
const REPAIR_DEMO_TASK = "Demonstrate one repair cycle for answer.txt. On your first implementation, keep the answer incorrect so the verifier reports a failure. When previous verification feedback is provided, replace answer.txt with exactly `AgentForge repair OK.` followed by one LF.";
const REPAIR_DEMO_CHECK_SOURCE = [
  "import { readFileSync } from 'node:fs';",
  "const expected = 'AgentForge repair OK.' + String.fromCharCode(10);",
  "if (readFileSync('answer.txt', 'utf8') !== expected) process.exit(1);",
  "",
].join("\n");
const REPAIR_DEMO_CHECK: ProjectCheck = Object.freeze({
  image: "node:24-alpine",
  command: Object.freeze(["node", "check.mjs"]),
});

export type SandboxRunnerFactory = (stagingRoot: string) => Pick<SandboxRunner, "run">;
export type OpenAIAgentFactory = (workspacePath: string, contextPaths: readonly string[]) => AgentAdapter;

export async function runCli(
  args: string[],
  saveReport: (path: string, json: string) => Promise<void> = async (path, json) => {
    await writeFile(resolve(path), json, "utf8");
  },
  createSandboxRunner: SandboxRunnerFactory = (stagingRoot) => new SandboxRunner({ workspaceRoot: stagingRoot }),
  createOpenAIAgent: OpenAIAgentFactory = (workspacePath, contextPaths) => createOpenAIAgentAdapter(workspacePath, contextPaths),
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const parsed = parseArgs(args);
  if (!parsed) {
    return {
      exitCode: 2,
      stdout: "",
      stderr: 'Usage: agentforge "task description" --staging-root <path> --workspace <path> [--report <path>]\n       agentforge --openai-smoke [--report <path>]\n       agentforge --openai-repair-demo [--report <path>]\n',
    };
  }

  if (parsed.mode === "openai-smoke") {
    return runOpenAISmoke(parsed.reportPath, saveReport, createSandboxRunner, createOpenAIAgent);
  }
  if (parsed.mode === "openai-repair-demo") {
    return runOpenAIRepairDemo(parsed.reportPath, saveReport, createSandboxRunner, createOpenAIAgent);
  }

  let workflowReport;
  try {
    const runner = createSandboxRunner(parsed.stagingRoot);
    const verifier = new SandboxVerifier(runner, {
      workspacePath: parsed.workspacePath,
      checks: PROJECT_CHECKS,
    });
    workflowReport = await new Orchestrator(new StubAgentAdapter(), verifier).run(parsed.task);
  } catch {
    return { exitCode: 1, stdout: "", stderr: "Unable to run sandbox verification. Check the workspace and staging configuration.\n" };
  }

  const report = {
    ...workflowReport,
    status: workflowReport.status === "succeeded" ? "verification_only" : "failed",
    implementation: {
      performed: false,
      message: "StubAgentAdapter does not modify the workspace. Verification covers its existing contents only.",
    },
  };
  const json = `${JSON.stringify(report, null, 2)}\n`;

  if (parsed.reportPath) {
    try {
      await saveReport(parsed.reportPath, json);
    } catch {
      return { exitCode: 1, stdout: "", stderr: "Unable to write the report file.\n" };
    }
  }
  return { exitCode: workflowReport.status === "succeeded" ? 0 : 1, stdout: json, stderr: "" };
}

async function main(): Promise<void> {
  const result = await runCli(process.argv.slice(2));
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}

type ParsedArgs =
  | { mode: "verify"; task: string; stagingRoot: string; workspacePath: string; reportPath?: string }
  | { mode: "openai-smoke"; reportPath?: string }
  | { mode: "openai-repair-demo"; reportPath?: string };

function parseArgs(args: string[]): ParsedArgs | undefined {
  if (args[0] === "--openai-smoke" || args[0] === "--openai-repair-demo") {
    const mode = args[0] === "--openai-smoke" ? "openai-smoke" : "openai-repair-demo";
    if (args.length === 1) return { mode };
    if (args.length === 3 && args[1] === "--report" && args[2] && !args[2].startsWith("-")) {
      return { mode, reportPath: args[2] };
    }
    return undefined;
  }

  const taskParts: string[] = [];
  let reportPath: string | undefined;
  let stagingRoot: string | undefined;
  let workspacePath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) return undefined;
    if (argument === "--report") {
      const candidate = args[index + 1];
      if (reportPath !== undefined || !candidate || candidate.startsWith("-")) return undefined;
      reportPath = candidate;
      index += 1;
    } else if (argument === "--staging-root") {
      const candidate = args[index + 1];
      if (stagingRoot !== undefined || !candidate || candidate.startsWith("-")) return undefined;
      stagingRoot = candidate;
      index += 1;
    } else if (argument === "--workspace") {
      const candidate = args[index + 1];
      if (workspacePath !== undefined || !candidate || candidate.startsWith("-")) return undefined;
      workspacePath = candidate;
      index += 1;
    } else if (argument.startsWith("-")) {
      return undefined;
    } else {
      taskParts.push(argument);
    }
  }

  const task = taskParts.join(" ").trim();
  if (!task || !stagingRoot || !workspacePath) return undefined;
  return reportPath === undefined
    ? { mode: "verify", task, stagingRoot, workspacePath }
    : { mode: "verify", task, stagingRoot, workspacePath, reportPath };
}

async function runOpenAIRepairDemo(
  reportPath: string | undefined,
  saveReport: (path: string, json: string) => Promise<void>,
  createSandboxRunner: SandboxRunnerFactory,
  createOpenAIAgent: OpenAIAgentFactory,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stagingRoot: string | undefined;
  try {
    stagingRoot = await mkdtemp(join(tmpdir(), "agentforge-openai-repair-demo-"));
    const workspacePath = join(stagingRoot, "workspace");
    await mkdir(workspacePath);
    await writeFile(join(workspacePath, "answer.txt"), "Needs repair.\n", "utf8");
    await writeFile(join(workspacePath, "check.mjs"), REPAIR_DEMO_CHECK_SOURCE, "utf8");

    const verifier = new SandboxVerifier(createSandboxRunner(stagingRoot), {
      workspacePath,
      checks: [REPAIR_DEMO_CHECK],
    });
    const workflowReport = await new Orchestrator(
      createOpenAIAgent(workspacePath, ["answer.txt", "check.mjs"]),
      verifier,
    ).run(REPAIR_DEMO_TASK);
    const repairDemonstrated = workflowReport.attempts >= 2
      && workflowReport.stateHistory.includes("repairing")
      && workflowReport.verificationResults[0]?.passed === false
      && workflowReport.verificationResults.at(-1)?.passed === true;
    const succeeded = workflowReport.status === "succeeded" && repairDemonstrated;
    const json = `${JSON.stringify({
      ...workflowReport,
      status: succeeded ? "succeeded" : "failed",
      execution: "openai_repair_demo",
      repairDemo: { demonstrated: repairDemonstrated },
    }, null, 2)}\n`;

    if (reportPath) {
      try {
        await saveReport(reportPath, json);
      } catch {
        return { exitCode: 1, stdout: "", stderr: "Unable to write the report file.\n" };
      }
    }
    return { exitCode: succeeded ? 0 : 1, stdout: json, stderr: "" };
  } catch {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Unable to run the OpenAI repair demo. Check OPENAI_API_KEY, OPENAI_MODEL, and Docker configuration.\n",
    };
  } finally {
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function runOpenAISmoke(
  reportPath: string | undefined,
  saveReport: (path: string, json: string) => Promise<void>,
  createSandboxRunner: SandboxRunnerFactory,
  createOpenAIAgent: OpenAIAgentFactory,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stagingRoot: string | undefined;
  try {
    stagingRoot = await mkdtemp(join(tmpdir(), "agentforge-openai-smoke-"));
    const workspacePath = join(stagingRoot, "workspace");
    await mkdir(workspacePath);
    await writeFile(join(workspacePath, "README.md"), "Temporary workspace for one AgentForge smoke task.\n", "utf8");
    await writeFile(join(workspacePath, "hello.txt"), "", "utf8");

    const runner = createSandboxRunner(stagingRoot);
    const verifier = new SandboxVerifier(runner, { workspacePath, checks: [OPENAI_SMOKE_CHECK] });
    const workflowReport = await new Orchestrator(
      createOpenAIAgent(workspacePath, ["README.md", "hello.txt"]),
      verifier,
    ).run(OPENAI_SMOKE_TASK);
    const json = `${JSON.stringify({
      ...workflowReport,
      execution: "openai_smoke",
      workspace: "temporary",
      implementation: { performed: workflowReport.status === "succeeded" },
    }, null, 2)}\n`;

    if (reportPath) {
      try {
        await saveReport(reportPath, json);
      } catch {
        return { exitCode: 1, stdout: "", stderr: "Unable to write the report file.\n" };
      }
    }
    return { exitCode: workflowReport.status === "succeeded" ? 0 : 1, stdout: json, stderr: "" };
  } catch {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "Unable to run the OpenAI smoke task. Check OPENAI_API_KEY, OPENAI_MODEL, and Docker configuration.\n",
    };
  } finally {
    if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => {
    process.stderr.write("AgentForge could not complete the request.\n");
    process.exitCode = 1;
  });
}
