import type { ChatCompletionRequest, ChatCompletionResponse } from './completion-types.js';
import { submitChatCompletion as stubSubmit } from './orchestrator-stub.js';

export interface OrchestratorAdapter {
  submitChatCompletion(
    request: ChatCompletionRequest,
    onChunk?: (chunk: string) => void,
  ): Promise<ChatCompletionResponse>;
}

export function createOrchestrator(): OrchestratorAdapter {
  return { submitChatCompletion: stubSubmit };
}
