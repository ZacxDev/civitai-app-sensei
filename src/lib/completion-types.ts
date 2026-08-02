export interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string; tool_call_id?: string }>;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: string;
  response_format?: { type: string };
}

export interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string; tool_calls?: ToolCall[] };
    finish_reason: string;
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
