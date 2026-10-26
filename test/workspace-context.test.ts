import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildWorkspaceContext, MAX_CONTEXT_BYTES, MAX_CONTEXT_FILES } from "../src/workspace-context.js";

const tempRoot = mkdtempSync(join(tmpdir(), "agentforge-context-test-"));
test.after(() => rmSync(tempRoot, { recursive: true, force: true }));

function workspace(name: string): string {
  const path = join(tempRoot, name);
  mkdirSync(path);
  return path;
}

test("reads only explicitly listed text files and preserves their paths", async () => {
  const root = workspace("listed-files");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 'ą';\n");
  writeFileSync(join(root, "unlisted.bin"), Buffer.from([0, 1, 2, 255]));

  const context = await buildWorkspaceContext(root, ["src/a.ts"]);

  assert.deepEqual(context.files, [{ path: "src/a.ts", content: "export const a = 'ą';\n" }]);
  assert.equal(context.totalBytes, Buffer.byteLength("export const a = 'ą';\n", "utf8"));
});

test("rejects absolute, traversal, malformed, and duplicate paths", async () => {
  const root = workspace("bad-paths");
  for (const filePath of ["../outside.txt", "src/../../outside.txt", "/etc/passwd", "C:\\outside.txt", "src\\file.ts", "./file.ts", "a//b"]) {
    await assert.rejects(buildWorkspaceContext(root, [filePath]), /relative paths/);
  }
  await assert.rejects(buildWorkspaceContext(root, ["same.txt", "same.txt"]), /Duplicate context path/);
});

test("rejects symlinked parents and targets that point outside workspace", async () => {
  const root = workspace("symlink-workspace");
  const outside = mkdtempSync(join(tmpdir(), "agentforge-context-outside-"));
  const outsideFile = join(outside, "secret.txt");
  writeFileSync(outsideFile, "private");
  symlinkSync(outside, join(root, "linked-dir"), "dir");
  symlinkSync(outsideFile, join(root, "linked-file.txt"));
  try {
    await assert.rejects(buildWorkspaceContext(root, ["linked-dir/secret.txt"]), /Symlinked context directories/);
    await assert.rejects(buildWorkspaceContext(root, ["linked-file.txt"]), /Symlink files/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("rejects binary and invalid UTF-8 contents", async () => {
  const root = workspace("binary-files");
  writeFileSync(join(root, "nul.bin"), Buffer.from([0x61, 0, 0x62]));
  writeFileSync(join(root, "invalid.bin"), Buffer.from([0xc3, 0x28]));
  await assert.rejects(buildWorkspaceContext(root, ["nul.bin"]), /Binary files/);
  await assert.rejects(buildWorkspaceContext(root, ["invalid.bin"]), /valid UTF-8/);
});

test("enforces the explicit file count and 64 KiB combined content limit", async () => {
  const root = workspace("limits");
  const tooMany = Array.from({ length: MAX_CONTEXT_FILES + 1 }, (_, index) => `f${index}.txt`);
  await assert.rejects(buildWorkspaceContext(root, tooMany), /between 1 and 10/);

  writeFileSync(join(root, "exact.txt"), "x".repeat(MAX_CONTEXT_BYTES));
  const exact = await buildWorkspaceContext(root, ["exact.txt"]);
  assert.equal(exact.totalBytes, MAX_CONTEXT_BYTES);

  writeFileSync(join(root, "over.txt"), "x".repeat(MAX_CONTEXT_BYTES + 1));
  await assert.rejects(buildWorkspaceContext(root, ["over.txt"]), /exceeds 64 KiB/);
});
