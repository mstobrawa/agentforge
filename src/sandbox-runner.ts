import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { ProjectCheck, SandboxResult } from "./types.js";

type Spawn = (command: string, args: readonly string[]) => ChildProcess;

export interface SandboxRunnerOptions {
  /** Explicit application-owned staging directory; workspace must be a strict child. */
  workspaceRoot: string;
  dockerPath?: string;
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  terminateGraceMs?: number;
  maxLogBytes?: number;
  cpus?: number;
  memoryMb?: number;
  pidsLimit?: number;
  spawn?: Spawn;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  error?: Error;
  timedOut: boolean;
  aborted: boolean;
  spawned: boolean;
  terminationError?: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_LOG_BYTES = 256 * 1024;
const DEFAULT_CLEANUP_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINATE_GRACE_MS = 500;
// Conservative Docker reference format: optional lowercase registry/port,
// lowercase repository path, optional tag, and optional sha256 digest.
const IMAGE_REFERENCE = /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

/** Runs only Docker checks supplied by trusted application configuration. */
export class SandboxRunner {
  private readonly root: string;
  private readonly spawnProcess: Spawn;
  private readonly dockerPath: string;
  private readonly timeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly terminateGraceMs: number;
  private readonly maxLogBytes: number;
  private readonly cpus: number;
  private readonly memoryMb: number;
  private readonly pidsLimit: number;

  constructor(options: SandboxRunnerOptions) {
    if (!options.workspaceRoot) throw new Error("An explicit workspaceRoot is required.");
    this.root = resolve(options.workspaceRoot);
    this.spawnProcess = options.spawn ?? ((command, args) => nodeSpawn(command, [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } }));
    this.dockerPath = options.dockerPath ?? "docker";
    this.timeoutMs = positive(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.cleanupTimeoutMs = positive(options.cleanupTimeoutMs ?? DEFAULT_CLEANUP_TIMEOUT_MS, "cleanupTimeoutMs");
    this.terminateGraceMs = positive(options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS, "terminateGraceMs");
    this.maxLogBytes = positive(options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES, "maxLogBytes");
    this.cpus = positive(options.cpus ?? 1, "cpus");
    this.memoryMb = positive(options.memoryMb ?? 512, "memoryMb");
    this.pidsLimit = positive(options.pidsLimit ?? 128, "pidsLimit");
  }

