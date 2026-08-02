import type { ChatCompletionRequest, ChatCompletionResponse } from './completion-types.js';
import { submitChatCompletion as stubSubmit } from './orchestrator-stub.js';
import { createBridgeAdapter, type WorkflowHelpers } from './orchestrator-bridge.js';

export interface OrchestratorAdapter {
  submitChatCompletion(
    request: ChatCompletionRequest,
    onChunk?: (chunk: string) => void,
  ): Promise<ChatCompletionResponse>;
}

/**
 * Create an orchestrator adapter.
 * When workflow helpers are provided, uses the real bridge (estimate → submit → poll).
 * Otherwise falls back to the stub.
 */
export function createOrchestrator(workflow?: WorkflowHelpers): OrchestratorAdapter {
  if (workflow) {
    return createBridgeAdapter(workflow);
  }
  return { submitChatCompletion: stubSubmit };
}
