export interface ModelConfig {
  id: string;
  name: string;
  provider: string;
  supportsTools: boolean;
  supportsStreaming: boolean;
  costPer1kInput: number;
  costPer1kOutput: number;
  maxContext: number;
}

export const AVAILABLE_MODELS: ModelConfig[] = [
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek V3',
    provider: 'DeepSeek',
    supportsTools: true,
    supportsStreaming: true,
    costPer1kInput: 0.00014,
    costPer1kOutput: 0.00028,
    maxContext: 64000,
  },
  {
    id: 'deepseek/deepseek-r1',
    name: 'DeepSeek R1',
    provider: 'DeepSeek',
    supportsTools: false,
    supportsStreaming: true,
    costPer1kInput: 0.00014,
    costPer1kOutput: 0.00028,
    maxContext: 64000,
  },
  {
    id: 'google/gemini-2.0-flash',
    name: 'Gemini 2.0 Flash',
    provider: 'Google',
    supportsTools: true,
    supportsStreaming: true,
    costPer1kInput: 0.0001,
    costPer1kOutput: 0.0004,
    maxContext: 1048576,
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    supportsTools: true,
    supportsStreaming: true,
    costPer1kInput: 0.003,
    costPer1kOutput: 0.0015,
    maxContext: 200000,
  },
];

export function getModelById(id: string): ModelConfig | undefined {
  return AVAILABLE_MODELS.find((m) => m.id === id);
}

export function estimateCost(
  model: ModelConfig,
  promptTokens: number,
  completionTokens: number,
): number {
  return (
    (promptTokens / 1000) * model.costPer1kInput +
    (completionTokens / 1000) * model.costPer1kOutput
  );
}

export function formatCost(usd: number): string {
  if (usd < 0.001) return '<$0.001';
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