  async run(workspacePath: string, check: ProjectCheck, options: { signal?: AbortSignal } = {}): Promise<SandboxResult> {
    const started = performance.now();
    let deadline = started + this.timeoutMs;
    let containerRef: string | undefined;
    let status: SandboxResult["status"] = "infrastructure_error";
    let exitCode: number | null = null;
    let stdout = "";
    let stderr = "";
    let logsTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let error: string | undefined;
    let cleanupError: string | undefined;
    try {
      const validatedCheck = validateCheck(check);
      deadline = started + Math.min(this.timeoutMs, validatedCheck.timeoutMs ?? this.timeoutMs);
      if (options.signal?.aborted) {
        status = "cancelled";
        cancelled = true;
        error = "Run cancelled before start.";
        return this.result(started, { status, exitCode, stdout, stderr, logsTruncated, timedOut, cancelled, error });
      }
      const workspace = await this.validateWorkspace(workspacePath);
      if (options.signal?.aborted) {
        status = "cancelled";
        cancelled = true;
        error = "Run cancelled before container creation.";
        return this.result(started, { status, exitCode, stdout, stderr, logsTruncated, timedOut, cancelled, error });
      }
      const containerName = `agentforge-${randomUUID()}`;
      const createArgs = ["create", "--name", containerName, "--network=none", "--user=65532:65532", `--cpus=${this.cpus}`, `--memory=${this.memoryMb}m`, `--pids-limit=${this.pidsLimit}`, "--cap-drop=ALL", "--security-opt=no-new-privileges", "--mount", `type=bind,src=${workspace},dst=/workspace,readonly`, "--workdir=/workspace", validatedCheck.image, ...validatedCheck.command];
      // Docker create emits the ID on stdout; keep enough bytes to parse it even with tiny user log caps.
      const create = await this.execute(createArgs, this.remaining(deadline), Math.max(this.maxLogBytes, 128), options.signal);
      if (create.timedOut || create.aborted || create.error || create.code !== 0) {
        ({ status, timedOut, cancelled } = this.statusForCommand(create));
        error = create.error?.message ?? create.terminationError ?? (create.aborted ? "Run cancelled during docker create." : create.timedOut ? "Run deadline exceeded during docker create." : "docker create failed.");
        if (create.spawned) {
          status = "infrastructure_error";
          cleanupError = "No container ID was confirmed; cleanup by name was skipped to avoid deleting an unrelated container. A container may remain.";
        }
      } else {
        const containerId = create.stdout.trim();
        if (!containerId || !/^[a-f0-9]{12,64}$/i.test(containerId)) {
          status = "infrastructure_error";
          error = "docker create did not return a valid container ID.";
          if (create.spawned) cleanupError = "No container ID was confirmed; cleanup by name was skipped to avoid deleting an unrelated container. A container may remain.";
        } else {
          containerRef = containerId;
          const start = await this.execute(["start", containerId], this.remaining(deadline), this.maxLogBytes, options.signal);
          if (start.timedOut || start.aborted || start.error || start.code !== 0) {
            ({ status, timedOut, cancelled } = this.statusForCommand(start));
            error = start.error?.message ?? start.terminationError ?? (start.aborted ? "Run cancelled during docker start." : start.timedOut ? "Run deadline exceeded during docker start." : "docker start failed.");
          } else {
            const wait = await this.execute(["wait", containerId], this.remaining(deadline), 128, options.signal);
            if (wait.timedOut || wait.aborted || wait.error || wait.code !== 0) {
              ({ status, timedOut, cancelled } = this.statusForCommand(wait));
              error = wait.error?.message ?? wait.terminationError ?? (wait.aborted ? "Run cancelled while waiting for the container." : wait.timedOut ? "Run deadline exceeded while waiting for the container." : "docker wait failed.");
            } else {
              const codeText = wait.stdout.trim();
              if (!/^\d{1,3}$/.test(codeText) || Number(codeText) > 255) {
                status = "infrastructure_error";
                error = "docker wait returned an invalid container exit code.";
              } else {
                exitCode = Number(codeText);
                const logs = await this.execute(["logs", containerId], this.remaining(deadline), this.maxLogBytes, options.signal);
                stdout = logs.stdout;
                stderr = logs.stderr;
                logsTruncated = logs.truncated;
                if (logs.timedOut || logs.aborted || logs.error || logs.code !== 0) {
                  ({ status, timedOut, cancelled } = this.statusForCommand(logs));
                  error = logs.error?.message ?? logs.terminationError ?? (logs.aborted ? "Run cancelled while collecting container logs." : logs.timedOut ? "Run deadline exceeded while collecting container logs." : "docker logs failed.");
                } else {
                  status = exitCode === 0 ? "success" : "error";
                }
              }
            }
          }
        }
      }
    } catch (cause) {
      status = "infrastructure_error";
      error = cause instanceof Error ? cause.message : "Sandbox runner failed.";
    } finally {
      // Only a successful create response gives us an ID we can safely remove.
      // Never delete by generated name after an ambiguous create result.
      if (containerRef) {
        try {
          const cleanup = await this.execute(["rm", "-f", containerRef], this.cleanupTimeoutMs, this.maxLogBytes);
          if (cleanup.error || cleanup.terminationError || cleanup.timedOut || cleanup.code !== 0) {
            cleanupError = cleanup.timedOut ? "docker rm -f exceeded its cleanup deadline." : "docker rm -f failed.";
            status = "infrastructure_error";
          }
        } catch {
          cleanupError = "docker rm -f could not be completed.";
          status = "infrastructure_error";
        }
      }
    }
    return this.result(started, { status, exitCode, stdout, stderr, logsTruncated, timedOut, cancelled, ...(error ? { error } : {}), ...(cleanupError ? { cleanupError } : {}) });
  }

  private remaining(deadline: number): number { return Math.max(0, deadline - performance.now()); }

  private statusForCommand(command: CommandResult): Pick<SandboxResult, "status" | "timedOut" | "cancelled"> {
    if (command.error || command.terminationError) return { status: "infrastructure_error", timedOut: command.timedOut, cancelled: command.aborted };
    if (command.timedOut) return { status: command.terminationError ? "infrastructure_error" : "timeout", timedOut: true, cancelled: false };
    if (command.aborted) return { status: command.terminationError ? "infrastructure_error" : "cancelled", timedOut: false, cancelled: true };
    return { status: "infrastructure_error", timedOut: false, cancelled: false };
  }

  private result(started: number, fields: Omit<SandboxResult, "durationMs">): SandboxResult {
    return { ...fields, durationMs: Math.max(0, performance.now() - started) };
  }

  private async validateWorkspace(path: string): Promise<string> {
    if (!path || !isAbsolute(path)) throw new Error("Workspace must be an explicitly supplied absolute path.");
    const [root, workspace] = await Promise.all([realpath(this.root), realpath(path)]);
    const [rootInfo, workspaceInfo] = await Promise.all([stat(root), stat(workspace)]);
    if (!rootInfo.isDirectory()) throw new Error("Configured staging root must be a directory.");
    if (!workspaceInfo.isDirectory()) throw new Error("Workspace must be a directory.");
    // Docker --mount uses commas as field separators and has no safe escaping
    // contract for this source field. Reject such canonical paths explicitly.
    if (workspace.includes(",")) throw new Error("Workspace paths containing commas are not supported.");
    const rel = relative(root, workspace);
    if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error("Workspace must be a strict child of the configured staging root.");
    }
    return workspace;
  }

