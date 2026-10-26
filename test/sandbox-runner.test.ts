import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { SandboxRunner } from "../src/sandbox-runner.js";

const root = mkdtempSync(join(tmpdir(), "agentforge-test-"));
const workspace = join(root, "workspace-a");
mkdirSync(workspace);
test.after(() => rmSync(root, { recursive: true, force: true }));
const containerId = "0123456789abcdef0123456789abcdef";

class FakeProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined = 123;
  signals: NodeJS.Signals[] = [];
  autoCloseOnKill = true;
  ignoreTerm = false;
  failKill = false;
  suppressSpawn = false;

  constructor() {
    super();
    queueMicrotask(() => { if (!this.suppressSpawn) this.emit("spawn"); });
  }

  kill = (signal: NodeJS.Signals = "SIGTERM"): boolean => {
    this.signals.push(signal);
    if (this.failKill) return false;
    if (signal === "SIGTERM" && this.ignoreTerm) return true;
    if (this.autoCloseOnKill) queueMicrotask(() => this.close(null));
    return true;
  };

  close(code: number | null): void {
    this.stdout.end();
    this.stderr.end();
    this.emit("close", code);
  }
}

type Responder = (args: readonly string[], child: FakeProcess, index: number) => void;

function harness(responder: Responder, options: Record<string, unknown> = {}) {
  const calls: string[][] = [];
  const children: FakeProcess[] = [];
  const runner = new SandboxRunner({
    workspaceRoot: root,
    timeoutMs: 200,
    cleanupTimeoutMs: 20,
    terminateGraceMs: 5,
    maxLogBytes: 5,
    spawn: ((_command: string, args: readonly string[]) => {
      const copiedArgs = [...args];
      const child = new FakeProcess();
      const index = calls.push(copiedArgs) - 1;
      children.push(child);
      responder(copiedArgs, child, index);
      return child as never;
    }) as never,
    ...options,
  });
  return { runner, calls, children };
}

function respondNormally(args: readonly string[], child: FakeProcess, _index: number, checkCode: number | string = 0): void {
  queueMicrotask(() => {
    if (args[0] === "create") {
      child.stdout.write(`${containerId}\n`);
      child.close(0);
    } else if (args[0] === "start" || args[0] === "logs" || args[0] === "rm") {
      if (args[0] === "logs") {
        child.stdout.write("123456789");
        child.stderr.write("abcdefghi");
      }
      child.close(0);
    } else if (args[0] === "wait") {
      child.stdout.write(`${checkCode}\n`);
      child.close(0);
    }
  });
}

async function assertRejectedBeforeDocker(path: string, check = { image: "node:22-alpine", command: ["npm", "test"] }): Promise<void> {
  const { runner, calls } = harness((args, child, index) => respondNormally(args, child, index));
  const result = await runner.run(path, check);
  assert.equal(result.status, "infrastructure_error");
  assert.deepEqual(calls, [], "invalid input must be rejected before invoking Docker");
}

test("runs create, start, wait, logs, and rm; returns the container exit code", async () => {
  const { runner, calls } = harness((args, child, index) => respondNormally(args, child, index));
  const result = await runner.run(workspace, { image: "node:22-alpine", command: ["npm", "test"] });

  assert.equal(result.status, "success");
  assert.equal(result.exitCode, 0);
  assert.equal(result.durationMs >= 0, true);
  assert.deepEqual(calls.map((args) => args[0]), ["create", "start", "wait", "logs", "rm"]);
  assert.ok(calls[0]?.includes("--network=none"));
  assert.ok(calls[0]?.includes("--cap-drop=ALL"));
  assert.ok(calls[0]?.includes("--security-opt=no-new-privileges"));
  assert.ok(calls[0]?.includes("--pids-limit=128"));
  assert.ok(!calls[0]?.includes("--privileged"));
  assert.ok(calls[1]?.includes(containerId));
  assert.ok(calls[4]?.includes("-f"));
});

