import { describe, it, expectTypeOf } from 'vitest';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ToolDefinition,
  ToolCall,
} from './completion-types.js';

describe('completion-types', () => {
  it('ChatCompletionRequest is exported', () => {
    expectTypeOf<ChatCompletionRequest>().toMatchTypeOf<{
      model: string;
      messages: Array<{ role: string; content: string; tool_call_id?: string }>;
    }>();
  });

  it('ChatCompletionResponse is exported', () => {
    expectTypeOf<ChatCompletionResponse>().toMatchTypeOf<{
      id: string;
      choices: Array<{
        index: number;
        message: { role: string; content: string };
        finish_reason: string;
      }>;
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    }>();
  });

  it('ToolDefinition is exported', () => {
    expectTypeOf<ToolDefinition>().toMatchTypeOf<{
      type: 'function';
      function: { name: string; description: string; parameters: Record<string, unknown> };
    }>();
  });

  it('ToolCall is exported', () => {
    expectTypeOf<ToolCall>().toMatchTypeOf<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>();
  });
});
