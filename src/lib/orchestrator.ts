import type { ChatCompletionRequest, ChatCompletionResponse } from './completion-types.js';
import { submitChatCompletion as stubSubmit } from './orchestrator-stub.js';
import { createBridgeAdapter, type WorkflowHelpers } from './orchestrator-bridge.js';

export interface OrchestratorAdapter {
  submitChatCompletion(
    request: ChatCompletionRequest,
    onChunk?: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<ChatCompletionResponse>;
  cancel?(workflowId?: string): Promise<void>;
}

let _bridgeMode = false;

/** Returns true when the orchestrator is using real workflow helpers (bridge mode). */
export function isBridgeMode(): boolean {
  return _bridgeMode;
}

/**
 * Create an orchestrator adapter.
 * When workflow helpers are provided, uses the real bridge (estimate → submit → poll).
 * Otherwise falls back to the stub.
 */
export function createOrchestrator(workflow?: WorkflowHelpers): OrchestratorAdapter {
  if (workflow) {
    _bridgeMode = true;
    return createBridgeAdapter(workflow);
  }
  _bridgeMode = false;
  return {
    submitChatCompletion: async (request, onChunk, _signal) => {
      // Stub ignores signal — it's synchronous
      return stubSubmit(request, onChunk);
    },
    cancel: async () => {},
  };
}
