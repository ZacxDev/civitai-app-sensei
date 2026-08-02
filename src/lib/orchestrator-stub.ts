import type { ChatCompletionRequest, ChatCompletionResponse, ToolCall } from './completion-types.js';
import type { OrchestratorAdapter } from './orchestrator.js';
import { simulateStreaming } from './streaming.js';

export type { ChatCompletionRequest, ChatCompletionResponse, ToolCall } from './completion-types.js';

export const __STUB_ENABLED__ = true;

let callCount = 0;

function generateId(): string {
  callCount += 1;
  return `stub-${Date.now()}-${callCount}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

const STUB_RESPONSES: Record<string, string> = {
  search_models: JSON.stringify({
    items: [
      { id: 1234, name: 'Example Model', type: 'Checkpoint', stats: { downloads: 1000, rating: 4.5 } },
    ],
    nextCursor: null,
  }),
  get_model_details: JSON.stringify({
    id: 1234,
    name: 'Example Model',
    description: 'A detailed model description.',
    type: 'Checkpoint',
    tags: ['anime', 'realistic'],
    stats: { downloads: 1000, rating: 4.5, favorites: 100 },
    modelVersions: [{ id: 5678, name: 'v1.0', baseModel: 'SDXL 1.0' }],
  }),
  search_images: JSON.stringify({
    items: [
      { id: 9999, url: 'https://image.civitai.com/example.jpeg', width: 1024, height: 1024 },
    ],
  }),
  delegate_to_nsfw_agent: JSON.stringify({
    result: 'The NSFW agent has processed your request. [Simulated response]',
  }),
};

/**
 * Stub implementation of the orchestrator chat completion API.
 * Returns canned responses for testing; will be replaced with real bridge.
 */
export const submitChatCompletion: OrchestratorAdapter['submitChatCompletion'] = async (
  request: ChatCompletionRequest,
  onChunk?: (chunk: string) => void,
): Promise<ChatCompletionResponse> => {
  const lastMessage = request.messages[request.messages.length - 1];
  const isToolResult = lastMessage?.role === 'tool';

  let content: string;
  let toolCalls: ToolCall[] | undefined;

  if (isToolResult) {
    content = 'Based on the search results, here is what I found about your query. This is a stub response — the real orchestrator will provide actual AI-generated content.';
    toolCalls = undefined;
  } else if (request.tools && request.tools.length > 0) {
    const userMsg = request.messages.findLast((m: { role: string }) => m.role === 'user');
    const text = userMsg?.content?.toLowerCase() ?? '';

    if (text.includes('search') || text.includes('find') || text.includes('look for')) {
      toolCalls = [{
        id: generateId(),
        type: 'function',
        function: {
          name: 'search_models',
          arguments: JSON.stringify({ query: userMsg?.content ?? 'general', limit: 5 }),
        },
      }];
      content = '';
    } else {
      content = 'I can help you with that! You can ask me to search the Civitai catalog, look up model details, or find example images. This is a stub response — the real orchestrator will provide actual AI-generated content.';
      toolCalls = undefined;
    }
  } else {
    content = 'Hello! I am Civitai Sensei, your AI research assistant. Ask me about AI models, checkpoints, LoRAs, or anything related to AI art generation. This is a stub response — the real orchestrator will provide actual AI-generated content.';
    toolCalls = undefined;
  }

  if (onChunk && content) {
    await simulateStreaming(content, onChunk);
  }

  const promptTokens = request.messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const completionTokens = estimateTokens(content);

  return {
    id: generateId(),
    choices: [{
      index: 0,
      message: { role: 'assistant', content, tool_calls: toolCalls },
      finish_reason: toolCalls ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
};

/** Reset the stub's call counter (for tests). */
export function resetStubCounter(): void {
  callCount = 0;
}

/** Directly get a canned tool result (for tests). */
export function getStubToolResult(toolName: string): string | undefined {
  return STUB_RESPONSES[toolName];
}