test("returns error for a nonzero container exit code from docker wait", async () => {
  const { runner } = harness((args, child, index) => respondNormally(args, child, index, 7));
  const result = await runner.run(workspace, { image: "node:22-alpine", command: ["npm", "test"] });
  assert.equal(result.status, "error");
  assert.equal(result.exitCode, 7);
});

test("rejects malformed and out-of-range docker wait exit codes", async () => {
  for (const code of ["256", "-1", "abc", ""]) {
    const { runner } = harness((args, child, index) => respondNormally(args, child, index, code));
    const result = await runner.run(workspace, { image: "node:22-alpine", command: ["test"] });
    assert.equal(result.status, "infrastructure_error", `wait output ${JSON.stringify(code)}`);
    assert.equal(result.exitCode, null, `wait output ${JSON.stringify(code)}`);
  }
});

test("caps stdout and stderr from container logs", async () => {
  const { runner } = harness((args, child, index) => respondNormally(args, child, index));
  const result = await runner.run(workspace, { image: "node:22-alpine", command: ["test"] });
  assert.equal(result.stdout, "12345");
  assert.equal(result.stderr, "abcde");
  assert.equal(result.logsTruncated, true);
});

test("one run deadline covers create and start rather than resetting at each stage", async () => {
  const timeoutMs = 140;
  const createDelayMs = 60;
  const startDelayMs = 100;
  const invocationStarted = performance.now();
  let startBeganAt: number | undefined;
  const { runner, calls, children } = harness((args, child) => {
    setTimeout(() => {
      if (args[0] === "create") {
        child.stdout.write(`${containerId}\n`);
        child.close(0);
      } else if (args[0] === "start") child.close(0);
      else if (args[0] === "rm") child.close(0);
    }, args[0] === "create" ? createDelayMs : args[0] === "start" ? startDelayMs : 0);
    if (args[0] === "start") startBeganAt = performance.now();
  }, { timeoutMs, cleanupTimeoutMs: 30, terminateGraceMs: 2 });
  const result = await runner.run(workspace, { image: "node:22-alpine", command: ["test"], timeoutMs: 500 });
  assert.ok(startBeganAt !== undefined);
  const remainingAtStartMs = timeoutMs - (startBeganAt - invocationStarted);
  assert.ok(remainingAtStartMs > 0, `start should begin with time left, got ${remainingAtStartMs}ms`);
  assert.ok(remainingAtStartMs < startDelayMs, `shared deadline should leave less than ${startDelayMs}ms for start, got ${remainingAtStartMs}ms`);
  assert.equal(result.status, "timeout");
  assert.equal(result.timedOut, true);
  assert.deepEqual(calls.map((args) => args[0]), ["create", "start", "rm"]);
  assert.ok(children[1]?.signals.includes("SIGTERM"), "start must be terminated at the remaining run deadline");
  assert.equal(children[1]?.signals.includes("SIGKILL"), false, "SIGTERM should close the fake before escalation");
});

test("an already-aborted signal does not spawn Docker", async () => {
  const { runner, calls } = harness((args, child, index) => respondNormally(args, child, index));
  const controller = new AbortController();
  controller.abort();
  const result = await runner.run(workspace, { image: "node:22-alpine", command: ["test"] }, { signal: controller.signal });
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelled, true);
  assert.deepEqual(calls, []);
});

test("cancelling while waiting terminates the process and removes the container", async () => {
  const controller = new AbortController();
  const { runner, calls } = harness((args, child, index) => {
    if (args[0] === "wait") queueMicrotask(() => controller.abort());
    else respondNormally(args, child, index);
  });
  const result = await runner.run(workspace, { image: "node:22-alpine", command: ["test"] }, { signal: controller.signal });
  assert.equal(result.status, "cancelled");
  assert.equal(result.cancelled, true);
  assert.deepEqual(calls.map((args) => args[0]), ["create", "start", "wait", "rm"]);
  assert.deepEqual((await Promise.resolve(result)).status, "cancelled");
});

