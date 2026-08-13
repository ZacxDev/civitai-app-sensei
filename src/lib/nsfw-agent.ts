import type { ChatCompletionResponse } from './completion-types.js';
import type { OrchestratorAdapter } from './orchestrator.js';

const NSFW_MODEL = 'cognitivecomputations/dolphin-mistral-24b-venice-edition';

export interface NsfwDelegationRequest {
  task: string;
  context?: string;
  conversationHistory?: Array<{ role: string; content: string }>;
}

/**
 * Delegate a task to the NSFW agent.
 * Uses the uncensored model for mature content queries.
 */
export async function delegateToNsfwAgent(
  orchestrator: OrchestratorAdapter,
  request: NsfwDelegationRequest,
  onChunk?: (chunk: string) => void,
): Promise<ChatCompletionResponse> {
  const messages: Array<{ role: string; content: string }> = [
    {
      role: 'system',
      content: `You are a specialized NSFW/mature content assistant. You help with questions about mature AI art topics. Be informative and helpful while remaining respectful.`,
    },
    ...(request.context
      ? [{ role: 'user' as const, content: `Context from main conversation: ${request.context}` }]
      : []),
    { role: 'user', content: request.task },
  ];

  return orchestrator.submitChatCompletion({
    model: NSFW_MODEL,
    messages,
    temperature: 0.7,
    max_tokens: 1024,
  }, onChunk);
}

/**
 * Check if the NSFW model is available.
 */
export function isNsfwModelAvailable(): boolean {
  return true;
}

export { NSFW_MODEL };