  private execute(args: readonly string[], timeoutMs: number, logLimit: number, signal?: AbortSignal): Promise<CommandResult> {
    return new Promise((resolveResult) => {
      if (signal?.aborted) {
        resolveResult({ ...emptyCommandResult(), aborted: true });
        return;
      }
      if (timeoutMs <= 0) {
        resolveResult({ ...emptyCommandResult(), timedOut: true });
        return;
      }
      let child: ChildProcess;
      try {
        child = this.spawnProcess(this.dockerPath, args);
      } catch (value) {
        resolveResult({ ...emptyCommandResult(), error: asError(value) });
        return;
      }
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let truncated = false;
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let terminationStarted = false;
      let spawned = child.pid !== undefined;
      let terminationError: string | undefined;
      let processError: Error | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let fallbackTimer: NodeJS.Timeout | undefined;
      const append = (current: Buffer, chunk: Buffer, stream: "stdout" | "stderr"): Buffer => {
        const combined = Buffer.concat([current, chunk]);
        if (combined.length > logLimit) truncated = true;
        const kept = combined.subarray(0, logLimit);
        if (stream === "stdout") stdout = kept;
        else stderr = kept;
        return kept;
      };
      child.stdout?.on("data", (chunk: Buffer | string) => append(stdout, Buffer.from(chunk), "stdout"));
      child.stderr?.on("data", (chunk: Buffer | string) => append(stderr, Buffer.from(chunk), "stderr"));
      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        if (fallbackTimer) clearTimeout(fallbackTimer);
        signal?.removeEventListener("abort", onAbort);
        resolveResult({ code, stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8"), truncated, ...(processError ? { error: processError } : {}), timedOut, aborted, spawned, ...(terminationError ? { terminationError } : {}) });
      };
      const tryKill = (target: "SIGTERM" | "SIGKILL"): boolean => {
        try {
          return child.kill(target);
        } catch (cause) {
          terminationError ??= cause instanceof Error ? cause.message : `Could not send ${target}.`;
          return false;
        }
      };
      const stop = (reason: "timeout" | "abort" | "process-error"): void => {
        if (settled || terminationStarted) return;
        terminationStarted = true;
        if (reason === "timeout") timedOut = true;
        if (reason === "abort") aborted = true;
        tryKill("SIGTERM");
        killTimer = setTimeout(() => {
          if (settled) return;
          tryKill("SIGKILL");
          fallbackTimer = setTimeout(() => {
            if (!settled) {
              terminationError ??= "Process did not emit close after SIGKILL; its termination could not be confirmed.";
              finish(null);
            }
          }, this.terminateGraceMs);
        }, this.terminateGraceMs);
      };
      const onAbort = (): void => stop("abort");
      const onStreamError = (error: Error): void => {
        processError ??= error;
        if (!spawned && child.pid === undefined) finish(null);
        else stop("process-error");
      };
      const timer = setTimeout(() => stop("timeout"), timeoutMs);
      child.stdout?.on("error", onStreamError);
      child.stderr?.on("error", onStreamError);
      child.once("spawn", () => {
        spawned = true;
        if (terminationStarted && !settled) tryKill("SIGTERM");
      });
      child.on("error", (error: Error) => {
        processError = error;
        if (settled) return;
        if (!spawned && child.pid === undefined) finish(null);
        else stop("process-error");
      });
      child.once("close", (code: number | null) => finish(code));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function validateCheck(check: ProjectCheck): ProjectCheck {
  if (!check || typeof check !== "object" || (Object.getPrototypeOf(check) !== Object.prototype && Object.getPrototypeOf(check) !== null)) {
    throw new Error("Check configuration must be a plain object.");
  }
  const allowed = new Set<PropertyKey>(["image", "command", "timeoutMs"]);
  for (const key of Reflect.ownKeys(check)) {
    if (!allowed.has(key)) throw new Error("Check configuration contains unsupported fields.");
    const descriptor = Object.getOwnPropertyDescriptor(check, key);
    if (!descriptor || !("value" in descriptor)) throw new Error("Check configuration fields must be plain data values.");
  }
  const image = check.image;
  if (typeof image !== "string" || !IMAGE_REFERENCE.test(image)) throw new Error("Invalid image reference; use a lowercase Docker repository with optional tag and sha256 digest.");
  if (!Array.isArray(check.command) || check.command.length === 0) throw new Error("A fixed command argument list is required.");
  const command: string[] = [];
  for (let index = 0; index < check.command.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(check.command, String(index));
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string" || descriptor.value.includes("\0")) {
      throw new Error("Command arguments must be dense strings without NUL bytes.");
    }
    command.push(descriptor.value);
  }
  const timeoutMs = check.timeoutMs;
  if (timeoutMs !== undefined) positive(timeoutMs, "check.timeoutMs");
  return { image, command, ...(timeoutMs !== undefined ? { timeoutMs } : {}) };
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number.`);
  return value;
}

function asError(value: unknown): Error { return value instanceof Error ? value : new Error("Process failed to start."); }
function emptyCommandResult(): CommandResult { return { code: null, stdout: "", stderr: "", truncated: false, timedOut: false, aborted: false, spawned: false }; }
