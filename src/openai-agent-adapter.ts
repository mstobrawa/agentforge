import { WorkspaceFileChangeApplier } from "./file-changes.js";
import { buildWorkspaceContext, type WorkspaceContext } from "./workspace-context.js";
import type { AgentAdapter } from "./types.js";

export interface OpenAIAgentTransport {
  proposeFileChanges(input: { task: string; context: WorkspaceContext; previousFailure?: string }): Promise<unknown>;
}

/**
 * Minimal injected-transport adapter. This module performs no network calls;
 * proposals are validated and applied only inside its configured workspace.
 */
export class OpenAIAgentAdapter implements AgentAdapter {
  private readonly applier: WorkspaceFileChangeApplier;

  constructor(
    private readonly workspacePath: string,
    private readonly transport: OpenAIAgentTransport,
    private readonly contextPaths: readonly string[],
  ) {
    this.applier = new WorkspaceFileChangeApplier(workspacePath);
  }

  async implement(task: string, previousFailure?: string): Promise<void> {
    const context = await buildWorkspaceContext(this.workspacePath, this.contextPaths);
    const proposal = await this.transport.proposeFileChanges({
      task,
      context,
      ...(previousFailure !== undefined ? { previousFailure } : {}),
    });
    await this.applier.apply(proposal);
  }
}
