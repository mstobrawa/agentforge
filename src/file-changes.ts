import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import type { FileChange, FileChangeProposal } from "./types.js";

export const MAX_PROPOSAL_FILES = 20;
export const MAX_FILE_CONTENT_BYTES = 256 * 1024;
export const MAX_PROPOSAL_CONTENT_BYTES = 1024 * 1024;

/** Parses and bounds untrusted proposal data before any filesystem changes. */
export function validateFileChangeProposal(value: unknown): FileChangeProposal {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["changes"]) || !Array.isArray(value.changes)) {
    throw new Error("File change proposal must contain only a changes array.");
  }
  if (value.changes.length === 0 || value.changes.length > MAX_PROPOSAL_FILES) {
    throw new Error(`A proposal must contain between 1 and ${MAX_PROPOSAL_FILES} changes.`);
  }

  const changes: FileChange[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < value.changes.length; index += 1) {
    const raw = value.changes[index];
    if (!isPlainRecord(raw) || !hasExactKeys(raw, ["operation", "path", "content"])) {
      throw new Error(`Change ${index + 1} must contain only operation, path, and content.`);
    }
    if (raw.operation !== "create" && raw.operation !== "replace") {
      throw new Error(`Change ${index + 1} has an unsupported operation.`);
    }
    if (typeof raw.path !== "string" || !isSafeRelativePath(raw.path)) {
      throw new Error(`Change ${index + 1} path must be a normalized relative path inside the workspace.`);
    }
    if (seen.has(raw.path)) throw new Error(`Proposal contains duplicate path: ${raw.path}`);
    seen.add(raw.path);
    if (typeof raw.content !== "string" || raw.content.includes("\0")) {
      throw new Error(`Change ${index + 1} content must be UTF-8 text without NUL bytes.`);
    }
    const bytes = Buffer.byteLength(raw.content, "utf8");
    if (bytes > MAX_FILE_CONTENT_BYTES) throw new Error(`Change ${index + 1} exceeds the per-file content limit.`);
    totalBytes += bytes;
    if (totalBytes > MAX_PROPOSAL_CONTENT_BYTES) throw new Error("Proposal exceeds the total content limit.");
    changes.push({ operation: raw.operation, path: raw.path, content: raw.content });
  }
  return { changes };
}

/** Applies create/replace-only text changes under one explicitly configured workspace. */
export class WorkspaceFileChangeApplier {
  constructor(private readonly workspacePath: string) {
    if (typeof workspacePath !== "string" || workspacePath.trim() === "" || !isAbsolute(workspacePath)) {
      throw new Error("WorkspaceFileChangeApplier requires an absolute workspace path.");
    }
  }

  async apply(proposalData: unknown): Promise<FileChangeProposal> {
    const proposal = validateFileChangeProposal(proposalData);
    const root = await realpath(this.workspacePath);
    if (!(await stat(root)).isDirectory()) throw new Error("Workspace must be a directory.");

    const targets: { change: FileChange; absolutePath: string }[] = [];
    for (const change of proposal.changes) {
      const absolutePath = resolve(root, ...change.path.split("/"));
      const rel = relative(root, absolutePath);
      if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
        throw new Error(`Change path escapes workspace: ${change.path}`);
      }
      await this.validateParents(root, change.path);
      await this.validateTarget(absolutePath, change);
      targets.push({ change, absolutePath });
    }

    // All proposal and current filesystem preconditions are checked before writes.
    // The file operations themselves are intentionally not a multi-file transaction.
    for (const { change, absolutePath } of targets) {
      if (await realpath(this.workspacePath) !== root) throw new Error("Workspace path changed during proposal application.");
      await this.validateParents(root, change.path);
      await this.validateTarget(absolutePath, change);
      const flags = change.operation === "create"
        ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0)
        : constants.O_WRONLY | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
      const handle = await open(absolutePath, flags, 0o666);
      try {
        await handle.writeFile(change.content, "utf8");
      } finally {
        await handle.close();
      }
    }
    return proposal;
  }

  private async validateParents(root: string, relativePath: string): Promise<void> {
    const segments = relativePath.split("/").slice(0, -1);
    let current = root;
    for (const segment of segments) {
      current = resolve(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error(`Symlinked parent directories are not allowed: ${relativePath}`);
      if (!info.isDirectory()) throw new Error(`Parent path is not a directory: ${relativePath}`);
    }
  }

  private async validateTarget(absolutePath: string, change: FileChange): Promise<void> {
    let info;
    try {
      info = await lstat(absolutePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        if (change.operation === "replace") throw new Error(`Cannot replace missing file: ${change.path}`);
        return;
      }
      throw error;
    }
    if (info.isSymbolicLink()) throw new Error(`Symlink targets are not allowed: ${change.path}`);
    if (!info.isFile()) throw new Error(`Target must be a regular file: ${change.path}`);
    if (info.nlink > 1) throw new Error(`Hard-linked targets are not allowed: ${change.path}`);
    if (change.operation === "create") throw new Error(`Cannot create an existing file: ${change.path}`);
  }
}

function isSafeRelativePath(value: string): boolean {
  if (value.includes("\0") || value.includes("\\") || isAbsolute(value) || win32.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return false;
  const segments = value.split("/");
  return segments.length > 0 && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every((key) => typeof key === "string" && expected.includes(key)
    && Object.getOwnPropertyDescriptor(value, key) !== undefined
    && "value" in (Object.getOwnPropertyDescriptor(value, key) ?? {}));
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error;
}
