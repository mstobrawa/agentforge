import OpenAI from "openai";
import {
  OpenAIAgentAdapter,
  type OpenAIAgentTransport,
} from "./openai-agent-adapter.js";
import type { AgentAdapter } from "./types.js";

const proposalSchema = {
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
} as const;

/** Uses the official Responses API client and returns parsed proposal data. */
export class OpenAIResponsesTransport implements OpenAIAgentTransport {
  constructor(
    private readonly client: Pick<OpenAI, "responses">,
    private readonly model: string,
  ) {}

  async proposeFileChanges(
    input: Parameters<OpenAIAgentTransport["proposeFileChanges"]>[0],
  ): Promise<unknown> {
    let output: string;
    try {
      const response = await this.client.responses.create({
        model: this.model,
        instructions: [
          "Return a JSON file change proposal matching the required schema.",
          "Use only create or replace operations and normalized workspace-relative paths.",
          "Complete the requested task using the provided workspace context.",
          "If previousFailure is provided, treat it as feedback from the previous verification attempt, identify the cause, and propose a correction.",
          "Do not claim that verification passed; return only the proposed file changes.",
        ].join(" "),
        input: JSON.stringify(input),
        text: {
          format: {
            type: "json_schema",
            name: "file_change_proposal",
            strict: true,
            schema: proposalSchema,
          },
        },
      });
      output = response.output_text;
    } catch {
      throw new Error("OpenAI API request failed.");
    }

    try {
      return JSON.parse(output) as unknown;
    } catch {
      throw new Error("OpenAI returned an invalid file change proposal.");
    }
  }
}

/** Creates the real API transport using only the documented environment variables. */
export function createOpenAITransport(
  environment: NodeJS.ProcessEnv = process.env,
  client?: Pick<OpenAI, "responses">,
): OpenAIResponsesTransport {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  if (!apiKey)
    throw new Error("OPENAI_API_KEY is required to use the OpenAI API.");
  const model = environment.OPENAI_MODEL?.trim();
  if (!model)
    throw new Error("OPENAI_MODEL is required to use the OpenAI API.");

  return new OpenAIResponsesTransport(client ?? new OpenAI({ apiKey }), model);
}

export function createOpenAIAgentAdapter(
  workspacePath: string,
  contextPaths: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
  client?: Pick<OpenAI, "responses">,
): AgentAdapter {
  return new OpenAIAgentAdapter(
    workspacePath,
    createOpenAITransport(environment, client),
    contextPaths,
  );
}
