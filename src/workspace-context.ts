import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, win32 } from "node:path";

export const MAX_CONTEXT_FILES = 10;
export const MAX_CONTEXT_BYTES = 64 * 1024;

export interface WorkspaceContextFile {
  path: string;
  content: string;
}

export interface WorkspaceContext {
  files: readonly WorkspaceContextFile[];
  totalBytes: number;
}

/** Reads only explicitly listed, regular UTF-8 text files under a workspace. */
export async function buildWorkspaceContext(
  workspacePath: string,
  filePaths: readonly string[],
): Promise<WorkspaceContext> {
  if (typeof workspacePath !== "string" || workspacePath.trim() === "" || !isAbsolute(workspacePath)) {
    throw new Error("An absolute workspace path is required.");
  }
  if (!Array.isArray(filePaths) || filePaths.length === 0 || filePaths.length > MAX_CONTEXT_FILES) {
    throw new Error(`Provide between 1 and ${MAX_CONTEXT_FILES} explicit file paths.`);
  }

  const seen = new Set<string>();
  for (const filePath of filePaths) {
    if (typeof filePath !== "string" || !isSafeRelativePath(filePath)) {
      throw new Error("Context paths must be normalized relative paths inside the workspace.");
    }
    if (seen.has(filePath)) throw new Error(`Duplicate context path: ${filePath}`);
    seen.add(filePath);
  }

  const root = await realpath(workspacePath);
  if (!(await stat(root)).isDirectory()) throw new Error("Workspace must be a directory.");

  const files: WorkspaceContextFile[] = [];
  let totalBytes = 0;
  for (const filePath of filePaths) {
    if (await realpath(workspacePath) !== root) throw new Error("Workspace path changed while building context.");
    const absolutePath = resolve(root, ...filePath.split("/"));
    const rel = relative(root, absolutePath);
    if (!rel || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error(`Context path escapes workspace: ${filePath}`);
    }

    await validateParents(root, filePath);
    const targetInfo = await lstat(absolutePath);
    if (targetInfo.isSymbolicLink()) throw new Error(`Symlink files are not allowed in context: ${filePath}`);
    if (!targetInfo.isFile()) throw new Error(`Context target must be a regular file: ${filePath}`);
    if (targetInfo.size > MAX_CONTEXT_BYTES - totalBytes) throw new Error("Workspace context exceeds 64 KiB.");

    const file = await readBoundedText(absolutePath, filePath, MAX_CONTEXT_BYTES - totalBytes);
    totalBytes += file.bytes;
    files.push({ path: filePath, content: file.content });
  }
  return { files, totalBytes };
}

async function validateParents(root: string, filePath: string): Promise<void> {
  let current = root;
  for (const segment of filePath.split("/").slice(0, -1)) {
    current = resolve(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error(`Symlinked context directories are not allowed: ${filePath}`);
    if (!info.isDirectory()) throw new Error(`Context parent is not a directory: ${filePath}`);
  }
}

async function readBoundedText(absolutePath: string, filePath: string, remainingBytes: number): Promise<{ content: string; bytes: number }> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(absolutePath, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Context target must be a regular file: ${filePath}`);
    if (info.size > remainingBytes) throw new Error("Workspace context exceeds 64 KiB.");

    const chunks: Buffer[] = [];
    let bytesRead = 0;
    while (bytesRead <= remainingBytes) {
      const length = Math.min(8192, remainingBytes + 1 - bytesRead);
      const chunk = Buffer.allocUnsafe(length);
      const { bytesRead: count } = await handle.read(chunk, 0, length, null);
      if (count === 0) break;
      const actual = chunk.subarray(0, count);
      if (containsBinaryControl(actual)) throw new Error(`Binary files are not allowed in context: ${filePath}`);
      chunks.push(actual);
      bytesRead += count;
      if (bytesRead > remainingBytes) throw new Error("Workspace context exceeds 64 KiB.");
    }

    const buffer = Buffer.concat(chunks, bytesRead);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`Context file is not valid UTF-8 text: ${filePath}`);
    }
    return { content, bytes: bytesRead };
  } finally {
    await handle.close();
  }
}

function containsBinaryControl(buffer: Buffer): boolean {
  return buffer.some((byte) => byte === 0 || byte === 0x7f || (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d));
}

function isSafeRelativePath(value: string): boolean {
  if (value.includes("\0") || value.includes("\\") || isAbsolute(value) || win32.isAbsolute(value) || /^[a-zA-Z]:/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}
