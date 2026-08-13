import type { ToolDefinition } from './completion-types.js';

export const CIVITAI_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'search_models',
      description: 'Search the Civitai model catalog for checkpoints, LoRAs, etc.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          type: {
            type: 'string',
            enum: ['Checkpoint', 'LORA', 'TextualInversion', 'Hypernetwork', 'AestheticGradient', 'Controlnet', 'Poses'],
            description: 'Filter by model type',
          },
          sort: {
            type: 'string',
            enum: ['Highest Rated', 'Most Downloaded', 'Newest'],
            description: 'Sort order',
          },
          limit: { type: 'integer', default: 10, description: 'Max results' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_model_details',
      description: 'Get detailed info about a specific model including versions, tags, and stats.',
      parameters: {
        type: 'object',
        properties: {
          modelId: { type: 'integer', description: 'The model ID' },
        },
        required: ['modelId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_images',
      description: 'Search generated images for inspiration and examples.',
      parameters: {
        type: 'object',
        properties: {
          modelId: { type: 'integer', description: 'Filter by model ID' },
          query: { type: 'string', description: 'Search query' },
          sort: {
            type: 'string',
            enum: ['Most Reactions', 'Most Comments', 'Newest'],
            description: 'Sort order',
          },
          limit: { type: 'integer', default: 5, description: 'Max results' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delegate_to_nsfw_agent',
      description: 'Delegate an NSFW/mature content task to the specialized uncensored agent.',
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The NSFW task description' },
          context: { type: 'string', description: 'Additional context from the main conversation' },
        },
        required: ['task'],
      },
    },
  },
];

/**
 * Parse tool call arguments from JSON string.
 */
export function parseToolArguments(argsJson: string): Record<string, unknown> {
  try {
    return JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Find a tool definition by name.
 */
export function findTool(name: string): ToolDefinition | undefined {
  return CIVITAI_TOOLS.find((t) => t.function.name === name);
}

/**
 * Get all tool names.
 */
export function toolNames(): string[] {
  return CIVITAI_TOOLS.map((t) => t.function.name);
}
