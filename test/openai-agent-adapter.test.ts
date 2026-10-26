import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIAgentAdapter, type OpenAIAgentTransport } from "../src/openai-agent-adapter.js";

test("passes task and previous failure to injected transport and applies its validated proposal", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agentforge-agent-adapter-"));
  writeFileSync(join(workspace, "input.txt"), "existing context\n");
  const requests: { task: string; context: { files: readonly { path: string; content: string }[]; totalBytes: number }; previousFailure?: string }[] = [];
  const transport: OpenAIAgentTransport = {
    async proposeFileChanges(input) {
      requests.push(input);
      return { changes: [{ operation: "create", path: "answer.txt", content: "proposal applied\n" }] };
    },
  };

  try {
    const adapter = new OpenAIAgentAdapter(workspace, transport, ["input.txt"]);
    await adapter.implement("Add a file", "Previous check failed");
    assert.deepEqual(requests, [{
      task: "Add a file",
      context: {
        files: [{ path: "input.txt", content: "existing context\n" }],
        totalBytes: Buffer.byteLength("existing context\n", "utf8"),
      },
      previousFailure: "Previous check failed",
    }]);
    assert.equal(readFileSync(join(workspace, "answer.txt"), "utf8"), "proposal applied\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects an unsafe transport proposal without writing outside the workspace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agentforge-agent-invalid-"));
  const transport: OpenAIAgentTransport = {
    async proposeFileChanges() {
      return { changes: [{ operation: "create", path: "../outside.txt", content: "unsafe" }] };
    },
  };
  try {
    const adapter = new OpenAIAgentAdapter(workspace, transport, ["input.txt"]);
    await assert.rejects(adapter.implement("task"));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
