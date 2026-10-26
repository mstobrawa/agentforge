import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OpenAIAgentAdapter, type OpenAIAgentTransport } from "../src/openai-agent-adapter.js";

test("provides explicit workspace context and applies only the validated proposal", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "agentforge-context-flow-"));
  writeFileSync(join(workspace, "input.ts"), "export const value = 1;\n");
  writeFileSync(join(workspace, "unlisted.txt"), "not sent to the agent\n");
  let received: unknown;
  const transport: OpenAIAgentTransport = {
    async proposeFileChanges(input) {
      received = input;
      return {
        changes: [
          { operation: "replace", path: "input.ts", content: "export const value = 2;\n" },
          { operation: "create", path: "result.txt", content: "done\n" },
        ],
      };
    },
  };

  try {
    const agent = new OpenAIAgentAdapter(workspace, transport, ["input.ts"]);
    await agent.implement("Update the value");

    assert.deepEqual(received, {
      task: "Update the value",
      context: {
        files: [{ path: "input.ts", content: "export const value = 1;\n" }],
        totalBytes: Buffer.byteLength("export const value = 1;\n", "utf8"),
      },
    });
    assert.equal(readFileSync(join(workspace, "input.ts"), "utf8"), "export const value = 2;\n");
    assert.equal(readFileSync(join(workspace, "result.txt"), "utf8"), "done\n");
    assert.equal(readFileSync(join(workspace, "unlisted.txt"), "utf8"), "not sent to the agent\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