test("escalates from SIGTERM to SIGKILL when the Docker process ignores SIGTERM", async () => {
  const { runner, calls, children } = harness((args, child, index) => {
    if (args[0] === "create" || args[0] === "start") respondNormally(args, child, index);
    else if (args[0] === "wait") child.ignoreTerm = true;
    else queueMicrotask(() => child.close(0));
  }, { timeoutMs: 40, cleanupTimeoutMs: 20, terminateGraceMs: 5 });
  const result = await runner.run(workspace, { image: "node:22-alpine", command: ["test"] });
  assert.equal(result.status, "timeout", result.error);
  assert.ok(children[2]?.signals.includes("SIGTERM"));
  assert.ok(children[2]?.signals.includes("SIGKILL"));
  assert.deepEqual(calls.map((args) => args[0]), ["create", "start", "wait", "rm"]);
});

test("returns within a bound and reports failure when kill does not terminate the process", async () => {
  const { runner, children } = harness((args, child, index) => {
    if (args[0] === "create" || args[0] === "start") respondNormally(args, child, index);
    else if (args[0] === "wait") {
      child.autoCloseOnKill = false;
      child.failKill = true;
    } else queueMicrotask(() => child.close(0));
  }, { timeoutMs: 25, cleanupTimeoutMs: 15, terminateGraceMs: 5 });
  const result = await runner.run(workspace, { image: "node:22-alpine", command: ["test"] });
  assert.equal(result.status, "infrastructure_error");
  assert.equal(result.timedOut, true);
  assert.match(result.error ?? "", /termination could not be confirmed/);
  assert.ok(children[2]?.signals.includes("SIGTERM"));
  assert.ok(children[2]?.signals.includes("SIGKILL"));
});

test("does not remove a container by generated name after an ambiguous create failure", async () => {
  const { runner, calls } = harness((args, child) => queueMicrotask(() => {
    if (args[0] === "create") {
      // Simulate Docker rejecting create because this name is already occupied.
      child.stderr.write("daemon error");
      child.close(1);
    } else child.close(0);
  }));
  const result = await runner.run(workspace, { image: "node:22-alpine", command: ["test"] });
  assert.equal(result.status, "infrastructure_error");
  assert.deepEqual(calls.map((args) => args[0]), ["create"]);
  assert.match(result.cleanupError ?? "", /cleanup by name was skipped.*A container may remain/);
});

test("stdout and stderr stream errors produce infrastructure results and still clean up", async () => {
  for (const streamName of ["stdout", "stderr"] as const) {
    const { runner, calls } = harness((args, child, index) => {
      if (args[0] === "logs") queueMicrotask(() => child[streamName].emit("error", new Error(`${streamName} pipe failed`)));
      else respondNormally(args, child, index);
    });
    const result = await runner.run(workspace, { image: "node:22-alpine", command: ["test"] });
    assert.equal(result.status, "infrastructure_error", streamName);
    assert.match(result.error ?? "", new RegExp(`${streamName} pipe failed`));
    assert.deepEqual(calls.map((args) => args[0]), ["create", "start", "wait", "logs", "rm"], streamName);
  }
});

test("classifies a docker start failure as infrastructure, not a check failure", async () => {
  const { runner, calls } = harness((args, child, index) => {
    if (args[0] === "start") queueMicrotask(() => child.close(125));
    else respondNormally(args, child, index);
  });
  const result = await runner.run(workspace, { image: "node:22-alpine", command: ["test"] });
  assert.equal(result.status, "infrastructure_error");
  assert.equal(result.exitCode, null);
  assert.deepEqual(calls.map((args) => args[0]), ["create", "start", "rm"]);
});

test("reports a docker rm -f failure separately and does not return success", async () => {
  const { runner } = harness((args, child, index) => {
    if (args[0] === "rm") queueMicrotask(() => child.close(1));
    else respondNormally(args, child, index);
  });
  const result = await runner.run(workspace, { image: "node:22-alpine", command: ["test"] });
  assert.equal(result.status, "infrastructure_error");
  assert.equal(result.cleanupError, "docker rm -f failed.");
  assert.equal(result.exitCode, 0);
});

