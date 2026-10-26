import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MAX_FILE_CONTENT_BYTES,
  MAX_PROPOSAL_FILES,
  WorkspaceFileChangeApplier,
  validateFileChangeProposal,
} from "../src/file-changes.js";

const tempRoot = mkdtempSync(join(tmpdir(), "agentforge-file-changes-"));
test.after(() => rmSync(tempRoot, { recursive: true, force: true }));

function makeWorkspace(name: string): string {
  const workspace = join(tempRoot, name);
  mkdirSync(workspace);
  return workspace;
}

test("validates a proposal of text file creations and replacements", () => {
  const proposal = validateFileChangeProposal({
    changes: [
      { operation: "create", path: "src/new.ts", content: "export const value = 1;\n" },
      { operation: "replace", path: "README.md", content: "Updated\n" },
    ],
  });
  assert.equal(proposal.changes.length, 2);
});

test("rejects traversal, absolute, non-normalized, and duplicate paths", () => {
  for (const path of ["../escape.txt", "src/../../escape.txt", "/tmp/escape.txt", "C:\\escape.txt", "src\\file.txt", "./file.txt", "src//file.txt"]) {
    assert.throws(() => validateFileChangeProposal({ changes: [{ operation: "create", path, content: "x" }] }), path);
  }
  assert.throws(() => validateFileChangeProposal({ changes: [
    { operation: "create", path: "same.txt", content: "a" },
    { operation: "create", path: "same.txt", content: "b" },
  ] }), /duplicate path/);
});

test("enforces file count and content size limits", () => {
  const tooMany = Array.from({ length: MAX_PROPOSAL_FILES + 1 }, (_, index) => ({
    operation: "create",
    path: `file-${index}.txt`,
    content: "",
  }));
  assert.throws(() => validateFileChangeProposal({ changes: tooMany }), /between 1 and/);
  assert.throws(() => validateFileChangeProposal({ changes: [
    { operation: "create", path: "large.txt", content: "x".repeat(MAX_FILE_CONTENT_BYTES + 1) },
  ] }), /per-file content limit/);
  assert.throws(() => validateFileChangeProposal({ changes: Array.from({ length: 5 }, (_, index) => ({
    operation: "create",
    path: `large-${index}.txt`,
    content: "x".repeat(MAX_FILE_CONTENT_BYTES),
  })) }), /total content limit/);
  assert.throws(() => validateFileChangeProposal({ changes: [{ operation: "create", path: "binary.txt", content: "a\0b" }] }), /without NUL/);
});

test("creates and replaces only regular text files", async () => {
  const workspace = makeWorkspace("apply-valid");
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "README.md"), "Before\n");
  const applier = new WorkspaceFileChangeApplier(workspace);

  await applier.apply({ changes: [
    { operation: "create", path: "src/new.ts", content: "export const x = 1;\n" },
    { operation: "replace", path: "README.md", content: "After\n" },
  ] });

  assert.equal(readFileSync(join(workspace, "src/new.ts"), "utf8"), "export const x = 1;\n");
  assert.equal(readFileSync(join(workspace, "README.md"), "utf8"), "After\n");
});

test("rejects symlinks escaping the workspace without writing outside", async () => {
  const workspace = makeWorkspace("apply-symlink");
  const external = mkdtempSync(join(tmpdir(), "agentforge-outside-"));
  const protectedFile = join(external, "protected.txt");
  writeFileSync(protectedFile, "unchanged");
  symlinkSync(external, join(workspace, "escape"), "dir");
  try {
    const applier = new WorkspaceFileChangeApplier(workspace);
    await assert.rejects(applier.apply({ changes: [{ operation: "create", path: "escape/protected.txt", content: "changed" }] }), /Symlinked parent/);
    assert.equal(readFileSync(protectedFile, "utf8"), "unchanged");
  } finally {
    rmSync(external, { recursive: true, force: true });
  }
});

test("rejects symlink targets and invalid create/replace preconditions", async () => {
  const workspace = makeWorkspace("apply-preconditions");
  writeFileSync(join(workspace, "exists.txt"), "old");
  symlinkSync(join(workspace, "exists.txt"), join(workspace, "link.txt"));
  const applier = new WorkspaceFileChangeApplier(workspace);

  await assert.rejects(applier.apply({ changes: [{ operation: "create", path: "exists.txt", content: "new" }] }), /existing file/);
  await assert.rejects(applier.apply({ changes: [{ operation: "replace", path: "missing.txt", content: "new" }] }), /missing file/);
  await assert.rejects(applier.apply({ changes: [{ operation: "replace", path: "link.txt", content: "new" }] }), /Symlink targets/);
  assert.equal(readFileSync(join(workspace, "exists.txt"), "utf8"), "old");
});
