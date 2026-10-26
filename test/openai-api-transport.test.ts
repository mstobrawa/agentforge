import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type OpenAI from "openai";
import test from "node:test";
import { createOpenAIAgentAdapter, createOpenAITransport, OpenAIResponsesTransport } from "../src/openai-api-transport.js";

test("requires OPENAI_API_KEY and OPENAI_MODEL without exposing configuration values", () => {
  assert.throws(() => createOpenAITransport({}), /OPENAI_API_KEY is required/);
  assert.throws(
    () => createOpenAITransport({ OPENAI_API_KEY: "test-only-key" }),
    /OPENAI_MODEL is required/,
  );
});

test("sends task and context through the Responses API and parses the proposal", async () => {
  let request: unknown;
  const expected = { changes: [{ operation: "create", path: "answer.txt", content: "ok" }] };
  const client = {
    responses: {
      async create(input: unknown) {
        request = input;
        return { output_text: JSON.stringify(expected) };
      },
    },
  } as unknown as Pick<OpenAI, "responses">;

  const transport = new OpenAIResponsesTransport(client, "model-from-test-env");
  const result = await transport.proposeFileChanges({
    task: "Add answer",
    context: { files: [{ path: "input.txt", content: "source" }], totalBytes: 6 },
  });

  assert.deepEqual(result, expected);
  assert.deepEqual(request, {
    model: "model-from-test-env",
    instructions: "Return a JSON file change proposal matching the required schema. Use only create or replace operations and normalized workspace-relative paths.",
    input: JSON.stringify({
      task: "Add answer",
      context: { files: [{ path: "input.txt", content: "source" }], totalBytes: 6 },
    }),
    text: {
      format: {
        type: "json_schema",
        name: "file_change_proposal",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            changes: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  operation: { type: "string", enum: ["create", "replace"] },
                  path: { type: "string" },
                  content: { type: "string" },
                },
                required: ["operation", "path", "content"],
              },
            },
          },
          required: ["changes"],
        },
      },
    },
  });
});

test("returns concise errors for API and malformed JSON failures", async () => {
  const failingClient = {
    responses: { async create() { throw new Error("secret-bearing provider detail"); } },
  } as unknown as Pick<OpenAI, "responses">;
  const apiTransport = new OpenAIResponsesTransport(failingClient, "test-model");
  await assert.rejects(
    apiTransport.proposeFileChanges({ task: "task", context: { files: [], totalBytes: 0 } }),
    (error: Error) => error.message === "OpenAI API request failed." && !error.message.includes("secret-bearing"),
  );

  const malformedClient = {
    responses: { async create() { return { output_text: "not JSON" }; } },
  } as unknown as Pick<OpenAI, "responses">;
  const malformedTransport = new OpenAIResponsesTransport(malformedClient, "test-model");
  await assert.rejects(
    malformedTransport.proposeFileChanges({ task: "task", context: { files: [], totalBytes: 0 } }),
    /invalid file change proposal/,
  );
});

test("factory adapter uses the OpenAI transport and applies only validated proposals", async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "agentforge-openai-factory-"));
  const workspace = join(temporaryRoot, "workspace");
  mkdirSync(workspace);
  writeFileSync(join(workspace, "input.txt"), "before\n");
  const requests: unknown[] = [];
  let callCount = 0;
  const client = {
    responses: {
      async create(request: unknown) {
        requests.push(request);
        callCount += 1;
        const proposal = callCount === 1
          ? { changes: [{ operation: "replace", path: "input.txt", content: "after\n" }] }
          : { changes: [{ operation: "create", path: "../outside.txt", content: "unsafe" }] };
        return { output_text: JSON.stringify(proposal) };
      },
    },
  } as unknown as Pick<OpenAI, "responses">;

  try {
    const adapter = createOpenAIAgentAdapter(
      workspace,
      ["input.txt"],
      { OPENAI_API_KEY: "test-only-key", OPENAI_MODEL: "stub-model" },
      client,
    );
    await adapter.implement("Update this file");
    assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), "after\n");

    const request = requests[0] as { model: string; input: string };
    assert.equal(request.model, "stub-model");
    assert.match(request.input, /Update this file/);
    assert.match(request.input, /before\\n/);

    await assert.rejects(adapter.implement("Try an unsafe path"), /normalized relative path/);
    assert.equal(readFileSync(join(workspace, "input.txt"), "utf8"), "after\n");
    assert.throws(() => readFileSync(join(temporaryRoot, "outside.txt"), "utf8"), { code: "ENOENT" });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