test("bounds cleanup and reports when docker rm -f times out", async () => {
  const { runner, children } = harness((args, child, index) => {
    if (args[0] === "rm") child.autoCloseOnKill = false;
    else respondNormally(args, child, index);
  }, { cleanupTimeoutMs: 5, terminateGraceMs: 3 });
  const result = await runner.run(workspace, { image: "node:22-alpine", command: ["test"] });
  assert.equal(result.status, "infrastructure_error");
  assert.equal(result.cleanupError, "docker rm -f exceeded its cleanup deadline.");
  assert.ok(children.at(-1)?.signals.includes("SIGTERM"));
  assert.ok(children.at(-1)?.signals.includes("SIGKILL"));
});

test("reports Docker process start failure as infrastructure error", async () => {
  const { runner } = harness((_args, child) => {
    child.suppressSpawn = true;
    child.pid = undefined;
    queueMicrotask(() => child.emit("error", new Error("spawn failed")));
  });
  const result = await runner.run(workspace, { image: "node:22-alpine", command: ["test"] });
  assert.equal(result.status, "infrastructure_error");
});

test("removes a created container after a Docker start process error", async () => {
  const { runner, calls } = harness((args, child, index) => {
    if (args[0] === "start") queueMicrotask(() => child.emit("error", new Error("start process failed")));
    else respondNormally(args, child, index);
  });
  const result = await runner.run(workspace, { image: "node:22-alpine", command: ["test"] });
  assert.equal(result.status, "infrastructure_error");
  assert.deepEqual(calls.map((args) => args[0]), ["create", "start", "rm"]);
});

test("rejects an image that could be parsed as a Docker option before spawn", async () => {
  const { runner, calls } = harness((args, child, index) => respondNormally(args, child, index));
  const result = await runner.run(workspace, { image: "--privileged", command: ["npm", "test"] });
  assert.equal(result.status, "infrastructure_error");
  assert.deepEqual(calls, []);
});

test("rejects malformed image references before spawn", async () => {
  for (const image of ["Node:22", "node;--privileged", "node image", "node:tag/extra"]) {
    const { runner, calls } = harness((args, child, index) => respondNormally(args, child, index));
    const result = await runner.run(workspace, { image, command: ["npm", "test"] });
    assert.equal(result.status, "infrastructure_error", image);
    assert.deepEqual(calls, [], image);
  }
});

test("rejects unsupported ProjectCheck fields instead of accepting Docker options", async () => {
  const { runner, calls } = harness((args, child, index) => respondNormally(args, child, index));
  const result = await runner.run(workspace, { image: "node:22-alpine", command: ["npm", "test"], privileged: true } as never);
  assert.equal(result.status, "infrastructure_error");
  assert.deepEqual(calls, []);
});

test("rejects a workspace outside the configured staging root", async () => {
  const externalRoot = mkdtempSync(join(tmpdir(), "agentforge-outside-"));
  try { await assertRejectedBeforeDocker(externalRoot); }
  finally { rmSync(externalRoot, { recursive: true, force: true }); }
});

test("rejects the staging root itself as a workspace", async () => {
  await assertRejectedBeforeDocker(root);
});

test("rejects a workspace symlink that resolves outside staging", async () => {
  const externalRoot = mkdtempSync(join(tmpdir(), "agentforge-link-target-"));
  const linkPath = join(root, "workspace-outside-link");
  try {
    symlinkSync(externalRoot, linkPath, "dir");
    await assertRejectedBeforeDocker(linkPath);
  } finally {
    rmSync(linkPath, { force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test("rejects a workspace that does not exist", async () => {
  await assertRejectedBeforeDocker(join(root, "does-not-exist"));
});

test("rejects a file supplied as workspace", async () => {
  const filePath = join(root, "not-a-directory");
  writeFileSync(filePath, "fixture");
  await assertRejectedBeforeDocker(filePath);
});

test("rejects comma paths before building Docker mount arguments", async () => {
  const commaPath = join(root, "workspace,src=/etc");
  mkdirSync(commaPath, { recursive: true });
  await assertRejectedBeforeDocker(commaPath);
});
